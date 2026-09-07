#!/usr/bin/env python3
"""Build mobile-friendly static route data from the national SQLite output.

The national collector remains the source of truth. This step deliberately does
not ship the 800+ MB working SQLite database to the browser: stops are spatially
chunked and route geometry is split into small gzip-compressed route chunks.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import json
import re
import sqlite3
import subprocess
import sys
import zipfile
from collections import defaultdict
from pathlib import Path


TILE_SIZE_LON = 0.125
TILE_SIZE_LAT = 0.0625
ROUTE_CHUNKS = 256
CLASSIFICATION_VERSION = "gtfs-route-type-and-calendar-v1"
SCHOOL_ROUTE_TYPES = {"707", "708", "709", "712"}
COACH_ROUTE_TYPES = {str(value) for value in range(200, 210)}
METRO_ROUTE_TYPES = {"1", *{str(value) for value in range(400, 406)}}
SCHOOL_TEXT = re.compile(
    r"\b(school|schools|scholar|scholars|pupil|pupils|closed[ -]?door|"
    r"staff only|not (?:for|available to) (?:the )?public|private service)\b",
    re.IGNORECASE,
)
METRO_OPERATOR_TEXT = re.compile(
    r"\b(underground|subway|metro|docklands light railway)\b",
    re.IGNORECASE,
)


def write_gzip_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(encoded, compresslevel=9, mtime=0)
    if path.exists() and path.read_bytes() == compressed:
        return
    path.write_bytes(compressed)


def spatial_key(latitude: float, longitude: float) -> int:
    """Return a Morton key so geographically close routes share a shard."""

    latitude_value = max(0, min(65535, int((latitude - 49) / 12 * 65535)))
    longitude_value = max(0, min(65535, int((longitude + 9) / 12 * 65535)))

    def spread_bits(value: int) -> int:
        value = (value | (value << 8)) & 0x00FF00FF
        value = (value | (value << 4)) & 0x0F0F0F0F
        value = (value | (value << 2)) & 0x33333333
        return (value | (value << 1)) & 0x55555555

    return spread_bits(longitude_value) | (spread_bits(latitude_value) << 1)


def clear_generated_json(directory: Path) -> None:
    if directory.exists():
        for path in directory.glob("*.json.gz"):
            path.unlink()


def tile_key(latitude: float, longitude: float) -> str:
    return f"{int((latitude + 90) // TILE_SIZE_LAT)}_{int((longitude + 180) // TILE_SIZE_LON)}"


def load_services(path: Path) -> dict[str, dict]:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        services = json.load(source)
    return {service["route_id"]: service for service in services}


def gtfs_rows(archive: zipfile.ZipFile, name: str):
    with archive.open(name) as raw:
        lines = (line.decode("utf-8-sig") for line in raw)
        yield from csv.DictReader(lines)


def parse_gtfs_date(value: str) -> dt.date:
    return dt.datetime.strptime(value, "%Y%m%d").date()


def scheduled_weekdays(start: dt.date, end: dt.date, active_days: list[bool]) -> int:
    full_weeks, remainder = divmod((end - start).days + 1, 7)
    count = full_weeks * sum(active_days)
    for offset in range(remainder):
        if active_days[(start.weekday() + offset) % 7]:
            count += 1
    return count


def load_gtfs_metadata(source_root: Path) -> tuple[dict[str, str], set[str], dict]:
    """Read the fields the national normaliser does not currently publish.

    GTFS route_type is authoritative for coach/metro modes. The aggregate does
    not expose a public-access flag, so school/restricted detection is kept
    conservative: explicit wording, or a route whose every trip belongs to a
    weekday-only calendar with a material school-holiday gap.
    """

    gtfs_path = source_root / "cache" / "itm_all_gtfs.zip"
    if not gtfs_path.exists():
        print(f"Warning: {gtfs_path} is missing; route classifications will use names only")
        return {}, set(), {"c": {}, "r": {}}

    with zipfile.ZipFile(gtfs_path) as archive:
        route_types = {
            row["route_id"]: (row.get("route_type") or "").strip()
            for row in gtfs_rows(archive, "routes.txt")
        }
        calendars = {row["service_id"]: row for row in gtfs_rows(archive, "calendar.txt")}
        added_dates: dict[str, set[str]] = defaultdict(set)
        removed_dates: dict[str, set[str]] = defaultdict(set)
        for row in gtfs_rows(archive, "calendar_dates.txt"):
            destination = added_dates if row.get("exception_type") == "1" else removed_dates
            destination[row["service_id"]].add(row["date"])

        school_like_services = set()
        day_names = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
        for service_id, calendar in calendars.items():
            active_days = [calendar.get(name) == "1" for name in day_names]
            if sum(active_days[:5]) < 4 or any(active_days[5:]):
                continue
            start = parse_gtfs_date(calendar["start_date"])
            end = parse_gtfs_date(calendar["end_date"])
            if (end - start).days < 120:
                continue
            baseline = scheduled_weekdays(start, end, active_days)
            removed = sum(
                active_days[date.weekday()]
                for date in (parse_gtfs_date(value) for value in removed_dates[service_id])
                if start <= date <= end
            )
            if removed >= 15 and baseline and removed / baseline >= 0.08:
                school_like_services.add(service_id)

        route_services: dict[str, set[str]] = defaultdict(set)
        for row in gtfs_rows(archive, "trips.txt"):
            route_services[row["route_id"]].add(row["service_id"])

    school_calendar_routes = {
        route_id
        for route_id, service_ids in route_services.items()
        if service_ids and service_ids <= school_like_services
    }
    day_names = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    calendar_index = {
        service_id: [
            sum((calendar.get(day) == "1") << index for index, day in enumerate(day_names)),
            calendar.get("start_date") or "",
            calendar.get("end_date") or "",
            sorted(added_dates[service_id]),
            sorted(removed_dates[service_id]),
        ]
        for service_id, calendar in calendars.items()
    }
    for service_id in (added_dates.keys() | removed_dates.keys()) - calendar_index.keys():
        calendar_index[service_id] = [0, "", "", sorted(added_dates[service_id]), sorted(removed_dates[service_id])]
    route_calendar = {
        "c": calendar_index,
        "r": {route_id: sorted(service_ids) for route_id, service_ids in route_services.items()},
    }
    return route_types, school_calendar_routes, route_calendar


def classify_route(route_id: str, service: dict, route_type: str, school_calendar_routes: set[str]) -> list[str]:
    categories = []
    operator = service.get("operator_name") or ""
    route_text = " ".join(
        str(value or "")
        for value in (service.get("route_short_name"), service.get("route_long_name"), operator)
    )
    if route_type in SCHOOL_ROUTE_TYPES or route_id in school_calendar_routes or SCHOOL_TEXT.search(route_text):
        categories.append("school_restricted")
    if route_type in METRO_ROUTE_TYPES or METRO_OPERATOR_TEXT.search(operator):
        categories.append("metro")
    if route_type in COACH_ROUTE_TYPES:
        categories.append("coach")
    return categories


def ensure_national_output(source_root: Path, run_national: bool, osrm_url: str) -> None:
    database = source_root / "work" / "national" / "national.sqlite"
    services = source_root / "output_national" / "services.json.gz"
    if database.exists() and services.exists():
        return
    if not run_national:
        raise SystemExit(
            f"National output is missing under {source_root}. "
            "Run with --run-national to collect and process the BODS GTFS aggregate."
        )
    command = [sys.executable, str(source_root / "run_national.py")]
    if osrm_url:
        command.extend(["--osrm-url", osrm_url])
    else:
        command.extend(["--osrm-url", ""])
    subprocess.run(command, cwd=source_root, check=True)


def build(source_root: Path, destination: Path) -> None:
    database_path = source_root / "work" / "national" / "national.sqlite"
    services_path = source_root / "output_national" / "services.json.gz"
    services = load_services(services_path)
    route_types, school_calendar_routes, route_calendar = load_gtfs_metadata(source_root)
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row

    stop_routes: dict[str, list[str]] = defaultdict(list)
    for row in connection.execute(
        "SELECT stop_id, route_id FROM route_stops GROUP BY stop_id, route_id ORDER BY stop_id, route_id"
    ):
        stop_routes[row["stop_id"]].append(row["route_id"])

    stop_tiles: dict[str, list[dict]] = defaultdict(list)
    stop_count = 0
    for row in connection.execute(
        "SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops "
        "WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL ORDER BY stop_id"
    ):
        routes = stop_routes.get(row["stop_id"], [])
        if not routes:
            continue
        stop_tiles[tile_key(row["stop_lat"], row["stop_lon"])].append(
            {
                "id": row["stop_id"],
                "name": row["stop_name"] or "Unnamed stop",
                "lat": row["stop_lat"],
                "lon": row["stop_lon"],
                "route_ids": routes,
            }
        )
        stop_count += 1

    stops_destination = destination / "stops"
    clear_generated_json(stops_destination)
    for key, stops in sorted(stop_tiles.items()):
        write_gzip_json(stops_destination / f"{key}.json.gz", {"stops": stops})

    route_anchors = {
        row["route_id"]: (row["anchor_lat"], row["anchor_lon"])
        for row in connection.execute(
            """SELECT rs.route_id,
                      (MIN(s.stop_lat) + MAX(s.stop_lat)) / 2 AS anchor_lat,
                      (MIN(s.stop_lon) + MAX(s.stop_lon)) / 2 AS anchor_lon
                 FROM route_stops rs JOIN stops s ON s.stop_id = rs.stop_id
                WHERE s.stop_lat IS NOT NULL AND s.stop_lon IS NOT NULL
                GROUP BY rs.route_id"""
        )
    }
    route_ids = sorted(
        services,
        key=lambda route_id: (
            spatial_key(*route_anchors.get(route_id, (99, 99))),
            route_id,
        ),
    )
    routes_by_chunk: dict[str, dict[str, dict]] = defaultdict(dict)
    route_chunks: dict[str, str] = {}
    for index, route_id in enumerate(route_ids):
        service = services[route_id]
        route_type = route_types.get(route_id, "")
        chunk_number = index * ROUTE_CHUNKS // len(route_ids)
        chunk_name = f"chunk-{chunk_number:03d}.json.gz"
        route_chunks[route_id] = chunk_name
        routes_by_chunk[chunk_name][route_id] = {
            "route_id": route_id,
            "route_short_name": service.get("route_short_name"),
            "route_long_name": service.get("route_long_name"),
            "operator_name": service.get("operator_name") or "Unknown operator",
            "operator_noc": service.get("operator_noc"),
            "route_type": route_type or None,
            "categories": classify_route(route_id, service, route_type, school_calendar_routes),
            "headsigns": sorted(
                {shape.get("headsign", "").strip() for shape in service.get("shapes", []) if shape.get("headsign", "").strip()}
            ),
            "geometry_sources": sorted({shape.get("geometry_source") for shape in service.get("shapes", [])}),
            "shapes": [],
        }

    route_details_by_chunk: dict[str, dict[str, dict]] = defaultdict(dict)
    shape_ids_by_chunk: dict[str, set[str]] = defaultdict(set)
    for route_id, service in services.items():
        chunk_name = route_chunks[route_id]
        for shape in service.get("shapes", []):
            shape_ids_by_chunk[chunk_name].add(shape["shape_id"])

    for chunk_name, shape_ids in sorted(shape_ids_by_chunk.items()):
        chunk_route_ids = sorted(routes_by_chunk[chunk_name])
        patterns_by_route: dict[str, dict[tuple[str, str], list[dict]]] = defaultdict(lambda: defaultdict(list))
        for start in range(0, len(chunk_route_ids), 300):
            route_batch = chunk_route_ids[start : start + 300]
            route_placeholders = ",".join("?" for _ in route_batch)
            for row in connection.execute(
                f"""SELECT rs.route_id, rs.direction_id, rs.headsign, rs.stop_id,
                                  rs.stop_sequence, s.stop_name, s.stop_lat, s.stop_lon
                           FROM route_stops rs JOIN stops s ON s.stop_id = rs.stop_id
                          WHERE rs.route_id IN ({route_placeholders})
                          ORDER BY rs.route_id, rs.direction_id, rs.headsign,
                                   rs.stop_sequence, rs.stop_id""",
                route_batch,
            ):
                pattern_key = (str(row["direction_id"] or ""), row["headsign"] or "")
                patterns_by_route[row["route_id"]][pattern_key].append(
                    {
                        "id": row["stop_id"],
                        "name": row["stop_name"] or "Unnamed stop",
                        "lat": row["stop_lat"],
                        "lon": row["stop_lon"],
                        "sequence": row["stop_sequence"],
                    }
                )
        for route_id in chunk_route_ids:
            patterns = patterns_by_route.get(route_id, {})
            route_details_by_chunk[chunk_name][route_id] = {
                "stop_patterns": [
                    {
                        "direction_id": direction_id or None,
                        "headsign": headsign,
                        "stops": stops,
                    }
                    for (direction_id, headsign), stops in sorted(patterns.items())
                ],
                "stop_count": len({stop["id"] for stops in patterns.values() for stop in stops}),
            }

        shape_rows: dict[str, sqlite3.Row] = {}
        ids = sorted(shape_ids)
        for start in range(0, len(ids), 500):
            batch = ids[start : start + 500]
            placeholders = ",".join("?" for _ in batch)
            for row in connection.execute(
                f"SELECT shape_id, source, geometry_100m FROM shapes WHERE shape_id IN ({placeholders})",
                batch,
            ):
                shape_rows[row["shape_id"]] = row
        for route_id in chunk_route_ids:
            service = services[route_id]
            for shape in service.get("shapes", []):
                row = shape_rows.get(shape["shape_id"])
                if not row or not row["geometry_100m"]:
                    continue
                coordinates = [line for line in json.loads(row["geometry_100m"]) if len(line) >= 2]
                if not coordinates:
                    continue
                routes_by_chunk[chunk_name][route_id]["shapes"].append(
                    {
                        "shape_id": shape["shape_id"],
                        "direction_id": shape.get("direction_id"),
                        "headsign": shape.get("headsign"),
                        "source": row["source"],
                        "coordinates": coordinates,
                    }
                )

    routes_destination = destination / "routes"
    details_destination = destination / "route_details"
    clear_generated_json(routes_destination)
    clear_generated_json(details_destination)
    for chunk_name, routes in sorted(routes_by_chunk.items()):
        write_gzip_json(routes_destination / chunk_name, {"routes": routes})
        write_gzip_json(details_destination / chunk_name, {"routes": route_details_by_chunk[chunk_name]})

    # Keeping the ordered IDs in one small lazy-loaded file is substantially
    # smaller than a JSON route-to-chunk dictionary. The browser reconstructs
    # the chunk number from the array position using the same formula above.
    write_gzip_json(destination / "route-index.json.gz", {"route_ids": route_ids})
    write_gzip_json(destination / "route-calendar.json.gz", route_calendar)

    category_counts = defaultdict(int)
    for routes in routes_by_chunk.values():
        for route in routes.values():
            for category in route["categories"]:
                category_counts[category] += 1

    calendar_dates = [
        value
        for calendar in route_calendar["c"].values()
        for value in (calendar[1:3] + calendar[3] + calendar[4])
        if value
    ]
    manifest = {
        "schema_version": 4,
        "generated_from": str(source_root),
        "geometry_tolerance_metres": 100,
        "tile_size_lon": TILE_SIZE_LON,
        "tile_size_lat": TILE_SIZE_LAT,
        "stop_count": stop_count,
        "route_count": len(route_ids),
        "stop_tiles": sorted(stop_tiles),
        "route_chunk_count": ROUTE_CHUNKS,
        "route_chunk_width": 3,
        "route_chunk_strategy": "spatial-morton-v1",
        "route_index": "route-index.json.gz",
        "route_details_directory": "route_details",
        "route_calendar": {
            "path": "route-calendar.json.gz",
            "start_date": min(calendar_dates, default=None),
            "end_date": max(calendar_dates, default=None),
        },
        "route_classification": {
            "version": CLASSIFICATION_VERSION,
            "counts": dict(sorted(category_counts.items())),
        },
    }
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    connection.close()
    print(f"Wrote {stop_count:,} stops in {len(stop_tiles):,} tiles")
    print(f"Wrote {len(route_ids):,} routes in {len(routes_by_chunk):,} gzip chunks")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build static mobile bus route data")
    parser.add_argument("--source-root", type=Path, default=Path("../bus_processing_new"))
    parser.add_argument("--destination", type=Path, default=Path("public/data"))
    parser.add_argument("--run-national", action="store_true", help="Run the existing national BODS pipeline when output is absent")
    parser.add_argument("--osrm-url", default="http://127.0.0.1:5001")
    args = parser.parse_args()
    ensure_national_output(args.source_root, args.run_national, args.osrm_url)
    build(args.source_root, args.destination)


if __name__ == "__main__":
    main()
