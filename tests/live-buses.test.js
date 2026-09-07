import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { MAX_AGE_MS, MAX_BUSES, normaliseBuses, vehicleUrl } from '../src/live-bus-data.js';

function setup() {
  const element = () => ({ textContent: '', dataset: {}, style: {}, classList: { add() {}, toggle() {} }, setAttribute(key, value) { this[key] = value; }, append() {}, addEventListener(key, fn) { this[key] = fn; }, removeEventListener() {} });
  const button = element();
  const status = element();
  const document = { hidden: false, createElement: element, getElementById: id => id === 'live-buses-toggle' ? button : status, addEventListener(key, fn) { this[key] = fn; }, removeEventListener() {} };
  const timers = new Map();
  const requests = [];
  const active = new Set();
  const bounds = { contains: () => true, getWest: () => -1.3, getEast: () => -1.2, getSouth: () => 51.7, getNorth: () => 51.8 };
  const map = { zoom: 14, handlers: {}, attributionControl: { addAttribution() {} }, getZoom() { return this.zoom; }, getBounds: () => bounds, on(key, fn) { this.handlers[key] = fn; }, once() {} };
  const layer = { addTo() { return this; }, clearLayers() { active.clear(); }, removeLayer(marker) { active.delete(marker); } };
  const L = { layerGroup: () => layer, divIcon: options => options, marker: latlng => ({ latlng, addTo() { active.add(this); return this; }, bindPopup() {}, setLatLng(value) { this.latlng = value; }, getElement: element, isPopupOpen: () => false }) };
  let id = 0;
  const context = vm.createContext({ L, MAX_AGE_MS, MAX_BUSES, normaliseBuses, vehicleUrl, document, AbortController, Date, console, setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(key) { timers.delete(key); }, fetch(url, options) { return new Promise(resolve => requests.push({ url, options, resolve })); } });
  const source = readFileSync(new URL('../src/live-buses.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
  vm.runInContext(`${source}\nthis.install = installLiveBuses;`, context);
  context.install(map);
  const run = delay => { const [key, timer] = [...timers].find(([, item]) => item.delay === delay); timers.delete(key); return timer.fn(); };
  const respond = (request, payload) => request.resolve({ ok: true, headers: { get: () => null }, json: async () => payload });
  return { button, status, document, map, timers, requests, active, run, respond };
}
const bus = () => ({ id: 1, coordinates: [-1.25, 51.75], datetime: new Date().toISOString(), service: { line_name: '8' } });

test('reuses vehicle markers, removes departed buses and schedules a single refresh', async () => {
  const s = setup();
  const first = s.run(300);
  s.respond(s.requests[0], [bus()]); await first;
  const marker = [...s.active][0];
  assert.equal(s.status.textContent, '1 live bus');
  const second = s.run(15000);
  s.respond(s.requests[1], [{ ...bus(), coordinates: [-1.24, 51.76] }]); await second;
  assert.equal([...s.active][0], marker);
  assert.deepEqual(marker.latlng, [51.76, -1.24]);
  const third = s.run(15000);
  s.respond(s.requests[2], []); await third;
  assert.equal(s.active.size, 0);
  assert.equal(s.timers.size, 1);
});

test('disabling aborts in-flight work and ignores its late response', async () => {
  const s = setup();
  const pending = s.run(300);
  s.button.click();
  assert.equal(s.requests[0].options.signal.aborted, true);
  s.respond(s.requests[0], [bus()]); await pending;
  assert.equal(s.active.size, 0);
  assert.equal(s.timers.size, 0);
  assert.equal(s.status.textContent, 'Live buses off');
});

test('hidden tabs and wide views stop polling, returning resumes it', () => {
  const s = setup();
  s.document.hidden = true; s.document.visibilitychange();
  assert.equal(s.timers.size, 0);
  s.document.hidden = false; s.document.visibilitychange();
  assert.equal(s.timers.size, 1);
  s.map.zoom = 11; s.map.handlers.moveend();
  assert.equal(s.timers.size, 0);
  assert.equal(s.status.textContent, 'Zoom in for live buses');
});

test('failed feed reports unavailable and backs off', async () => {
  const s = setup();
  const pending = s.run(300);
  s.requests[0].resolve({ ok: false, status: 503 }); await pending;
  assert.match(s.status.textContent, /unavailable/);
  assert.equal([...s.timers.values()][0].delay, 30000);
});
