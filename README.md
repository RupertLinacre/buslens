# Mobile nearby bus map

A standalone Vite prototype for finding bus routes around a phone’s current
location. It opens around Oxford's main central bus stops while requesting
location permission, and remains there with an explanatory message when the
reported location is outside the UK. It is designed for static hosting,
including GitHub Pages.

The map is the default view: route lines and number labels stay visible while a
compact drawer at the bottom shows the nearby route count. The default search
radius is 500 m. Moving the map automatically refreshes stops and routes within
the chosen radius only when “follow map centre” is enabled. By default the lens
stays fixed while the map is panned or zoomed; tap or click the map to place it
somewhere new. The location control always moves the lens to the reported
location. Tap the drawer to expand the route list or change the radius.
Tap a route in the list or on the map to highlight it and mute the
others; choosing it from the list opens a detail view with the ordered stops for
each direction. If the drawer is already open, selecting a route on the map
switches to that route’s stop detail without changing the drawer’s visibility.
Canvas click tolerance makes near-misses easy to select without rendering a
second copy of every route; clicking empty map background clears the selection.
The cog opens advanced route settings. School/restricted services, metro and
Underground lines, and long-distance coaches are excluded by default and can be
included independently. “Running today only” is enabled by default and uses the
published timetable in UK time, including dated service exceptions.

The clock control filters the map to routes with a published departure from the
single closest stop inside the lens served by each route. Its compact slider
ranges from the next 5 minutes to the next 2 hours. The drawer now follows a
three-level flow: nearby routes, then the selected route's remaining departures
today at that one stop, then the exact timed stop sequence for a selected
departure. Timetable shards use the same spatial partition as route geometry,
so this feature only downloads schedules for nearby routes.

## Data architecture

The existing national collector remains the raw-data pipeline: it downloads the
BODS GTFS aggregate, normalises operators/routes/stops, and creates simplified
route geometry in SQLite. This app’s `scripts/build_data.py` turns that working
database into mobile-sized static assets:

- stops are split into 0.125° × 0.0625° gzip-compressed spatial tiles so a local
  search does not download a large regional stop payload;
- lightweight route metadata and geometry are split into 256 gzip-compressed
  spatial chunks, with the matching ordered stop details in separate
  lazy-loaded chunks;
- routes are ordered by a Morton spatial key, so services operating near one
  another usually share a chunk. A roughly 41 KB compressed route index is
  prefetched at startup and replaces the much larger route-to-chunk dictionary;
- route geometry is the 100 m simplification, which is appropriate for the
  nearby mobile map and avoids shipping the 864 MB working database;
- the data build preserves GTFS route types, which authoritatively identify
  coach and metro services. Because the aggregate has no public-access flag,
  school/restricted classification is deliberately conservative: it uses
  explicit route/operator wording or routes whose every trip follows a
  weekday-only calendar with a material school-holiday gap;
- a roughly 170 KB compressed route calendar maps routes to GTFS weekday masks,
  validity ranges and dated exceptions. This is sufficient to determine whether
  each route runs today without shipping the 5.8 GB `stop_times.txt` source;
- stop and route chunks are cached in memory, concurrent searches discard stale
  results, and searches retain the existing route layers when the route set is
  unchanged. In follow mode, a short post-pan delay coalesces consecutive map
  movements before route loading begins.

DuckDB-Wasm was deliberately not made the first prototype’s transport layer.
Opening a full national DuckDB file on a phone would still require downloading a
large database before the first search. Spatial static chunks give the same
indexed lookup behaviour while keeping the first request local and small. The
manifest/chunk boundary leaves room for a DuckDB-Wasm cache later if profiling
shows it is worthwhile.

## Compressed timetable experiment

The `experiment/compressed-full-timetables` branch contains a complete national
pass over `stop_times.txt`. It streams the 5.79 GB CSV directly from the GTFS
ZIP and never extracts it to disk. Rather than storing every stop event as a
row, `scripts/build_timetables.py` factors the data into:

- 126,534 reusable stop patterns, including pickup and drop-off restrictions;
- 381,475 relative arrival/departure timing profiles;
- service calendar, route, destination, direction and accessibility metadata;
- 698,766 journey groups with delta-encoded start times.

The binary format uses varints, front-coded string dictionaries and start-time
delta encoding, followed by gzip. It retains all 1,762,225 trips and processes
all 67,931,190 source stop-time rows. Identical published departures are
deduplicated (203 duplicates nationally), while the 81 GTFS frequency-based
templates are expanded into queryable starts.

The 256 output files total **15,087,180 bytes (14.39 MiB)**. The existing route
calendar is 173,892 bytes, so a deployment starting without any timetable data
would need **15,261,072 bytes (14.55 MiB)** in total. BusLens already ships the
calendar, making the actual new payload about **15.09 MB**. Shards average 59 KB,
have a 31 KB median and a 487 KB maximum; a phone only fetches shards belonging
to the nearby route chunks. A Brotli level-11 trial reduced the same 256 shards
to 9,861,752 bytes, but gzip is retained because it works with the browser's
native `DecompressionStream` and the present static-hosting setup.

Build the complete data set with:

```bash
pnpm run build:timetables
```

The runtime files are written to `public/data/timetables/`. A detailed,
non-deployed measurement report is written to
`reports/timetable-compression.json`.

## Build and run

This project uses pnpm. From this folder:

```bash
pnpm install
pnpm run build:data
pnpm run dev -- --host 0.0.0.0
```

The data build consumes `../bus_processing_new/work/national/national.sqlite` and
`../bus_processing_new/output_national/services.json.gz`. To collect and process
the national BODS aggregate first, run:

```bash
pnpm run build:data -- --run-national
```

Then open the Vite URL on the phone. The phone and computer must be on the same
network; Vite will print the network URL. `pnpm run build` produces a static
`dist/` directory with the `/buslens/` production base.

## Deploy

The `gh-pages` branch is the GitHub Pages publishing source. Deploy the current
working tree with:

```bash
pnpm run deploy
```

The command builds the site, adds `.nojekyll`, and publishes `dist/` to the
`gh-pages` branch. The account-level Pages site already maps
`RupertLinacre.github.io` to `rupertlinacre.com`, so this project deliberately
does not create its own `CNAME`. Its public URL is:

<https://rupertlinacre.com/buslens/>
