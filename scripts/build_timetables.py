#!/usr/bin/env python3
"""Build compact, browser-queryable timetable shards from the national GTFS.

The source ``stop_times.txt`` is deliberately never extracted.  It is streamed
from the ZIP one trip at a time and reduced to four reusable pieces:

* a stop pattern (stop IDs plus pickup/drop-off rules),
* a relative arrival/departure timing profile,
* trip metadata (route, service calendar, destination and accessibility), and
* a delta-encoded list of times at which that combination starts.

The output uses the same 256 spatial route shards as the map.  A client that has
already found nearby routes therefore only downloads timetable shards for those
routes, rather than a national departures table.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import struct
import time
import zipfile
from collections import defaultdict
from pathlib import Path


MAGIC = b"BTT1"
FORMAT_VERSION = 1


def unsigned_varint(value: int) -> bytes:
    if value < 0:
        raise ValueError(f"unsigned varint cannot encode {value}")
    encoded = bytearray()
    while value >= 0x80:
        encoded.append((value & 0x7F) | 0x80)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def signed_varint(value: int) -> bytes:
    return unsigned_varint((value << 1) ^ (value >> 63))


def read_unsigned_varint(payload: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while True:
        byte = payload[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
        if shift > 63:
            raise ValueError("invalid varint")


def parse_time(value: str) -> int:
    hours, minutes, seconds = value.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds)


def front_coded_strings(values: list[str]) -> bytes:
    """Encode sorted strings using their common prefix with the previous item."""

    payload = bytearray(unsigned_varint(len(values)))
    previous = ""
    for value in values:
        common = 0
        maximum = min(len(previous), len(value))
        while common < maximum and previous[common] == value[common]:
            common += 1
        suffix = value[common:].encode("utf-8")
        payload += unsigned_varint(common)
        payload += unsigned_varint(len(suffix))
        payload += suffix
        previous = value
    return bytes(payload)


def read_front_coded_strings(payload: bytes, offset: int) -> tuple[list[str], int]:
    count, offset = read_unsigned_varint(payload, offset)
    values: list[str] = []
    previous = ""
    for _ in range(count):
        common, offset = read_unsigned_varint(payload, offset)
        length, offset = read_unsigned_varint(payload, offset)
        value = previous[:common] + payload[offset : offset + length].decode("utf-8")
        offset += length
        values.append(value)
        previous = value
    return values, offset


def gzip_bytes(payload: bytes) -> bytes:
    return gzip.compress(payload, compresslevel=9, mtime=0)


def load_route_chunks(data_root: Path) -> tuple[dict[str, int], int]:
    manifest = json.loads((data_root / "manifest.json").read_text(encoding="utf-8"))
    with gzip.open(data_root / manifest["route_index"], "rt", encoding="utf-8") as source:
        route_ids = json.load(source)["route_ids"]
    chunk_count = manifest["route_chunk_count"]
    return {
        route_id: index * chunk_count // len(route_ids)
        for index, route_id in enumerate(route_ids)
    }, chunk_count


def gtfs_reader(archive: zipfile.ZipFile, name: str):
    raw = archive.open(name)
    text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
    return raw, text, csv.reader(text)


def load_frequency_starts(archive: zipfile.ZipFile) -> dict[str, dict[bool, list[int]]]:
    frequencies: dict[str, dict[bool, list[int]]] = defaultdict(lambda: defaultdict(list))
    if "frequencies.txt" not in archive.namelist():
        return frequencies
    raw, text, rows = gtfs_reader(archive, "frequencies.txt")
    try:
        header = next(rows)
        columns = {name: index for index, name in enumerate(header)}
        for row in rows:
            start = parse_time(row[columns["start_time"]])
            end = parse_time(row[columns["end_time"]])
            headway = int(row[columns["headway_secs"]])
            approximate = row[columns.get("exact_times", -1)] != "1"
            frequencies[row[columns["trip_id"]]][approximate].extend(range(start, end, headway))
    finally:
        text.close()
        raw.close()
    return frequencies


def encode_timing_profile(arrivals: list[int], departures: list[int]) -> bytes:
    """Encode first-stop dwell, then travel delta and dwell at every next stop."""

    payload = bytearray(signed_varint(departures[0] - arrivals[0]))
    previous_departure = departures[0]
    for arrival, departure in zip(arrivals[1:], departures[1:]):
        payload += signed_varint(departure - previous_departure)
        payload += signed_varint(departure - arrival)
        previous_departure = departure
    return bytes(payload)


def encode_shard(
    group_ids: list[int],
    group_keys: list[tuple],
    group_starts: list[list[int]],
    patterns: list[tuple[tuple[int, int], ...]],
    timings: list[bytes],
    stop_ids: list[str],
) -> tuple[bytes, dict]:
    routes = sorted({group_keys[group_id][0] for group_id in group_ids})
    services = sorted({group_keys[group_id][1] for group_id in group_ids})
    headsigns = sorted({group_keys[group_id][2] for group_id in group_ids})
    pattern_ids = sorted({group_keys[group_id][3] for group_id in group_ids})
    timing_ids = sorted({group_keys[group_id][4] for group_id in group_ids})
    used_stop_indexes = sorted({stop for pattern_id in pattern_ids for stop, _ in patterns[pattern_id]})

    route_index = {value: index for index, value in enumerate(routes)}
    service_index = {value: index for index, value in enumerate(services)}
    headsign_index = {value: index for index, value in enumerate(headsigns)}
    pattern_index = {value: index for index, value in enumerate(pattern_ids)}
    timing_index = {value: index for index, value in enumerate(timing_ids)}
    stop_index = {value: index for index, value in enumerate(used_stop_indexes)}

    payload = bytearray(MAGIC)
    payload += unsigned_varint(FORMAT_VERSION)
    payload += front_coded_strings(routes)
    payload += front_coded_strings(services)
    payload += front_coded_strings(headsigns)
    payload += front_coded_strings([stop_ids[index] for index in used_stop_indexes])

    payload += unsigned_varint(len(pattern_ids))
    pattern_stop_count = 0
    for pattern_id in pattern_ids:
        pattern = patterns[pattern_id]
        pattern_stop_count += len(pattern)
        payload += unsigned_varint(len(pattern))
        previous = 0
        for global_stop_index, flags in pattern:
            local_stop_index = stop_index[global_stop_index]
            token = (((local_stop_index - previous) << 1) ^ ((local_stop_index - previous) >> 63)) << 4
            payload += unsigned_varint(token | flags)
            previous = local_stop_index

    payload += unsigned_varint(len(timing_ids))
    for timing_id in timing_ids:
        timing = timings[timing_id]
        payload += unsigned_varint(len(timing))
        payload += timing

    payload += unsigned_varint(len(group_ids))
    departure_count = 0
    for group_id in sorted(group_ids, key=lambda value: group_keys[value]):
        route, service, headsign, pattern_id, timing_id, direction, wheelchair, approximate = group_keys[group_id]
        starts = sorted(set(group_starts[group_id]))
        departure_count += len(starts)
        payload += unsigned_varint(route_index[route])
        payload += unsigned_varint(service_index[service])
        payload += unsigned_varint(headsign_index[headsign])
        payload += unsigned_varint(pattern_index[pattern_id])
        payload += unsigned_varint(timing_index[timing_id])
        payload += unsigned_varint(direction + 1)
        payload += unsigned_varint(wheelchair)
        payload += unsigned_varint(int(approximate))
        payload += unsigned_varint(len(starts))
        previous = 0
        for start in starts:
            payload += unsigned_varint(start - previous)
            previous = start

    return bytes(payload), {
        "routes": len(routes),
        "services": len(services),
        "headsigns": len(headsigns),
        "stops": len(used_stop_indexes),
        "patterns": len(pattern_ids),
        "pattern_stops": pattern_stop_count,
        "timings": len(timing_ids),
        "groups": len(group_ids),
        "departures": departure_count,
    }


def verify_shard(payload: bytes) -> dict:
    if payload[:4] != MAGIC:
        raise ValueError("bad timetable shard magic")
    offset = 4
    version, offset = read_unsigned_varint(payload, offset)
    if version != FORMAT_VERSION:
        raise ValueError(f"unsupported timetable version {version}")
    tables = []
    for _ in range(4):
        table, offset = read_front_coded_strings(payload, offset)
        tables.append(table)
    routes, services, headsigns, stops = tables

    pattern_count, offset = read_unsigned_varint(payload, offset)
    pattern_lengths = []
    for _ in range(pattern_count):
        length, offset = read_unsigned_varint(payload, offset)
        pattern_lengths.append(length)
        for _ in range(length):
            _, offset = read_unsigned_varint(payload, offset)

    timing_count, offset = read_unsigned_varint(payload, offset)
    for _ in range(timing_count):
        length, offset = read_unsigned_varint(payload, offset)
        offset += length

    group_count, offset = read_unsigned_varint(payload, offset)
    departures = 0
    for _ in range(group_count):
        fields = []
        for _ in range(9):
            value, offset = read_unsigned_varint(payload, offset)
            fields.append(value)
        route, service, headsign, pattern, timing, direction, wheelchair, approximate, count = fields
        if route >= len(routes) or service >= len(services) or headsign >= len(headsigns):
            raise ValueError("group dictionary reference is out of range")
        if pattern >= pattern_count or timing >= timing_count:
            raise ValueError("group pattern reference is out of range")
        departures += count
        for _ in range(count):
            _, offset = read_unsigned_varint(payload, offset)
    if offset != len(payload):
        raise ValueError(f"decoder left {len(payload) - offset} bytes unread")
    return {
        "routes": len(routes), "services": len(services), "headsigns": len(headsigns),
        "stops": len(stops), "patterns": pattern_count, "timings": timing_count,
        "groups": group_count, "departures": departures,
    }


def build(args: argparse.Namespace) -> dict:
    started = time.perf_counter()
    gtfs_path = args.source_root / "cache" / "itm_all_gtfs.zip"
    route_chunks, chunk_count = load_route_chunks(args.data_root)
    with zipfile.ZipFile(gtfs_path) as archive:
        raw, text, rows = gtfs_reader(archive, "stops.txt")
        try:
            header = next(rows)
            stop_column = header.index("stop_id")
            stop_ids = sorted(row[stop_column] for row in rows)
        finally:
            text.close()
            raw.close()
        stop_index = {stop_id: index for index, stop_id in enumerate(stop_ids)}

        raw, text, rows = gtfs_reader(archive, "trips.txt")
        try:
            header = next(rows)
            columns = {name: index for index, name in enumerate(header)}
            trip_metadata = {}
            for row in rows:
                route_id = row[columns["route_id"]]
                if route_id not in route_chunks:
                    continue
                direction_text = row[columns["direction_id"]]
                wheelchair_text = row[columns.get("wheelchair_accessible", -1)]
                trip_metadata[row[columns["trip_id"]]] = (
                    route_id,
                    row[columns["service_id"]],
                    row[columns["trip_headsign"]],
                    int(direction_text) if direction_text else -1,
                    int(wheelchair_text) if wheelchair_text else 0,
                )
        finally:
            text.close()
            raw.close()
        input_trip_count = len(trip_metadata)
        frequency_starts = load_frequency_starts(archive)

        pattern_lookup: dict[tuple[tuple[int, int], ...], int] = {}
        patterns: list[tuple[tuple[int, int], ...]] = []
        timing_lookup: dict[bytes, int] = {}
        timings: list[bytes] = []
        group_lookup: dict[tuple, int] = {}
        group_keys: list[tuple] = []
        group_starts: list[list[int]] = []
        row_count = 0
        processed_trip_count = 0
        expanded_frequency_departures = 0
        original_departure_count = 0

        def finish_trip(trip_id: str, stops, arrivals, departures) -> None:
            nonlocal processed_trip_count, expanded_frequency_departures, original_departure_count
            metadata = trip_metadata.pop(trip_id, None)
            if metadata is None:
                raise ValueError(f"trip {trip_id!r} is missing or stop_times.txt is not grouped by trip_id")
            if not stops:
                return
            route, service, headsign, direction, wheelchair = metadata
            pattern = tuple(stops)
            pattern_id = pattern_lookup.get(pattern)
            if pattern_id is None:
                pattern_id = len(patterns)
                pattern_lookup[pattern] = pattern_id
                patterns.append(pattern)
            timing = encode_timing_profile(arrivals, departures)
            timing_id = timing_lookup.get(timing)
            if timing_id is None:
                timing_id = len(timings)
                timing_lookup[timing] = timing_id
                timings.append(timing)
            starts_by_kind = frequency_starts.pop(trip_id, None)
            if starts_by_kind:
                expanded_frequency_departures += sum(map(len, starts_by_kind.values()))
            else:
                starts_by_kind = {False: [departures[0]]}
            for approximate, starts in starts_by_kind.items():
                key = (route, service, headsign, pattern_id, timing_id, direction, wheelchair, approximate)
                group_id = group_lookup.get(key)
                if group_id is None:
                    group_id = len(group_keys)
                    group_lookup[key] = group_id
                    group_keys.append(key)
                    group_starts.append([])
                group_starts[group_id].extend(starts)
                original_departure_count += len(starts)
            processed_trip_count += 1

        raw, text, rows = gtfs_reader(archive, "stop_times.txt")
        try:
            header = next(rows)
            columns = {name: index for index, name in enumerate(header)}
            current_trip = None
            stops = []
            arrivals = []
            departures = []
            for row in rows:
                trip_id = row[columns["trip_id"]]
                if trip_id != current_trip:
                    if current_trip is not None:
                        finish_trip(current_trip, stops, arrivals, departures)
                        if args.sample_trips and processed_trip_count >= args.sample_trips:
                            break
                    current_trip = trip_id
                    stops, arrivals, departures = [], [], []
                arrival_text = row[columns["arrival_time"]]
                departure_text = row[columns["departure_time"]] or arrival_text
                arrival_text = arrival_text or departure_text
                pickup_text = row[columns["pickup_type"]]
                dropoff_text = row[columns["drop_off_type"]]
                flags = ((int(pickup_text) if pickup_text else 0) & 3) << 2
                flags |= (int(dropoff_text) if dropoff_text else 0) & 3
                stops.append((stop_index[row[columns["stop_id"]]], flags))
                arrivals.append(parse_time(arrival_text))
                departures.append(parse_time(departure_text))
                row_count += 1
            else:
                if current_trip is not None:
                    finish_trip(current_trip, stops, arrivals, departures)
        finally:
            text.close()
            raw.close()

    groups_by_chunk: dict[int, list[int]] = defaultdict(list)
    for group_id, key in enumerate(group_keys):
        groups_by_chunk[route_chunks[key[0]]].append(group_id)

    destination = args.destination
    destination.mkdir(parents=True, exist_ok=True)
    for old_file in destination.glob("chunk-*.bin.gz"):
        old_file.unlink()

    shard_stats = {}
    compressed_total = 0
    uncompressed_total = 0
    verified_departures = 0
    for chunk in range(chunk_count):
        group_ids = groups_by_chunk.get(chunk, [])
        if not group_ids:
            continue
        payload, stats = encode_shard(group_ids, group_keys, group_starts, patterns, timings, stop_ids)
        verified = verify_shard(payload)
        if verified["groups"] != stats["groups"] or verified["departures"] != stats["departures"]:
            raise ValueError(f"verification mismatch in chunk {chunk}")
        compressed = gzip_bytes(payload)
        name = f"chunk-{chunk:03d}.bin.gz"
        (destination / name).write_bytes(compressed)
        stats["uncompressed_bytes"] = len(payload)
        stats["compressed_bytes"] = len(compressed)
        shard_stats[name] = stats
        uncompressed_total += len(payload)
        compressed_total += len(compressed)
        verified_departures += verified["departures"]

    unique_departures = sum(len(set(starts)) for starts in group_starts)
    report = {
        "schema_version": FORMAT_VERSION,
        "source": str(gtfs_path),
        "sample_trips": args.sample_trips or None,
        "source_stop_time_rows": row_count,
        "source_trips": input_trip_count,
        "processed_trips": processed_trip_count,
        "trips_without_stop_times": 0 if args.sample_trips else len(trip_metadata),
        "unique_stop_patterns": len(patterns),
        "unique_timing_profiles": len(timings),
        "journey_groups": len(group_keys),
        "scheduled_starts_before_deduplication": original_departure_count,
        "scheduled_starts": unique_departures,
        "duplicate_scheduled_starts_removed": original_departure_count - unique_departures,
        "frequency_departures_expanded": expanded_frequency_departures,
        "shard_count": len(shard_stats),
        "uncompressed_bytes": uncompressed_total,
        "compressed_bytes": compressed_total,
        "existing_route_calendar_bytes": (args.data_root / "route-calendar.json.gz").stat().st_size,
        "total_timetable_feature_bytes": compressed_total + (args.data_root / "route-calendar.json.gz").stat().st_size,
        "build_seconds": round(time.perf_counter() - started, 3),
        "shards": shard_stats,
    }
    runtime_manifest = {
        "schema_version": FORMAT_VERSION,
        "format": "BTT1 varint + gzip",
        "route_chunk_strategy": "spatial-morton-v1",
        "shard_count": len(shard_stats),
        "source_stop_time_rows": row_count,
        "processed_trips": processed_trip_count,
        "unique_stop_patterns": len(patterns),
        "unique_timing_profiles": len(timings),
        "journey_groups": len(group_keys),
        "scheduled_starts": unique_departures,
        "compressed_bytes": compressed_total,
        "calendar_path": "../route-calendar.json.gz",
    }
    (destination / "manifest.json").write_text(json.dumps(runtime_manifest, indent=2) + "\n", encoding="utf-8")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-root", type=Path, default=Path(__file__).resolve().parents[2] / "bus_processing_new",
        help="National pipeline directory containing cache/itm_all_gtfs.zip",
    )
    parser.add_argument(
        "--data-root", type=Path, default=Path(__file__).resolve().parents[1] / "public" / "data",
        help="Existing site data, used to preserve its spatial route sharding",
    )
    parser.add_argument(
        "--destination", type=Path,
        default=Path(__file__).resolve().parents[1] / "public" / "data" / "timetables",
    )
    parser.add_argument(
        "--report", type=Path,
        default=Path(__file__).resolve().parents[1] / "reports" / "timetable-compression.json",
        help="Detailed build measurements (kept outside public/ so they are not deployed)",
    )
    parser.add_argument("--sample-trips", type=int, help="Build only this many trips for a quick format test")
    args = parser.parse_args()
    report = build(args)
    print(json.dumps({key: value for key, value in report.items() if key != "shards"}, indent=2))


if __name__ == "__main__":
    main()
