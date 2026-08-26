# Mobile nearby bus map

A standalone Vite prototype for finding bus routes around a phone’s current
location. It is designed for static hosting, including GitHub Pages.

The map is the default view: route lines and number labels stay visible while a
compact drawer at the bottom shows the nearby route count. The default search
radius is 500 m. Moving the map automatically refreshes stops and routes within
the chosen radius whenever no route is selected. The freeze button beside the
location control locks the search circle and displayed buses while the map is
moved or zoomed. Double-tap the map to move the search circle there and freeze
it in one gesture. Tap the drawer to expand the route list or change the radius.
Tap a route in the list or on the map to highlight it and mute the
others; choosing it from the list opens a detail view with the ordered stops for
each direction. If the drawer is already open, selecting a route on the map
switches to that route’s stop detail without changing the drawer’s visibility.
Canvas click tolerance makes near-misses easy to select without rendering a
second copy of every route; clicking empty map background clears the selection.

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
- stop and route chunks are cached in memory, concurrent searches discard stale
  results, and small pans retain the existing route layers when the route set is
  unchanged. The short post-pan delay is only there to coalesce consecutive map
  movements; route loading begins almost immediately after `moveend`.

DuckDB-Wasm was deliberately not made the first prototype’s transport layer.
Opening a full national DuckDB file on a phone would still require downloading a
large database before the first search. Spatial static chunks give the same
indexed lookup behaviour while keeping the first request local and small. The
manifest/chunk boundary leaves room for a DuckDB-Wasm cache later if profiling
shows it is worthwhile.

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
