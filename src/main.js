import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { isWithinUk } from './uk-bounds.js';

const DEFAULT_VIEW = [51.7535, -1.2605];
const DEFAULT_ZOOM = 14;
const AUTO_SEARCH_DELAY_MS = 60;
const SEARCH_MOVE_THRESHOLD_METRES = 24;
const CARTO_API_KEY = 'cb1_26un_1_027ad1a3b8c1c85a79e28cfd';
const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
const ROUTE_ID_ENCODER = new TextEncoder();
const FILTER_STORAGE_KEY = 'buslens-route-filters-v1';
const DEFAULT_ROUTE_FILTERS = { today_only: true, school_restricted: false, metro: false, coach: false };
const OPTIONAL_ROUTE_CATEGORIES = ['school_restricted', 'metro', 'coach'];

function loadRouteFilters() {
  try {
    const stored = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) || '{}');
    return Object.fromEntries(Object.entries(DEFAULT_ROUTE_FILTERS).map(([key, defaultValue]) => [
      key,
      typeof stored[key] === 'boolean' ? stored[key] : defaultValue,
    ]));
  } catch {
    return { ...DEFAULT_ROUTE_FILTERS };
  }
}

const state = {
  map: null,
  radiusMetres: 500,
  searchedCenter: null,
  mapCenter: null,
  locationCenter: null,
  followMapCenter: false,
  routeFilters: loadRouteFilters(),
  lastResultStatus: null,
  nearbyStopCount: 0,
  dirty: false,
  searching: false,
  stopDataCache: new Map(),
  routeDataCache: new Map(),
  routeDetailDataCache: new Map(),
  routeChunkIndex: null,
  routeChunkIndexPromise: null,
  routeCalendar: null,
  routeCalendarPromise: null,
  stopTileKeys: new Set(),
  stopsLayer: null,
  routeLayer: null,
  routeRenderer: null,
  labelsLayer: null,
  searchCircle: null,
  searchMarker: null,
  manifest: null,
  sheetOpen: false,
  routeDetailOpen: false,
  routes: [],
  rawRoutes: [],
  routesById: new Map(),
  sourceRouteSignature: null,
  routeSignature: null,
  selectedRouteId: null,
  requestedCenter: null,
  requestedRadius: null,
  searchSequence: 0,
  autoSearchTimer: null,
  detailSequence: 0,
};

