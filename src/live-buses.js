import L from 'leaflet';
import { MAX_AGE_MS, MAX_BUSES, buildRouteSegments, isNearRoutePaths, normaliseBuses, vehicleUrl } from './live-bus-data.js';

const REFRESH_MS = 15_000;
const MIN_ZOOM = 12;

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

export function installLiveBuses(map, getVisibleRoutes = null) {
  const button = document.getElementById('live-buses-toggle');
  const status = document.getElementById('live-buses-status');
  const markers = new Map();
  const layer = L.layerGroup().addTo(map);
  let enabled = true;
  let timer;
  let controller;
  let generation = 0;
  let failures = 0;
  let clockOffset = 0;
  let routeSource = null;
  let routeSegments = null;
  const now = () => Date.now() + clockOffset;
  map.attributionControl.addAttribution('Live buses: <a href="https://bustimes.org">bustimes.org</a>');

  function setStatus(text, tone = '') {
    status.textContent = text;
    button.dataset.tone = tone;
  }

  function clear() {
    layer.clearLayers();
    markers.clear();
  }

  function displayedRouteSegments() {
    if (!getVisibleRoutes) return null;
    const routes = getVisibleRoutes() || [];
    if (routes !== routeSource) {
      routeSource = routes;
      routeSegments = buildRouteSegments(routes);
    }
    return routeSegments;
  }

  function cancel() {
    clearTimeout(timer);
    generation += 1;
    controller?.abort();
  }

  function prune() {
    const segments = displayedRouteSegments();
    for (const [id, entry] of markers) {
      if (now() - entry.bus.timestamp > MAX_AGE_MS || !map.getBounds().contains(entry.bus.latlng)
        || (segments && !isNearRoutePaths(entry.bus.latlng, segments))) {
        layer.removeLayer(entry.marker);
        markers.delete(id);
      }
    }
  }

  function popup(bus) {
    const content = node('div', 'live-bus-popup');
    content.append(node('strong', '', `${bus.line} → ${bus.destination}`));
    content.append(node('span', '', bus.name));
    const minutes = Math.floor(Math.max(0, now() - bus.timestamp) / 60_000);
    content.append(node('small', '', minutes ? `Position reported ${minutes} min ago` : 'Position reported less than a minute ago'));
    return content;
  }

  function reconcile(buses) {
    const ids = new Set(buses.map(bus => bus.id));
    for (const [id, entry] of markers) {
      if (!ids.has(id)) {
        layer.removeLayer(entry.marker);
        markers.delete(id);
      }
    }
    for (const bus of buses) {
      let entry = markers.get(bus.id);
      if (!entry) {
        const body = node('div', 'live-bus-body');
        const arrow = node('span', 'live-bus-heading');
        const label = node('span', 'live-bus-number');
        body.append(arrow, label);
        const marker = L.marker(bus.latlng, {
          icon: L.divIcon({ className: 'live-bus-marker', html: body, iconSize: [44, 36], iconAnchor: [22, 18] }),
          zIndexOffset: 1000, keyboard: true, bubblingMouseEvents: false,
        }).addTo(layer);
        entry = { marker, body, arrow, label, bus };
        marker.bindPopup(() => popup(entry.bus), { className: 'live-bus-popup-container', autoPan: false });
        markers.set(bus.id, entry);
      }
      entry.bus = bus;
      entry.marker.setLatLng(bus.latlng);
      entry.label.textContent = bus.line;
      entry.arrow.hidden = bus.heading === null;
      entry.arrow.style.transform = `rotate(${bus.heading || 0}deg)`;
      entry.body.classList.toggle('is-old', now() - bus.timestamp > 90_000);
      const element = entry.marker.getElement();
      element.setAttribute('aria-label', `${bus.line} to ${bus.destination}. Open live bus details`);
      element.title = `${bus.line} → ${bus.destination}`;
      if (entry.marker.isPopupOpen()) entry.marker.setPopupContent(popup(bus));
    }
  }

  async function refresh() {
    cancel();
    if (!enabled || document.hidden || map.getZoom() < MIN_ZOOM) return;
    const segments = displayedRouteSegments();
    if (segments && !segments.length) {
      clear();
      setStatus('Waiting for visible routes');
      return;
    }
    const requestGeneration = generation;
    controller = new AbortController();
    const requestController = controller;
    const timeout = setTimeout(() => requestController.abort(), 10_000);
    prune();
    if (!markers.size) setStatus('Finding buses…', 'loading');
    try {
      const response = await fetch(vehicleUrl(map.getBounds()), { signal: requestController.signal, credentials: 'omit' });
      if (!response.ok) throw new Error(`Vehicle feed: ${response.status}`);
      const payload = await response.json();
      if (requestGeneration !== generation) return;
      const serverTime = Date.parse(response.headers.get('date'));
      if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
      const buses = normaliseBuses(payload, now()).filter(bus => map.getBounds().contains(bus.latlng)
        && (!segments || isNearRoutePaths(bus.latlng, segments)));
      reconcile(buses.slice(0, MAX_BUSES));
      failures = 0;
      setStatus(buses.length > MAX_BUSES ? '500+ buses · zoom in' : buses.length ? `${buses.length} live bus${buses.length === 1 ? '' : 'es'}` : 'No live buses on shown routes');
    } catch {
      if (requestGeneration !== generation) return;
      failures += 1;
      prune();
      for (const entry of markers.values()) entry.body.classList.add('is-old');
      setStatus(markers.size ? 'Updates delayed · retrying' : 'Live buses unavailable · retrying', 'error');
    } finally {
      clearTimeout(timeout);
      if (requestGeneration === generation) timer = setTimeout(refresh, Math.min(REFRESH_MS * 2 ** failures, 120_000));
    }
  }

  function schedule() {
    cancel();
    prune();
    if (!enabled) { clear(); setStatus('Live buses off'); return; }
    if (document.hidden) { setStatus('Live buses paused'); return; }
    if (map.getZoom() < MIN_ZOOM) { clear(); setStatus('Zoom in for live buses'); return; }
    timer = setTimeout(refresh, 300);
  }

  function updateRoutes() {
    routeSource = null;
    schedule();
  }

  function toggle() {
    enabled = !enabled;
    button.setAttribute('aria-pressed', String(enabled));
    schedule();
  }
  button.addEventListener('click', toggle);
  map.on('movestart', cancel);
  map.on('moveend', schedule);
  document.addEventListener('visibilitychange', schedule);
  map.once('unload', () => {
    cancel();
    document.removeEventListener('visibilitychange', schedule);
    button.removeEventListener('click', toggle);
  });
  schedule();
  return { updateRoutes };
}
