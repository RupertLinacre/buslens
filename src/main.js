import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { isWithinUk } from './uk-bounds.js';
import { createTimetableLoader } from './timetables.js';

const DEFAULT_VIEW = [51.7535, -1.2605];
const DEFAULT_ZOOM = 14;
const AUTO_SEARCH_DELAY_MS = 60;
const SEARCH_MOVE_THRESHOLD_METRES = 24;
const CARTO_API_KEY = 'cb1_26un_1_027ad1a3b8c1c85a79e28cfd';
const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
const ROUTE_ID_ENCODER = new TextEncoder();
const FILTER_STORAGE_KEY = 'buslens-route-filters-v1';
const DEFAULT_ROUTE_FILTERS = { school_restricted: false, metro: false, coach: false };
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
  departureWindowMinutes: null,
  timeFilterPanelOpen: false,
  radiusPanelOpen: false,
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
  timetableLoader: null,
  stopTileKeys: new Set(),
  stopsLayer: null,
  stopMarkers: new Map(),
  stopRenderer: null,
  routeLayer: null,
  routeRenderer: null,
  labelsLayer: null,
  searchCircle: null,
  searchMarker: null,
  manifest: null,
  sheetOpen: false,
  routeDetailOpen: false,
  routeDetailLevel: 'routes',
  routes: [],
  rawRoutes: [],
  nearbyStops: [],
  routeDepartures: new Map(),
  routeBoardingStops: new Map(),
  selectedBoardingStopId: null,
  selectedStopFilterId: null,
  selectedStopFilterName: null,
  suppressLensPlacementUntil: 0,
  pendingLensPlacement: null,
  selectedRouteDepartures: [],
  selectedDeparture: null,
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
  radiusButton: document.getElementById('radius-button'),
  radiusPanel: document.getElementById('radius-panel'),
  radiusValue: document.getElementById('radius-value'),
  timeFilterButton: document.getElementById('time-filter-button'),
  timeFilterPanel: document.getElementById('time-filter-panel'),
  timeFilterValue: document.getElementById('time-filter-value'),
  settingsButton: document.getElementById('settings-button'),
  settingsDialog: document.getElementById('settings-dialog'),
  settingsClose: document.getElementById('settings-close'),
  results: document.getElementById('results'),
  sheet: document.querySelector('.bottom-sheet'),
  sheetToggle: document.getElementById('sheet-toggle'),
  sheetContent: document.getElementById('sheet-content'),
  sheetCount: document.getElementById('sheet-count'),
  sheetToggleLabel: document.getElementById('sheet-toggle-label'),
  routeDetail: document.getElementById('route-detail'),
  routeDetailBack: document.getElementById('route-detail-back'),
  routeDetailBackLabel: document.getElementById('route-detail-back-label'),
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

function shiftedServiceDate(date, offset) {
  const year = Number(date.value.slice(0, 4));
  const month = Number(date.value.slice(4, 6));
  const day = Number(date.value.slice(6, 8));
  const shifted = new Date(Date.UTC(year, month - 1, day + offset, 12));
  const value = `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}${String(shifted.getUTCDate()).padStart(2, '0')}`;
  return { value, weekday: (shifted.getUTCDay() + 6) % 7 };
}

function ukClockSeconds() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
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

function serviceRunsOnDate(serviceId, date) {
  const calendar = state.routeCalendar?.c?.[serviceId];
  if (!calendar) return false;
  const [weekdayMask, startDate, endDate, addedDates = [], removedDates = []] = calendar;
  if (sortedDatesInclude(addedDates, date.value)) return true;
  if (sortedDatesInclude(removedDates, date.value)) return false;
  return Boolean(startDate && endDate && date.value >= startDate && date.value <= endDate && (weekdayMask & (1 << date.weekday)));
}

function routeIsVisible(route) {
  return (route.categories || []).every((category) => state.routeFilters[category] !== false);
}

function formatTimeWindow(minutes) {
  if (minutes === null) return 'any time';
  if (minutes < 60) return `${minutes} min`;
  if (minutes === 60) return '1 hour';
  if (minutes === 240) return '4 hours';
  if (minutes === 1440) return '1 day';
  if (minutes === 10080) return '1 week';
  return `${Math.floor(minutes / 60)} hours`;
}