const elements = {
  statusText: document.getElementById('status-text'),
  mapStatus: document.getElementById('map-status'),
  locationButton: document.getElementById('location-button'),
  followButton: document.getElementById('follow-button'),
  settingsButton: document.getElementById('settings-button'),
  settingsDialog: document.getElementById('settings-dialog'),
  settingsClose: document.getElementById('settings-close'),
  todayFilterNote: document.getElementById('today-filter-note'),
  results: document.getElementById('results'),
  sheet: document.querySelector('.bottom-sheet'),
  sheetToggle: document.getElementById('sheet-toggle'),
  sheetContent: document.getElementById('sheet-content'),
  sheetCount: document.getElementById('sheet-count'),
  sheetToggleLabel: document.getElementById('sheet-toggle-label'),
  routeDetail: document.getElementById('route-detail'),
  routeDetailBack: document.getElementById('route-detail-back'),
  routeDetailContent: document.getElementById('route-detail-content'),
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function formatDistance(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

function colourForNumber(value) {
  let hash = 0;
  for (const character of String(value || 'unnamed')) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 68% 42%)`;
}

function coordinateDistance(first, second) {
  const latitude = ((first[1] + second[1]) / 2) * Math.PI / 180;
  return Math.hypot((second[0] - first[0]) * Math.cos(latitude), second[1] - first[1]);
}

function lineLength(line) {
  let length = 0;
  for (let index = 1; index < line.length; index += 1) length += coordinateDistance(line[index - 1], line[index]);
  return length;
}

function midpointAlongLine(line) {
  if (!line?.length) return null;
  if (line.length === 1) return line[0];
  const total = lineLength(line);
  if (!total) return line[Math.floor(line.length / 2)];
  const target = total / 2;
  let travelled = 0;
  for (let index = 1; index < line.length; index += 1) {
    const first = line[index - 1];
    const second = line[index];
    const segment = coordinateDistance(first, second);
    if (travelled + segment >= target) {
      const fraction = segment ? (target - travelled) / segment : 0;
      return [first[0] + (second[0] - first[0]) * fraction, first[1] + (second[1] - first[1]) * fraction];
    }
    travelled += segment;
  }
  return line[line.length - 1];
}

function routeDescription(route) {
  return route.route_long_name || route.headsigns?.slice(0, 2).join(' ↔ ') || 'Route details unavailable';
}

function routeNumber(route) {
  return route.route_short_name || route.route_id || '—';
}

function ukServiceDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  const label = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date());
  return { value: `${parts.year}${parts.month}${parts.day}`, weekday, label };
}

function routeCalendarCovers(dateValue) {
  const coverage = state.manifest?.route_calendar;
  return Boolean(coverage?.start_date && coverage?.end_date && dateValue >= coverage.start_date && dateValue <= coverage.end_date);
}

function sortedDatesInclude(dates, target) {
  let low = 0;
  let high = dates.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (dates[middle] === target) return true;
    if (dates[middle] < target) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

function routeRunsOnDate(routeId, date) {
  if (!state.routeCalendar) return true;
  const serviceIds = state.routeCalendar.r?.[routeId];
  if (!serviceIds?.length) return true;
  return serviceIds.some((serviceId) => {
    const calendar = state.routeCalendar.c?.[serviceId];
    if (!calendar) return false;
    const [weekdayMask, startDate, endDate, addedDates = [], removedDates = []] = calendar;
    if (sortedDatesInclude(addedDates, date.value)) return true;
    if (sortedDatesInclude(removedDates, date.value)) return false;
    return Boolean(startDate && endDate && date.value >= startDate && date.value <= endDate && (weekdayMask & (1 << date.weekday)));
  });
}

function routeIsVisible(route, date) {
  const categoriesVisible = (route.categories || []).every((category) => state.routeFilters[category] !== false);
  return categoriesVisible && (
    !state.routeFilters.today_only
    || !routeCalendarCovers(date.value)
    || routeRunsOnDate(route.route_id, date)
  );
}

function syncSettingsUi() {
  document.querySelectorAll('[data-route-filter]').forEach((input) => {
    input.checked = Boolean(state.routeFilters[input.dataset.routeFilter]);
  });
  const date = ukServiceDate();
  const todayInput = document.querySelector('[data-route-filter="today_only"]');
  const timetableCurrent = routeCalendarCovers(date.value);
  todayInput.disabled = !timetableCurrent;
  elements.todayFilterNote.textContent = timetableCurrent
    ? `Scheduled service for ${date.label} in UK time`
    : 'Timetable coverage needs refreshing';
  const enabledCount = OPTIONAL_ROUTE_CATEGORIES.filter((category) => state.routeFilters[category]).length;
  elements.settingsButton.classList.toggle('has-active-filters', enabledCount > 0);
  elements.settingsButton.setAttribute(
    'aria-label',
    enabledCount ? `Route settings, ${enabledCount} optional ${enabledCount === 1 ? 'category' : 'categories'} included` : 'Route settings',
  );
}

function updateRouteFilter(category, include) {
  if (!(category in DEFAULT_ROUTE_FILTERS) || state.routeFilters[category] === include) return;
  state.routeFilters[category] = include;
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state.routeFilters));
  } catch {
    // Filtering still works when storage is unavailable (for example private browsing).
  }
  syncSettingsUi();
  if (state.searchedCenter) searchAt(state.searchedCenter, 'auto');
}

function setStatus(text, tone = '') {
  elements.statusText.textContent = text;
  elements.mapStatus.dataset.tone = tone;
}

function resultStatus() {
  const today = state.routeFilters.today_only && routeCalendarCovers(ukServiceDate().value) ? ' today' : '';
  return state.routes.length
    ? `${state.routes.length} route${state.routes.length === 1 ? '' : 's'}${today} from ${state.nearbyStopCount || 0} nearby stop${state.nearbyStopCount === 1 ? '' : 's'}`
    : `No routes${today ? ' running today' : ''} within ${formatDistance(state.radiusMetres)}`;
}

function setFollowMapCenter(follow) {
  state.followMapCenter = follow;
  elements.followButton.setAttribute('aria-pressed', String(follow));
  elements.followButton.setAttribute('aria-label', follow ? 'Stop following map centre' : 'Follow map centre');
  elements.followButton.title = follow ? 'Stop following map centre' : 'Follow map centre';
  if (!follow) {
    if (state.autoSearchTimer) {
      clearTimeout(state.autoSearchTimer);
      state.autoSearchTimer = null;
    }
    state.dirty = false;
    setStatus(state.lastResultStatus || 'Tap the map to place the lens');
    return;
  }
  if (state.selectedRouteId) clearRouteSelection();
  const mapCenter = state.map.getCenter();
  const center = [mapCenter.lat, mapCenter.lng];
  state.mapCenter = center;
  const referenceCenter = state.searchedCenter;
  if (!referenceCenter || state.map.distance(center, referenceCenter) > SEARCH_MOVE_THRESHOLD_METRES) {
    setDirty(true);
    setStatus('Updating nearby routes…', 'working');
    scheduleAutoSearch(center);
  } else {
    setStatus(state.lastResultStatus || 'Tap the map to place the lens');
  }
}

function placeLensAt(center) {
  setFollowMapCenter(false);
  searchAt(center, 'auto');
}

function setDirty(dirty) {
  state.dirty = dirty;
  if (dirty && !state.searching && !state.selectedRouteId) {
    elements.sheetToggleLabel.textContent = 'Updating this area…';
  }
}

function setSheetOpen(open) {
  if (!open) state.routeDetailOpen = false;
  state.sheetOpen = open;
  elements.sheet.classList.toggle('is-open', open);
  elements.sheetToggle.setAttribute('aria-expanded', String(open));
  elements.sheetContent.hidden = !open || state.routeDetailOpen;
  elements.routeDetail.hidden = !open || !state.routeDetailOpen;
}

function closeRouteDetail() {
  state.routeDetailOpen = false;
  elements.sheetContent.hidden = !state.sheetOpen;
  elements.routeDetail.hidden = true;
  elements.sheetToggleLabel.textContent = state.routes.length
    ? `${state.routes.length} routes · tap to view`
    : 'Tap to view stops and routes';
}

function clearRouteSelection() {
  if (!state.selectedRouteId) return;
  state.selectedRouteId = null;
  state.routeLayer?.eachLayer((layer) => {
    layer.setStyle(routeStyle(layer.feature || {}));
    layer.closeTooltip?.();
  });
  state.labelsLayer?.eachLayer((label) => {
    label.getElement()?.classList.remove('is-selected', 'is-muted');
    label.setZIndexOffset?.(0);
  });
  elements.results.querySelectorAll('[data-route-id]').forEach((card) => card.classList.remove('is-selected'));
  if (state.routeDetailOpen) closeRouteDetail();
  elements.sheetToggleLabel.textContent = state.routes.length
    ? (state.dirty ? 'Map moved · open to find routes here' : `${state.routes.length} routes · tap to view`)
    : 'Tap to view stops and routes';
  if (state.dirty && state.mapCenter) scheduleAutoSearch(state.mapCenter);
}

function routeDetailHeaderMarkup(route, stopCount = null) {
  return `<header class="route-detail-header">
    <span class="route-detail-number" style="--route-colour:${colourForNumber(routeNumber(route))}">${escapeHtml(routeNumber(route))}</span>
    <div><p class="sheet-kicker">${escapeHtml(route.operator_name || 'Unknown operator')}</p><h2>${escapeHtml(routeDescription(route))}</h2>${stopCount === null ? '' : `<span>${stopCount} stops</span>`}</div>
  </header>`;
}

function renderRouteDetail(route) {
  const patterns = (route.stop_patterns || []).filter((pattern) => pattern.stops?.length);
  const patternMarkup = patterns.length
    ? patterns.map((pattern, index) => `
      <section class="stop-pattern">
        <div class="stop-pattern-heading"><span>${escapeHtml(pattern.headsign || `Direction ${index + 1}`)}</span><small>${pattern.stops.length} stops</small></div>
        <ol class="stop-list">${pattern.stops.map((stop) => `<li><strong>${escapeHtml(stop.name)}</strong></li>`).join('')}</ol>
      </section>`).join('')
    : '<div class="results-empty"><span class="empty-symbol">⌕</span><strong>Stop sequence unavailable</strong><p>This route has geometry, but no ordered stop list in the static data.</p></div>';
  elements.routeDetailContent.innerHTML = `
    ${routeDetailHeaderMarkup(route, route.stop_count || patterns[0]?.stops?.length || 0)}
    <div class="route-detail-stops">${patternMarkup}</div>`;
}

async function openRouteDetail(route) {
  state.routeDetailOpen = true;
  const detailSequence = ++state.detailSequence;
  elements.sheetToggleLabel.textContent = `${routeNumber(route)} · ${route.operator_name || 'Unknown operator'}`;
  if (route.stop_patterns) renderRouteDetail(route);
  else {
    elements.routeDetailContent.innerHTML = `${routeDetailHeaderMarkup(route)}<div class="detail-loading"><span></span>Loading stops…</div>`;
  }
  setSheetOpen(true);
  if (route.stop_patterns) return;
  try {
    await loadRouteDetails(route);
    if (detailSequence === state.detailSequence && state.routeDetailOpen && state.selectedRouteId === route.route_id) {
      renderRouteDetail(route);
    }
  } catch (error) {
    console.error(error);
    if (detailSequence === state.detailSequence && state.routeDetailOpen) {
      elements.routeDetailContent.innerHTML = `${routeDetailHeaderMarkup(route)}<div class="results-empty"><strong>Stops could not be loaded</strong><p>Check your connection and try again.</p></div>`;
    }
  }
}

function routeStyle(feature) {
  const routeId = feature.properties?.route_id;
  const selected = state.selectedRouteId;
  const isSelected = !selected || selected === routeId;
  return {
    color: colourForNumber(feature.properties?.route_number),
    weight: selected && isSelected ? 6 : 4,
    opacity: selected ? (isSelected ? 1 : 0.07) : 0.84,
    lineCap: 'round',
    lineJoin: 'round',
  };
}

function highlightRoute(routeId) {
  state.selectedRouteId = routeId;
  const selectedLayers = [];
  state.routeLayer?.eachLayer((layer) => {
    layer.setStyle(routeStyle(layer.feature || {}));
    if (layer.feature?.properties?.route_id === routeId) selectedLayers.push(layer);
  });
  // Leaflet otherwise leaves overlapping paths in their original insertion
  // order. Bring every geometry belonging to the selected route above the
  // muted paths so the highlight remains legible at busy junctions.
  selectedLayers.forEach((layer) => layer.bringToFront?.());
  state.labelsLayer?.eachLayer((label) => {
    const isSelected = label.options.routeId === routeId;
    label.getElement()?.classList.toggle('is-selected', isSelected);
    label.getElement()?.classList.toggle('is-muted', !isSelected);
    label.setZIndexOffset?.(isSelected ? 1000 : 0);
    if (isSelected) label.bringToFront?.();
  });
  elements.results.querySelectorAll('[data-route-id]').forEach((card) => {
    card.classList.toggle('is-selected', card.dataset.routeId === routeId);
  });
}

function selectRouteFromMap(routeId) {
  const route = state.routesById.get(routeId);
  highlightRoute(routeId);
  if (!route) return;
  if (state.sheetOpen) {
    // The drawer is already visible, so switch its content to the exact
    // selected route without changing the drawer's open/closed state.
    openRouteDetail(route);
  } else if (!state.sheetOpen) {
    elements.sheetToggleLabel.textContent = `${routeNumber(route)} selected · tap to view`;
  }
}

function updateSheetSummary(stops, routes) {
  if (routes.length) {
    const today = state.routeFilters.today_only && routeCalendarCovers(ukServiceDate().value) ? ' today' : ' nearby';
    elements.sheetCount.textContent = `${routes.length} route${routes.length === 1 ? '' : 's'}${today}`;
    elements.sheetToggleLabel.textContent = `${stops.length} stop${stops.length === 1 ? '' : 's'} · ${formatDistance(state.radiusMetres)} · tap to view`;
  } else {
    elements.sheetCount.textContent = 'Nearby routes';
    elements.sheetToggleLabel.textContent = state.dirty ? 'Map moved · open to find routes here' : 'Tap to view stops and routes';
  }
}

async function loadJsonGzip(path) {
  const response = await fetch(`${DATA_BASE}${path}`);
  if (!response.ok) throw new Error(`Could not load ${path}`);
  // Vite's dev server transparently applies Content-Encoding: gzip to .gz
  // assets. Fetch has already unpacked those responses, whereas a static host
  // such as GitHub Pages generally serves the raw gzip bytes.
  if ((response.headers.get('content-encoding') || '').includes('gzip')) return response.json();
  const buffer = await response.arrayBuffer();
  if ('DecompressionStream' in window) {
    const stream = new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip')));
    return stream.json();
  }
  throw new Error('This browser cannot unpack the static route data');
}

function nearbyTileKeys(center, radiusMetres) {
  const latDelta = radiusMetres / 111320;
  const lonDelta = radiusMetres / (111320 * Math.max(0.2, Math.cos(center[0] * Math.PI / 180)));
  const minLat = center[0] - latDelta;
  const maxLat = center[0] + latDelta;
  const minLon = center[1] - lonDelta;
  const maxLon = center[1] + lonDelta;
  const keys = [];
  const minLatIndex = Math.floor((minLat + 90) / state.manifest.tile_size_lat);
  const maxLatIndex = Math.floor((maxLat + 90) / state.manifest.tile_size_lat);
  const minLonIndex = Math.floor((minLon + 180) / state.manifest.tile_size_lon);
  const maxLonIndex = Math.floor((maxLon + 180) / state.manifest.tile_size_lon);
  for (let latIndex = minLatIndex; latIndex <= maxLatIndex; latIndex += 1) {
    for (let lonIndex = minLonIndex; lonIndex <= maxLonIndex; lonIndex += 1) keys.push(`${latIndex}_${lonIndex}`);
  }
  return keys;
}

async function loadStopTile(key) {
  if (!state.stopTileKeys.has(key)) return { stops: [] };
  if (!state.stopDataCache.has(key)) state.stopDataCache.set(key, loadJsonGzip(`stops/${key}.json.gz`));
  return state.stopDataCache.get(key);
}

async function findNearbyStops(center, radiusMetres) {
  const keys = nearbyTileKeys(center, radiusMetres);
  const payloads = await Promise.all(keys.map(loadStopTile));
  const seen = new Set();
  const nearby = [];
  const metresPerLatitudeDegree = 111320;
  const metresPerLongitudeDegree = metresPerLatitudeDegree * Math.cos(center[0] * Math.PI / 180);
  const radiusSquared = radiusMetres ** 2;
  for (const payload of payloads) {
    for (const stop of payload.stops || []) {
      if (seen.has(stop.id)) continue;
      seen.add(stop.id);
      const northing = (stop.lat - center[0]) * metresPerLatitudeDegree;
      const easting = (stop.lon - center[1]) * metresPerLongitudeDegree;
      const distanceSquared = northing ** 2 + easting ** 2;
      if (distanceSquared <= radiusSquared) nearby.push({ ...stop, distance: Math.sqrt(distanceSquared) });
    }
  }
  return nearby.sort((first, second) => first.distance - second.distance);
}

function routeChunkName(routeId) {
  const indexedChunk = state.routeChunkIndex?.get(routeId);
  if (indexedChunk) return indexedChunk;
  if (state.manifest.route_chunks?.[routeId]) return state.manifest.route_chunks[routeId];
  let hash = 2166136261;
  for (const byte of ROUTE_ID_ENCODER.encode(String(routeId))) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const number = hash % state.manifest.route_chunk_count;
  return `chunk-${String(number).padStart(state.manifest.route_chunk_width || 3, '0')}.json.gz`;
}

async function loadRouteIndex() {
  if (state.routeChunkIndex) return state.routeChunkIndex;
  if (!state.manifest.route_index) return null;
  if (!state.routeChunkIndexPromise) {
    state.routeChunkIndexPromise = loadJsonGzip(state.manifest.route_index).then((payload) => {
      const routeIds = payload.route_ids || [];
      if (!routeIds.length) throw new Error('The route index is empty');
      const chunkCount = state.manifest.route_chunk_count;
      const width = state.manifest.route_chunk_width || 3;
      state.routeChunkIndex = new Map(routeIds.map((routeId, index) => {
        const chunkNumber = Math.floor(index * chunkCount / routeIds.length);
        return [routeId, `chunk-${String(chunkNumber).padStart(width, '0')}.json.gz`];
      }));
      return state.routeChunkIndex;
    }).catch((error) => {
      state.routeChunkIndexPromise = null;
      throw error;
    });
  }
  return state.routeChunkIndexPromise;
}

async function loadRouteCalendar() {
  if (state.routeCalendar) return state.routeCalendar;
  const path = state.manifest.route_calendar?.path;
  if (!path) return null;
  if (!state.routeCalendarPromise) {
    state.routeCalendarPromise = loadJsonGzip(path).then((payload) => {
      state.routeCalendar = payload;
      return payload;
    }).catch((error) => {
      state.routeCalendarPromise = null;
      throw error;
    });
  }
  return state.routeCalendarPromise;
}

async function loadRouteChunk(chunk) {
  if (!state.routeDataCache.has(chunk)) state.routeDataCache.set(chunk, loadJsonGzip(`routes/${chunk}`));
  return state.routeDataCache.get(chunk);
}

async function loadRoutes(routeIds) {
  await loadRouteIndex();
  const routeIdSet = new Set(routeIds);
  const chunks = [...new Set(routeIds.map(routeChunkName))];
  const payloads = await Promise.all(chunks.map(loadRouteChunk));
  const routes = new Map();
  for (const payload of payloads) {
    for (const [routeId, route] of Object.entries(payload.routes || {})) {
      if (routeIdSet.has(routeId)) routes.set(routeId, route);
    }
  }
  return routeIds.map((routeId) => routes.get(routeId)).filter(Boolean);
}

async function loadRouteDetails(route) {
  if (route.stop_patterns) return route;
  await loadRouteIndex();
  const chunk = routeChunkName(route.route_id);
  if (!state.routeDetailDataCache.has(chunk)) {
    const directory = state.manifest.route_details_directory || 'routes';
    state.routeDetailDataCache.set(chunk, loadJsonGzip(`${directory}/${chunk}`));
  }
  const payload = await state.routeDetailDataCache.get(chunk);
  const details = payload.routes?.[route.route_id];
  if (details) Object.assign(route, details);
  else Object.assign(route, { stop_patterns: [], stop_count: 0 });
  return route;
}

function routeFeatures(routes) {
  return routes.flatMap((route) => (route.shapes || []).map((shape) => ({
    type: 'Feature',
    properties: {
      shape_id: shape.shape_id,
      direction_id: shape.direction_id,
      headsign: shape.headsign,
      source: shape.source,
      route_id: route.route_id,
      route_number: routeNumber(route),
      operator_name: route.operator_name || 'Unknown operator',
    },
    geometry: { type: 'MultiLineString', coordinates: shape.coordinates },
  })));
}

function renderRouteLabels(routes) {
  state.labelsLayer?.remove();
  state.labelsLayer = L.layerGroup().addTo(state.map);
  for (const route of routes) {
    let longestLine = null;
    let longestLength = -1;
    for (const shape of route.shapes || []) {
      for (const line of shape.coordinates || []) {
        const length = lineLength(line);
        if (length > longestLength) {
          longestLine = line;
          longestLength = length;
        }
      }
    }
    const midpoint = longestLine && midpointAlongLine(longestLine);
    if (!midpoint) continue;
    const icon = L.divIcon({
      className: 'route-label',
      html: `<span style="--label-colour:${colourForNumber(routeNumber(route))}">${escapeHtml(routeNumber(route))}</span>`,
      iconSize: null,
      iconAnchor: [0, 0],
    });
    const marker = L.marker([midpoint[1], midpoint[0]], {
      icon,
      interactive: true,
      keyboard: true,
      title: `Route ${routeNumber(route)}`,
      routeId: route.route_id,
    });
    marker.on('click', (event) => {
      L.DomEvent.stopPropagation(event);
      selectRouteFromMap(route.route_id);
    });
    marker.addTo(state.labelsLayer);
  }
}

function renderStops(stops) {
  state.stopsLayer?.remove();
  state.stopsLayer = L.layerGroup();
  stops.forEach((stop) => {
    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: 5, weight: 1.5, color: '#163e35', fillColor: '#f6bd45', fillOpacity: 1,
    }).bindTooltip(`<strong>${escapeHtml(stop.name)}</strong><small>${formatDistance(stop.distance)} away · ${stop.route_ids.length} routes</small>`, { className: 'stop-tooltip', direction: 'top', offset: [0, -5] });
    marker.addTo(state.stopsLayer);
  });
  state.stopsLayer.addTo(state.map);
}

function renderResults(stops, routes) {
  state.routes = routes;
  state.routesById = new Map(routes.map((route) => [route.route_id, route]));
  state.selectedRouteId = null;
  updateSheetSummary(stops, routes);
  if (!routes.length && state.rawRoutes.length) {
    const todayOnly = state.routeFilters.today_only && routeCalendarCovers(ukServiceDate().value);
    elements.results.innerHTML = todayOnly
      ? `<div class="results-empty"><span class="empty-symbol">⌕</span><strong>No routes running today within ${formatDistance(state.radiusMetres)}</strong><p>Turn off “Running today only” in route settings to see other scheduled services.</p></div>`
      : `<div class="results-empty"><span class="empty-symbol">⌕</span><strong>No included routes within ${formatDistance(state.radiusMetres)}</strong><p>Optional route types are hidden. Use route settings to include them.</p></div>`;
    return;
  }
  if (!stops.length) {
    elements.results.innerHTML = `<div class="results-empty"><span class="empty-symbol">⌕</span><strong>No bus stops within ${formatDistance(state.radiusMetres)}</strong><p>Tap the map or try a wider search radius.</p></div>`;
    return;
  }
  if (!routes.length) {
    elements.results.innerHTML = `<div class="results-empty"><span class="empty-symbol">⌕</span><strong>No route geometry found</strong><p>There are ${stops.length} nearby stop${stops.length === 1 ? '' : 's'}, but no mapped routes for them.</p></div>`;
    return;
  }
  const operators = new Map();
  routes.forEach((route) => {
    const operator = route.operator_name || 'Unknown operator';
    if (!operators.has(operator)) operators.set(operator, []);
    operators.get(operator).push(route);
  });
  elements.results.innerHTML = `
    <div class="route-groups">
      ${[...operators].map(([operator, operatorRoutes]) => `<section class="route-group"><div class="operator-line"><span>${escapeHtml(operator)}</span><small>${operatorRoutes.length}</small></div>${operatorRoutes.map((route) => `<button class="route-card" type="button" data-route-id="${escapeHtml(route.route_id)}"><span class="route-number" style="--route-colour:${colourForNumber(routeNumber(route))}">${escapeHtml(routeNumber(route))}</span><strong>${escapeHtml(routeDescription(route))}</strong></button>`).join('')}</section>`).join('')}
    </div>`;
}

function renderRouteGeometry(routes) {
  state.routeLayer?.remove();
  const routeCollection = { type: 'FeatureCollection', features: routeFeatures(routes) };
  state.routeLayer = L.geoJSON(routeCollection, {
    renderer: state.routeRenderer,
    style: (feature) => routeStyle(feature),
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(`<strong>Route ${escapeHtml(feature.properties.route_number)}</strong><small>${escapeHtml(feature.properties.operator_name)}</small>`, { className: 'route-tooltip', sticky: true, direction: 'top' });
      layer.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        selectRouteFromMap(feature.properties.route_id);
      });
    },
  }).addTo(state.map);
  renderRouteLabels(routes);
}

function scheduleAutoSearch(center) {
  if (!center || state.selectedRouteId) return;
  if (state.autoSearchTimer) clearTimeout(state.autoSearchTimer);
  const target = [center[0], center[1]];
  state.autoSearchTimer = setTimeout(() => {
    state.autoSearchTimer = null;
    if (!state.selectedRouteId) searchAt(target, 'auto');
  }, AUTO_SEARCH_DELAY_MS);
}

async function searchAt(center, source = 'map') {
  if (!center) return;
  if (state.autoSearchTimer) {
    clearTimeout(state.autoSearchTimer);
    state.autoSearchTimer = null;
  }
  const requestSequence = ++state.searchSequence;
  const radiusMetres = state.radiusMetres;
  state.searching = true;
  state.requestedCenter = [center[0], center[1]];
  state.requestedRadius = radiusMetres;
  if (state.selectedRouteId) {
    state.dirty = false;
    clearRouteSelection();
  }
  state.detailSequence += 1;
  if (source !== 'auto') {
    closeRouteDetail();
    setSheetOpen(false);
  }
  setDirty(false);
  setStatus('Updating nearby routes…', 'working');
  try {
    const stops = await findNearbyStops(center, radiusMetres);
    if (requestSequence !== state.searchSequence) return;
    const routeIds = [...new Set(stops.flatMap((stop) => stop.route_ids))].sort();
    const sourceRouteSignature = routeIds.join('|');
    const sourceRoutesChanged = sourceRouteSignature !== state.sourceRouteSignature;
    const rawRoutes = sourceRoutesChanged ? await loadRoutes(routeIds) : state.rawRoutes;
    if (state.routeFilters.today_only && routeCalendarCovers(ukServiceDate().value)) await loadRouteCalendar();
    if (requestSequence !== state.searchSequence) return;
    const serviceDate = ukServiceDate();
    const routes = rawRoutes.filter((route) => routeIsVisible(route, serviceDate));
    const visibleRouteIds = new Set(routes.map((route) => route.route_id));
    const visibleStops = stops
      .map((stop) => ({ ...stop, route_ids: stop.route_ids.filter((routeId) => visibleRouteIds.has(routeId)) }))
      .filter((stop) => stop.route_ids.length);
    const routeSignature = routes.map((route) => route.route_id).join('|');
    const routesChanged = routeSignature !== state.routeSignature;
    state.rawRoutes = rawRoutes;
    state.sourceRouteSignature = sourceRouteSignature;
    state.searchedCenter = [center[0], center[1]];
    if (state.searchCircle) state.searchCircle.setLatLng(center).setRadius(radiusMetres);
    else state.searchCircle = L.circle(center, { radius: radiusMetres, color: '#176b52', weight: 1.25, fillColor: '#176b52', fillOpacity: 0.055, interactive: false }).addTo(state.map);
    if (state.searchMarker) state.searchMarker.setLatLng(center);
    else state.searchMarker = L.circleMarker(center, { radius: 5, color: '#fff', weight: 2.5, fillColor: '#176b52', fillOpacity: 1, interactive: false }).addTo(state.map);
    renderStops(visibleStops);
    if (routesChanged) {
      renderRouteGeometry(routes);
      renderResults(visibleStops, routes);
      state.routeSignature = routeSignature;
    } else updateSheetSummary(visibleStops, routes);
    state.nearbyStopCount = visibleStops.length;
    state.lastResultStatus = resultStatus();
    setStatus(state.lastResultStatus);
  } catch (error) {
    if (requestSequence !== state.searchSequence) return;
    console.error(error);
    setStatus(error.message || 'Could not search route data', 'error');
    elements.results.innerHTML = `<div class="results-empty"><span class="empty-symbol">!</span><strong>Could not load route data</strong><p>Check your connection, then try again.</p></div>`;
  } finally {
    if (requestSequence === state.searchSequence) {
      state.searching = false;
      state.requestedCenter = null;
      state.requestedRadius = null;
      setDirty(false);
    }
  }
}

function requestLocation() {
  if (!navigator.geolocation) {
    state.map.setView(DEFAULT_VIEW, DEFAULT_ZOOM, { animate: true });
    searchAt(DEFAULT_VIEW, 'auto').then(() => setStatus('No location · showing Oxford', 'error'));
    return;
  }
  setStatus('Finding your location…', 'working');
  navigator.geolocation.getCurrentPosition(async (position) => {
    const center = [position.coords.latitude, position.coords.longitude];
    if (!isWithinUk(center[0], center[1])) {
      state.locationCenter = null;
      state.map.setView(DEFAULT_VIEW, DEFAULT_ZOOM, { animate: true });
      await searchAt(DEFAULT_VIEW, 'auto');
      setStatus('Outside UK · showing Oxford');
      return;
    }
    state.locationCenter = center;
    state.map.setView(center, Math.max(state.map.getZoom(), DEFAULT_ZOOM), { animate: true });
    searchAt(center, 'location');
  }, async () => {
    state.map.setView(DEFAULT_VIEW, DEFAULT_ZOOM, { animate: true });
    await searchAt(DEFAULT_VIEW, 'auto');
    setStatus('No location · showing Oxford', 'error');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 120000 });
}

async function init() {
  state.manifest = await fetch(`${DATA_BASE}manifest.json`).then((response) => response.json());
  state.stopTileKeys = new Set(state.manifest.stop_tiles || []);
  // Start the small spatial route index immediately. It will normally be in
  // memory before geolocation resolves or the user finishes their first pan.
  loadRouteIndex().catch((error) => console.error('Could not warm route index', error));
  state.map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(DEFAULT_VIEW, DEFAULT_ZOOM);
  state.routeRenderer = L.canvas({ padding: 0.5, tolerance: 12 });
  L.control.zoom({ position: 'topright' }).addTo(state.map);
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`, {
    attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 20,
  }).addTo(state.map);
  state.map.on('moveend', () => {
    state.mapCenter = [state.map.getCenter().lat, state.map.getCenter().lng];
    if (!state.followMapCenter) return;
    const referenceCenter = state.requestedRadius === state.radiusMetres && state.requestedCenter
      ? state.requestedCenter
      : state.searchedCenter;
    if (referenceCenter && state.map.distance(state.map.getCenter(), referenceCenter) <= SEARCH_MOVE_THRESHOLD_METRES) return;
    setDirty(true);
    if (state.selectedRouteId) {
      setStatus('Clear the selected route to search here');
      return;
    }
    setStatus('Updating nearby routes…', 'working');
    scheduleAutoSearch(state.mapCenter);
  });
  state.map.on('click', (event) => {
    placeLensAt([event.latlng.lat, event.latlng.lng]);
  });
  elements.locationButton.addEventListener('click', requestLocation);
  elements.followButton.addEventListener('click', () => setFollowMapCenter(!state.followMapCenter));
  elements.settingsButton.addEventListener('click', () => elements.settingsDialog.showModal());
  elements.settingsClose.addEventListener('click', () => elements.settingsDialog.close());
  elements.settingsDialog.addEventListener('click', (event) => {
    if (event.target === elements.settingsDialog) elements.settingsDialog.close();
  });
  document.querySelectorAll('[data-route-filter]').forEach((input) => input.addEventListener('change', () => {
    updateRouteFilter(input.dataset.routeFilter, input.checked);
  }));
  elements.results.addEventListener('click', (event) => {
    const card = event.target.closest('[data-route-id]');
    if (!card) return;
    const route = state.routesById.get(card.dataset.routeId);
    if (!route) return;
    highlightRoute(route.route_id);
    openRouteDetail(route);
  });
  elements.sheetToggle.addEventListener('click', () => {
    const opening = !state.sheetOpen;
    if (opening && state.selectedRouteId) {
      const route = state.routesById.get(state.selectedRouteId);
      if (route) {
        openRouteDetail(route);
        return;
      }
    }
    setSheetOpen(opening);
  });
  elements.routeDetailBack.addEventListener('click', () => {
    closeRouteDetail();
    setSheetOpen(true);
  });
  document.querySelectorAll('[data-radius]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-radius]').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    state.radiusMetres = Number(button.dataset.radius);
    if (state.selectedRouteId) clearRouteSelection();
    const searchCenter = state.followMapCenter
      ? (state.mapCenter || state.searchedCenter || DEFAULT_VIEW)
      : state.searchedCenter;
    if (!searchCenter) return;
    setDirty(state.followMapCenter);
    setStatus('Updating nearby routes…', 'working');
    if (state.followMapCenter) scheduleAutoSearch(searchCenter);
    else searchAt(searchCenter, 'auto');
  }));
  syncSettingsUi();
  searchAt(DEFAULT_VIEW, 'auto');
  setStatus('Finding your location…', 'working');
  requestLocation();
}

init().catch((error) => {
  console.error(error);
  setStatus('Route data is not ready — run the data build first', 'error');
});