function formatDepartureTime(seconds) {
  const dayOffset = Math.floor(seconds / 86400);
  const withinDay = ((seconds % 86400) + 86400) % 86400;
  const hours = Math.floor(withinDay / 3600);
  const minutes = Math.floor(withinDay % 3600 / 60);
  const dayLabel = dayOffset === 1 ? ' tomorrow' : dayOffset > 1 ? ` +${dayOffset}d` : '';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}${dayLabel}`;
}

function serviceDateDistance(fromValue, toValue) {
  const parse = (value) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)));
  return Math.floor((parse(toValue) - parse(fromValue)) / 86400000);
}

function formatWaitMinutes(departureSeconds) {
  return `${Math.max(0, Math.ceil((departureSeconds - ukClockSeconds()) / 60))} min`;
}

function journeyDirectionKey(journey) {
  if (journey.direction === 0 || journey.direction === 1) return `direction:${journey.direction}`;
  return `headsign:${String(journey.headsign || '').trim().toLocaleLowerCase('en-GB')}`;
}

async function departuresForRoutes(routes, stops, {
  windowMinutes = null,
  firstOnly = false,
  maxResults = Infinity,
  perDirection = false,
  boardingStopId = null,
  directionKey = null,
} = {}) {
  if (!routes.length || !stops.length) return new Map();
  await Promise.all([loadRouteCalendar(), loadRouteIndex()]);
  const routeIds = routes.map((route) => route.route_id);
  const journeysByRoute = await state.timetableLoader(routeIds);
  const stopNames = new Map(stops.map((stop) => [stop.id, stop.name]));
  const today = ukServiceDate();
  const now = ukClockSeconds();
  const end = windowMinutes === null ? Infinity : now + windowMinutes * 60;
  const coverageEnd = state.manifest?.route_calendar?.end_date;
  const finalDayOffset = windowMinutes === null
    ? Math.max(7, coverageEnd ? serviceDateDistance(today.value, coverageEnd) : 7)
    : Math.max(0, Math.ceil(end / 86400));
  const result = new Map();

  for (const route of routes) {
    const routeJourneys = (journeysByRoute.get(route.route_id) || [])
      .filter((journey) => !directionKey || journeyDirectionKey(journey) === directionKey);
    const journeyGroups = new Map();
    routeJourneys.forEach((journey) => {
      const key = perDirection ? journeyDirectionKey(journey) : 'all';
      if (!journeyGroups.has(key)) journeyGroups.set(key, []);
      journeyGroups.get(key).push(journey);
    });
    const routeDepartures = [];

    for (const groupJourneys of journeyGroups.values()) {
      const servedStopIds = new Set(groupJourneys.flatMap((journey) => journey.stops
        .filter((stop) => stop.pickup !== 1)
        .map((stop) => stop.id)));
      // Stops are distance-sorted. Each direction independently chooses its
      // nearest valid boarding point, so opposing stops remain separate rows.
      const pinnedStop = boardingStopId
        ? stops.find((stop) => stop.id === boardingStopId && servedStopIds.has(stop.id))
        : null;
      const selectedStop = !pinnedStop && state.selectedStopFilterId
        ? stops.find((stop) => stop.id === state.selectedStopFilterId && servedStopIds.has(stop.id))
        : null;
      const closestStop = pinnedStop || selectedStop || stops.find((stop) => servedStopIds.has(stop.id));
      if (!closestStop) continue;
      const eligibleJourneys = groupJourneys.map((journey) => ({
        journey,
        boardingPositions: journey.stops
          .map((stop, position) => ({ stop, position }))
          .filter(({ stop }) => stop.id === closestStop.id && stop.pickup !== 1),
      })).filter(({ boardingPositions }) => boardingPositions.length);
      const groupDepartures = [];
      for (let dayOffset = -1; dayOffset <= finalDayOffset; dayOffset += 1) {
        const serviceDate = shiftedServiceDate(today, dayOffset);
        for (const { journey, boardingPositions } of eligibleJourneys) {
          if (!serviceRunsOnDate(journey.serviceId, serviceDate)) continue;
          for (const start of journey.starts) {
            const boarding = boardingPositions.find(({ position }) => {
              const departure = dayOffset * 86400 + start + journey.departures[position];
              return departure >= now && departure <= end;
            });
            if (!boarding) continue;
            const departureSeconds = dayOffset * 86400 + start + journey.departures[boarding.position];
            groupDepartures.push({
              id: `${journey.groupIndex}:${dayOffset}:${start}`,
              routeId: route.route_id,
              serviceId: journey.serviceId,
              headsign: journey.headsign || routeDescription(route),
              departureSeconds,
              boardingStopId: boarding.stop.id,
              boardingStopName: stopNames.get(closestStop.id) || closestStop.name || closestStop.id,
              boardingPosition: boarding.position,
              stops: journey.stops,
              arrivals: journey.arrivals.map((offset) => dayOffset * 86400 + start + offset),
              departures: journey.departures.map((offset) => dayOffset * 86400 + start + offset),
              direction: journey.direction,
              directionKey: journeyDirectionKey(journey),
              wheelchair: journey.wheelchair,
              approximate: journey.approximate,
            });
          }
        }
        if (firstOnly && groupDepartures.length) break;
      }
      groupDepartures.sort((first, second) => first.departureSeconds - second.departureSeconds || first.headsign.localeCompare(second.headsign));
      routeDepartures.push(...groupDepartures.slice(0, firstOnly ? 1 : maxResults));
    }
    routeDepartures.sort((first, second) => first.departureSeconds - second.departureSeconds || first.headsign.localeCompare(second.headsign));
    if (routeDepartures.length) {
      state.routeBoardingStops.set(route.route_id, routeDepartures[0].boardingStopId);
      result.set(route.route_id, routeDepartures.slice(0, maxResults));
    }
  }
  return result;
}

function syncTimeFilterUi() {
  const finite = state.departureWindowMinutes !== null;
  elements.timeFilterButton.setAttribute('aria-pressed', String(finite));
  elements.timeFilterButton.setAttribute('aria-expanded', String(state.timeFilterPanelOpen));
  elements.timeFilterButton.setAttribute('aria-label', `Choose departure window, ${formatTimeWindow(state.departureWindowMinutes)}`);
  elements.timeFilterButton.title = `Leaving within ${formatTimeWindow(state.departureWindowMinutes)}`;
  elements.timeFilterPanel.hidden = !state.timeFilterPanelOpen;
  elements.timeFilterValue.value = formatTimeWindow(state.departureWindowMinutes);
  elements.timeFilterValue.textContent = formatTimeWindow(state.departureWindowMinutes);
  document.querySelectorAll('[data-departure-window]').forEach((button) => {
    const value = button.dataset.departureWindow === 'infinity' ? null : Number(button.dataset.departureWindow);
    button.classList.toggle('active', value === state.departureWindowMinutes);
  });
}

function syncRadiusUi() {
  const radiusLabel = formatDistance(state.radiusMetres);
  elements.radiusButton.setAttribute('aria-expanded', String(state.radiusPanelOpen));
  elements.radiusButton.setAttribute('aria-label', `Choose search radius, ${radiusLabel}`);
  elements.radiusButton.title = `Search radius: ${radiusLabel}`;
  elements.radiusPanel.hidden = !state.radiusPanelOpen;
  elements.radiusValue.value = radiusLabel;
  elements.radiusValue.textContent = radiusLabel;
  document.querySelectorAll('[data-radius]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.radius) === state.radiusMetres);
  });
}

function setDepartureWindow(minutes) {
  if (state.departureWindowMinutes === minutes) return;
  state.departureWindowMinutes = minutes;
  syncTimeFilterUi();
  if (state.searchedCenter) searchAt(state.searchedCenter, 'auto');
}

function syncSettingsUi() {
  document.querySelectorAll('[data-route-filter]').forEach((input) => {
    input.checked = Boolean(state.routeFilters[input.dataset.routeFilter]);
  });
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
  if (state.departureWindowMinutes !== null) {
    return state.routes.length
      ? `${state.routes.length} route${state.routes.length === 1 ? '' : 's'} leaving within ${formatTimeWindow(state.departureWindowMinutes)}${state.selectedStopFilterName ? ` from ${state.selectedStopFilterName}` : ''}`
      : `No buses leaving within ${formatTimeWindow(state.departureWindowMinutes)}${state.selectedStopFilterName ? ` from ${state.selectedStopFilterName}` : ''}`;
  }
  return state.routes.length
    ? `${state.routes.length} route${state.routes.length === 1 ? '' : 's'}${state.selectedStopFilterName ? ` from ${state.selectedStopFilterName}` : ` from ${state.nearbyStopCount || 0} nearby stop${state.nearbyStopCount === 1 ? '' : 's'}`}`
    : `No routes within ${formatDistance(state.radiusMetres)}`;
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
  state.selectedStopFilterId = null;
  state.selectedStopFilterName = null;
  state.routeBoardingStops.clear();
  highlightSelectedStop(null);
  searchAt(center, 'auto');
}

function setDirty(dirty) {
  state.dirty = dirty;
  if (dirty && !state.searching && !state.selectedRouteId) {
    elements.sheetToggleLabel.textContent = 'Updating this area…';
  }
}

function setSheetOpen(open) {
  if (!open) {
    state.routeDetailOpen = false;
    state.routeDetailLevel = 'routes';
  }
  state.sheetOpen = open;
  elements.sheet.classList.toggle('is-open', open);
  elements.sheetToggle.setAttribute('aria-expanded', String(open));
  elements.sheetContent.hidden = !open || state.routeDetailOpen;
  elements.routeDetail.hidden = !open || !state.routeDetailOpen;
}

function closeRouteDetail() {
  state.routeDetailOpen = false;
  state.routeDetailLevel = 'routes';
  state.selectedDeparture = null;
  state.selectedRouteDepartures = [];
  elements.sheetContent.hidden = !state.sheetOpen;
  elements.routeDetail.hidden = true;
  elements.sheetToggleLabel.textContent = state.routes.length
    ? `${state.routes.length} routes · tap to view`
    : 'Tap to view stops and routes';
}

function clearRouteSelection() {
  if (!state.selectedRouteId) return;
  state.selectedRouteId = null;
  highlightSelectedStop(state.selectedStopFilterId);
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

function routeDetailHeaderMarkup(route, meta = '') {
  return `<header class="route-detail-header">
    <span class="route-detail-number" style="--route-colour:${colourForNumber(routeNumber(route))}">${escapeHtml(routeNumber(route))}</span>
    <div><p class="sheet-kicker">${escapeHtml(route.operator_name || 'Unknown operator')}</p><h2>${escapeHtml(routeDescription(route))}</h2>${meta ? `<span>${escapeHtml(meta)}</span>` : ''}</div>
  </header>`;
}

function renderRouteDepartures(route, departures) {
  state.routeDetailLevel = 'departures';
  state.selectedRouteDepartures = departures;
  state.selectedDeparture = null;
  elements.routeDetailBackLabel.textContent = 'All nearby routes';
  elements.routeDetailBack.setAttribute('aria-label', 'Back to all nearby routes');
  const list = departures.length
    ? `<div class="departure-list">${departures.map((departure, index) => `
      <button class="departure-card" type="button" data-departure-index="${index}">
        <time>${escapeHtml(formatDepartureTime(departure.departureSeconds))}</time>
        <span><strong>${escapeHtml(departure.headsign)}</strong><small>From ${escapeHtml(departure.boardingStopName)}${departure.approximate ? ' · approximate' : ''}</small></span>
        <i aria-hidden="true"></i>
      </button>`).join('')}</div>`
    : '<div class="results-empty"><span class="empty-symbol">◷</span><strong>No upcoming departures</strong><p>This route has no later published journeys from the selected stop.</p></div>';
  elements.routeDetailContent.innerHTML = `
    ${routeDetailHeaderMarkup(route, departures.length ? `${departures.length} upcoming departure${departures.length === 1 ? '' : 's'}` : 'No upcoming departures')}
    ${list}`;
}

async function openRouteDepartures(route, preferredDeparture = null) {
  state.routeDetailOpen = true;
  state.routeDetailLevel = 'departures';
  const detailSequence = ++state.detailSequence;
  elements.sheetToggleLabel.textContent = `${routeNumber(route)} · ${route.operator_name || 'Unknown operator'}`;
  elements.routeDetailBackLabel.textContent = 'All nearby routes';
  elements.routeDetailContent.innerHTML = `${routeDetailHeaderMarkup(route)}<div class="detail-loading"><span></span>Loading departures…</div>`;
  setSheetOpen(true);
  try {
    const nextDeparture = preferredDeparture || state.routeDepartures.get(route.route_id)?.[0];
    const nextDepartureDay = nextDeparture ? Math.max(0, Math.floor(nextDeparture.departureSeconds / 86400)) : 7;
    const windowMinutes = Math.max(1, Math.ceil((((nextDepartureDay + 1) * 86400) - ukClockSeconds()) / 60));
    const departures = (await departuresForRoutes([route], state.nearbyStops, {
      windowMinutes,
      maxResults: 100,
      boardingStopId: nextDeparture?.boardingStopId || null,
      directionKey: nextDeparture?.directionKey || null,
    })).get(route.route_id) || [];
    if (detailSequence === state.detailSequence && state.routeDetailOpen && state.selectedRouteId === route.route_id) {
      highlightSelectedStop(nextDeparture?.boardingStopId || state.routeBoardingStops.get(route.route_id) || null);
      renderRouteDepartures(route, departures);
    }
  } catch (error) {
    console.error(error);
    if (detailSequence === state.detailSequence && state.routeDetailOpen) {
      elements.routeDetailContent.innerHTML = `${routeDetailHeaderMarkup(route)}<div class="results-empty"><strong>Departures could not be loaded</strong><p>Check your connection and try again.</p></div>`;
    }
  }
}

function stopNamesForRoute(route) {
  const names = new Map(state.nearbyStops.map((stop) => [stop.id, stop.name]));
  for (const pattern of route.stop_patterns || []) {
    for (const stop of pattern.stops || []) if (!names.has(stop.id)) names.set(stop.id, stop.name);
  }
  return names;
}

function renderDepartureStops(route, departure) {
  state.routeDetailLevel = 'stops';
  state.selectedDeparture = departure;
  elements.routeDetailBackLabel.textContent = 'Route departures';
  elements.routeDetailBack.setAttribute('aria-label', 'Back to route departures');
  const stopNames = stopNamesForRoute(route);
  const stopList = departure.stops.map((stop, index) => {
    const classes = [index === departure.boardingPosition ? 'is-boarding' : '', index < departure.boardingPosition ? 'is-before-boarding' : ''].filter(Boolean).join(' ');
    return `<li class="${classes}"><time>${escapeHtml(formatDepartureTime(departure.departures[index]))}</time><strong>${escapeHtml(stopNames.get(stop.id) || stop.id)}</strong>${index === departure.boardingPosition ? '<small>Board here</small>' : ''}</li>`;
  }).join('');
  elements.routeDetailContent.innerHTML = `
    ${routeDetailHeaderMarkup(route, `${formatDepartureTime(departure.departureSeconds)} from ${departure.boardingStopName}`)}
    <div class="journey-heading"><span>To ${escapeHtml(departure.headsign)}</span><small>${departure.stops.length} stops</small></div>
    <ol class="stop-list timed-stop-list">${stopList}</ol>`;
}

async function openDepartureStops(route, departure) {
  const detailSequence = ++state.detailSequence;
  state.routeDetailLevel = 'stops';
  elements.routeDetailContent.innerHTML = `${routeDetailHeaderMarkup(route)}<div class="detail-loading"><span></span>Loading stops…</div>`;
  try {
    await loadRouteDetails(route);
    if (detailSequence === state.detailSequence && state.routeDetailOpen && state.selectedRouteId === route.route_id) {
      renderDepartureStops(route, departure);
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
  highlightSelectedStop(state.selectedStopFilterId || state.routeBoardingStops.get(routeId) || null);
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
  if (!state.routeBoardingStops.has(routeId)) {
    departuresForRoutes([route], state.nearbyStops).then(() => {
      if (state.selectedRouteId === routeId) highlightSelectedStop(state.routeBoardingStops.get(routeId) || null);
    }).catch((error) => console.error('Could not identify the closest stop', error));
  }
  if (state.sheetOpen) {
    // The drawer is already visible, so switch its content to the exact
    // selected route without changing the drawer's open/closed state.
    openRouteDepartures(route);
  } else if (!state.sheetOpen) {
    elements.sheetToggleLabel.textContent = `${routeNumber(route)} selected · tap to view`;
  }
}

function updateSheetSummary(stops, routes) {
  const serviceCount = routes.reduce((count, route) => count + Math.max(1, state.routeDepartures.get(route.route_id)?.length || 0), 0);
  if (routes.length) {
    if (state.departureWindowMinutes !== null) {
      elements.sheetCount.textContent = `${serviceCount} service${serviceCount === 1 ? '' : 's'} leaving soon`;
      elements.sheetToggleLabel.textContent = state.selectedStopFilterName
        ? `From ${state.selectedStopFilterName}`
        : `Leaving within ${formatTimeWindow(state.departureWindowMinutes)}`;
    } else {
      elements.sheetCount.textContent = `${serviceCount} nearby service${serviceCount === 1 ? '' : 's'}`;
      elements.sheetToggleLabel.textContent = state.selectedStopFilterName
        ? `From ${state.selectedStopFilterName}`
        : '';
    }
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
      pane: 'routeLabelsPane',
      interactive: true,
      bubblingMouseEvents: false,
      keyboard: true,
      title: `Route ${routeNumber(route)}`,
      routeId: route.route_id,
    });
    marker.on('click', (event) => {
      consumeFeatureClick(event);
      selectRouteFromMap(route.route_id);
    });
    marker.on('add', () => {
      const element = marker.getElement();
      if (!element) return;
      element.style.marginLeft = `${-element.offsetWidth / 2}px`;
      element.style.marginTop = `${-element.offsetHeight}px`;
    });
    marker.addTo(state.labelsLayer);
  }
}

function consumeFeatureClick(event) {
  const originalEvent = event.originalEvent || event;
  if (state.pendingLensPlacement) {
    clearTimeout(state.pendingLensPlacement);
    state.pendingLensPlacement = null;
  }
  // Leaflet's canvas renderer can emit the layer and map clicks as separate
  // framework events. A short time guard covers both possible event orders
  // without affecting the next deliberate map click.
  state.suppressLensPlacementUntil = performance.now() + 150;
  originalEvent._busLensFeatureClick = true;
  L.DomEvent.stopPropagation(originalEvent);
}

function highlightSelectedStop(stopId) {
  state.selectedBoardingStopId = stopId;
  state.stopMarkers.forEach((marker, markerStopId) => {
    const selected = markerStopId === stopId;
    marker.setRadius(selected ? 9 : 5);
    marker.setStyle({
      weight: selected ? 3 : 1.5,
      color: selected ? '#fff' : '#163e35',
      fillColor: selected ? '#176b52' : '#f6bd45',
      fillOpacity: 1,
    });
    if (selected) marker.bringToFront();
  });
}

function selectStop(stop) {
  const clearing = state.selectedStopFilterId === stop.id;
  state.selectedStopFilterId = clearing ? null : stop.id;
  state.selectedStopFilterName = clearing ? null : stop.name;
  state.routeBoardingStops.clear();
  if (state.selectedRouteId) clearRouteSelection();
  else highlightSelectedStop(state.selectedStopFilterId);
  if (state.searchedCenter) searchAt(state.searchedCenter, 'auto');
}

function renderStops(stops) {
  state.stopsLayer?.remove();
  state.stopsLayer = L.layerGroup();
  state.stopMarkers = new Map();
  stops.forEach((stop) => {
    const selected = stop.id === state.selectedBoardingStopId;
    const marker = L.circleMarker([stop.lat, stop.lon], {
      pane: 'stopsPane',
      renderer: state.stopRenderer,
      bubblingMouseEvents: false,
      radius: selected ? 9 : 5,
      weight: selected ? 3 : 1.5,
      color: selected ? '#fff' : '#163e35',
      fillColor: selected ? '#176b52' : '#f6bd45',
      fillOpacity: 1,
    }).bindTooltip(`<strong>${escapeHtml(stop.name)}</strong><small>Bus stop · ${formatDistance(stop.distance)} away · ${stop.route_ids.length} routes · tap to select</small>`, { className: 'stop-tooltip', direction: 'top', offset: [0, -5] });
    marker.on('click', (event) => {
      consumeFeatureClick(event);
      selectStop(stop);
    });
    state.stopMarkers.set(stop.id, marker);
    marker.addTo(state.stopsLayer);
  });
  state.stopsLayer.addTo(state.map);
}

function renderResults(stops, routes) {
  state.routes = routes;
  state.routesById = new Map(routes.map((route) => [route.route_id, route]));
  state.selectedRouteId = null;
  updateSheetSummary(stops, routes);
  if (!routes.length && state.departureWindowMinutes !== null && state.rawRoutes.length) {
    elements.results.innerHTML = `<div class="results-empty"><span class="empty-symbol">◷</span><strong>No buses leaving within ${escapeHtml(formatTimeWindow(state.departureWindowMinutes))}</strong><p>Increase the time window or choose “Any time” to see every scheduled route.</p></div>`;
    return;
  }
  if (!routes.length && state.selectedStopFilterName && state.rawRoutes.length) {
    elements.results.innerHTML = `<div class="results-empty"><span class="empty-symbol">⌖</span><strong>No included routes from ${escapeHtml(state.selectedStopFilterName)}</strong><p>Tap the selected stop again to show all nearby stops and routes.</p></div>`;
    return;
  }
  if (!routes.length && state.rawRoutes.length) {
    elements.results.innerHTML = `<div class="results-empty"><span class="empty-symbol">⌕</span><strong>No included routes within ${formatDistance(state.radiusMetres)}</strong><p>Optional route types are hidden. Use route settings to include them.</p></div>`;
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
  const stopNames = new Map(state.nearbyStops.map((stop) => [stop.id, stop.name]));
  const boardEntries = routes.flatMap((route) => {
    const departures = state.routeDepartures.get(route.route_id) || [];
    if (!departures.length) return [{ route, departure: null, departureIndex: null }];
    return departures.map((departure, departureIndex) => ({ route, departure, departureIndex }));
  }).sort((first, second) => {
    const firstTime = first.departure?.departureSeconds ?? Infinity;
    const secondTime = second.departure?.departureSeconds ?? Infinity;
    return firstTime - secondTime || routeNumber(first.route).localeCompare(routeNumber(second.route), undefined, { numeric: true });
  });
  elements.results.innerHTML = `<div class="route-groups"><section class="route-group">${boardEntries.map(({ route, departure, departureIndex }) => {
    const boardingStopId = departure?.boardingStopId || state.routeBoardingStops.get(route.route_id);
    const boardingStopName = departure?.boardingStopName || stopNames.get(boardingStopId) || 'Nearest served stop';
    const destination = departure?.headsign ? `To ${departure.headsign}` : routeDescription(route);
    const wait = departure ? formatWaitMinutes(departure.departureSeconds) : 'No timetable';
    const departureAttribute = departureIndex === null ? '' : ` data-route-departure-index="${departureIndex}"`;
    return `<button class="route-card" type="button" data-route-id="${escapeHtml(route.route_id)}"${departureAttribute}><span class="route-number" style="--route-colour:${colourForNumber(routeNumber(route))}">${escapeHtml(routeNumber(route))}</span><span class="route-card-copy"><strong>${escapeHtml(boardingStopName)}</strong><small>${escapeHtml(destination)}</small></span><span class="route-wait${departure ? '' : ' is-unavailable'}">${escapeHtml(wait)}</span></button>`;
  }).join('')}</section></div>`;
}

function renderRouteGeometry(routes) {
  state.routeLayer?.remove();
  const routeCollection = { type: 'FeatureCollection', features: routeFeatures(routes) };
  state.routeLayer = L.geoJSON(routeCollection, {
    renderer: state.routeRenderer,
    bubblingMouseEvents: false,
    style: (feature) => routeStyle(feature),
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(`<strong>Route ${escapeHtml(feature.properties.route_number)}</strong><small>${escapeHtml(feature.properties.operator_name)}</small>`, { className: 'route-tooltip', sticky: true, direction: 'top' });
      layer.on('click', (event) => {
        consumeFeatureClick(event);
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
    let selectedStop = state.selectedStopFilterId
      ? stops.find((stop) => stop.id === state.selectedStopFilterId)
      : null;
    if (state.selectedStopFilterId && !selectedStop) {
      state.selectedStopFilterId = null;
      state.selectedStopFilterName = null;
      state.routeBoardingStops.clear();
      highlightSelectedStop(null);
      selectedStop = null;
    }
    const routeIds = [...new Set(stops.flatMap((stop) => stop.route_ids))].sort();
    const sourceRouteSignature = routeIds.join('|');
    const sourceRoutesChanged = sourceRouteSignature !== state.sourceRouteSignature;
    const rawRoutes = sourceRoutesChanged ? await loadRoutes(routeIds) : state.rawRoutes;
    await loadRouteCalendar();
    if (requestSequence !== state.searchSequence) return;
    const scheduledRoutes = rawRoutes.filter((route) => routeIsVisible(route));
    const selectedStopRouteIds = selectedStop ? new Set(selectedStop.route_ids) : null;
    const stopFilteredRoutes = selectedStopRouteIds
      ? scheduledRoutes.filter((route) => selectedStopRouteIds.has(route.route_id))
      : scheduledRoutes;
    state.routeBoardingStops.clear();
    stopFilteredRoutes.forEach((route) => {
      const closestMappedStop = stops.find((stop) => stop.route_ids.includes(route.route_id));
      if (closestMappedStop) state.routeBoardingStops.set(route.route_id, closestMappedStop.id);
    });
    const routeDepartures = await departuresForRoutes(stopFilteredRoutes, stops, {
      windowMinutes: state.departureWindowMinutes,
      firstOnly: true,
      perDirection: true,
    });
    if (requestSequence !== state.searchSequence) return;
    const routes = state.departureWindowMinutes !== null
      ? stopFilteredRoutes.filter((route) => routeDepartures.has(route.route_id))
      : stopFilteredRoutes;
    routes.sort((first, second) => {
      const firstDeparture = routeDepartures.get(first.route_id)?.[0]?.departureSeconds ?? Infinity;
      const secondDeparture = routeDepartures.get(second.route_id)?.[0]?.departureSeconds ?? Infinity;
      return firstDeparture - secondDeparture || routeNumber(first).localeCompare(routeNumber(second), undefined, { numeric: true });
    });
    const visibleRouteIds = new Set(routes.map((route) => route.route_id));
    const visibleStops = stops
      .map((stop) => ({ ...stop, route_ids: stop.route_ids.filter((routeId) => visibleRouteIds.has(routeId)) }))
      .filter((stop) => stop.route_ids.length);
    const routeSignature = routes.map((route) => route.route_id).sort().join('|');
    const routesChanged = routeSignature !== state.routeSignature;
    state.rawRoutes = rawRoutes;
    state.nearbyStops = stops;
    state.routeDepartures = routeDepartures;
    state.sourceRouteSignature = sourceRouteSignature;
    state.searchedCenter = [center[0], center[1]];
    if (state.searchCircle) state.searchCircle.setLatLng(center).setRadius(radiusMetres);
    else state.searchCircle = L.circle(center, { radius: radiusMetres, color: '#176b52', weight: 1.25, fillColor: '#176b52', fillOpacity: 0.055, interactive: false }).addTo(state.map);
    if (state.searchMarker) state.searchMarker.setLatLng(center);
    else state.searchMarker = L.circleMarker(center, { radius: 5, color: '#fff', weight: 2.5, fillColor: '#176b52', fillOpacity: 1, interactive: false }).addTo(state.map);
    renderStops(visibleStops);
    if (routesChanged) renderRouteGeometry(routes);
    renderResults(visibleStops, routes);
    state.routeSignature = routeSignature;
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
  state.selectedStopFilterId = null;
  state.selectedStopFilterName = null;
  state.routeBoardingStops.clear();
  highlightSelectedStop(null);
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
  state.timetableLoader = createTimetableLoader(DATA_BASE, routeChunkName);
  state.stopTileKeys = new Set(state.manifest.stop_tiles || []);
  // Start the small spatial route index immediately. It will normally be in
  // memory before geolocation resolves or the user finishes their first pan.
  loadRouteIndex().catch((error) => console.error('Could not warm route index', error));
  state.map = L.map('map', { zoomControl: false, preferCanvas: true }).setView(DEFAULT_VIEW, DEFAULT_ZOOM);
  state.map.createPane('routesPane').style.zIndex = '410';
  state.map.createPane('routeLabelsPane').style.zIndex = '420';
  state.map.createPane('stopsPane').style.zIndex = '430';
  state.routeRenderer = L.canvas({ pane: 'routesPane', padding: 0.5, tolerance: 12 });
  state.stopRenderer = L.svg({ pane: 'stopsPane', padding: 0.5 });
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
    if (performance.now() < state.suppressLensPlacementUntil || event.originalEvent?._busLensFeatureClick) return;
    state.radiusPanelOpen = false;
    state.timeFilterPanelOpen = false;
    syncRadiusUi();
    syncTimeFilterUi();
    const center = [event.latlng.lat, event.latlng.lng];
    if (state.pendingLensPlacement) clearTimeout(state.pendingLensPlacement);
    state.pendingLensPlacement = setTimeout(() => {
      state.pendingLensPlacement = null;
      placeLensAt(center);
    }, 0);
  });
  elements.locationButton.addEventListener('click', requestLocation);
  elements.followButton.addEventListener('click', () => setFollowMapCenter(!state.followMapCenter));
  elements.radiusButton.addEventListener('click', () => {
    state.radiusPanelOpen = !state.radiusPanelOpen;
    state.timeFilterPanelOpen = false;
    syncRadiusUi();
    syncTimeFilterUi();
  });
  elements.timeFilterButton.addEventListener('click', () => {
    state.timeFilterPanelOpen = !state.timeFilterPanelOpen;
    state.radiusPanelOpen = false;
    syncRadiusUi();
    syncTimeFilterUi();
  });
  document.querySelectorAll('[data-departure-window]').forEach((button) => button.addEventListener('click', () => {
    const minutes = button.dataset.departureWindow === 'infinity' ? null : Number(button.dataset.departureWindow);
    state.timeFilterPanelOpen = false;
    syncTimeFilterUi();
    setDepartureWindow(minutes);
  }));
  elements.settingsButton.addEventListener('click', () => {
    state.radiusPanelOpen = false;
    state.timeFilterPanelOpen = false;
    syncRadiusUi();
    syncTimeFilterUi();
    elements.settingsDialog.showModal();
  });
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
    const departureIndex = card.dataset.routeDepartureIndex === undefined
      ? null
      : Number(card.dataset.routeDepartureIndex);
    const preferredDeparture = departureIndex === null
      ? null
      : state.routeDepartures.get(route.route_id)?.[departureIndex] || null;
    highlightRoute(route.route_id);
    openRouteDepartures(route, preferredDeparture);
  });
  elements.routeDetailContent.addEventListener('click', (event) => {
    const card = event.target.closest('[data-departure-index]');
    if (!card || state.routeDetailLevel !== 'departures') return;
    const route = state.routesById.get(state.selectedRouteId);
    const departure = state.selectedRouteDepartures[Number(card.dataset.departureIndex)];
    if (route && departure) openDepartureStops(route, departure);
  });
  elements.sheetToggle.addEventListener('click', () => {
    const opening = !state.sheetOpen;
    if (opening && state.selectedRouteId) {
      const route = state.routesById.get(state.selectedRouteId);
      if (route) {
        openRouteDepartures(route);
        return;
      }
    }
    setSheetOpen(opening);
  });
  let sheetTouchStartY = null;
  let sheetTouchStartScrollTop = 0;
  elements.sheet.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    sheetTouchStartY = event.touches[0].clientY;
    sheetTouchStartScrollTop = elements.sheet.scrollTop;
  }, { passive: true });
  elements.sheet.addEventListener('touchend', (event) => {
    if (sheetTouchStartY === null || !event.changedTouches.length) return;
    const distance = event.changedTouches[0].clientY - sheetTouchStartY;
    if (distance < -45 && !state.sheetOpen) setSheetOpen(true);
    else if (distance > 45 && state.sheetOpen && sheetTouchStartScrollTop <= 1) setSheetOpen(false);
    sheetTouchStartY = null;
  }, { passive: true });
  elements.sheet.addEventListener('touchcancel', () => {
    sheetTouchStartY = null;
  }, { passive: true });
  elements.routeDetailBack.addEventListener('click', () => {
    if (state.routeDetailLevel === 'stops') {
      const route = state.routesById.get(state.selectedRouteId);
      if (route) renderRouteDepartures(route, state.selectedRouteDepartures);
      return;
    }
    closeRouteDetail();
    setSheetOpen(true);
  });
  document.querySelectorAll('[data-radius]').forEach((button) => button.addEventListener('click', () => {
    state.radiusMetres = Number(button.dataset.radius);
    state.radiusPanelOpen = false;
    syncRadiusUi();
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
  syncTimeFilterUi();
  syncRadiusUi();
  setInterval(() => {
    if (state.searchedCenter && !state.searching && !state.selectedRouteId) {
      searchAt(state.searchedCenter, 'auto');
    }
  }, 60000);
  searchAt(DEFAULT_VIEW, 'auto');
  setStatus('Finding your location…', 'working');
  requestLocation();
}

init().catch((error) => {
  console.error(error);
  setStatus('Route data is not ready — run the data build first', 'error');
});
