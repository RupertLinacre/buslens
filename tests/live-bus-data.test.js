import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseBuses, vehicleUrl, MAX_AGE_MS } from '../src/live-bus-data.js';
const now = Date.parse('2026-09-07T08:00:00Z');
const bus = { id: 1, coordinates: [-0.4, 51.66], datetime: new Date(now - 20_000).toISOString(), heading: 370, service: { line_name: '258' } };
test('converts longitude/latitude, normalises headings and supplies missing details', () => {
  const [result] = normaliseBuses([bus], now);
  assert.deepEqual(result.latlng, [51.66, -0.4]);
  assert.equal(result.heading, 10);
  assert.equal(result.line, '258');
  assert.equal(result.destination, 'Destination unavailable');
});
test('discards stale, future, malformed and invalid coordinates', () => {
  const invalid = [null, {}, { ...bus, coordinates: ['-0.4', 51] }, { ...bus, coordinates: [0, 91] }, { ...bus, datetime: 'bad' }, { ...bus, datetime: new Date(now - MAX_AGE_MS - 1).toISOString() }, { ...bus, datetime: new Date(now + 61_000).toISOString() }];
  assert.deepEqual(normaliseBuses(invalid, now), []);
  assert.throws(() => normaliseBuses({ error: true }, now));
});
test('keeps latest position for duplicate vehicles', () => {
  const latest = { ...bus, coordinates: [-0.41, 51.67], datetime: new Date(now).toISOString() };
  assert.deepEqual(normaliseBuses([latest, bus], now)[0].latlng, [51.67, -0.41]);
});
test('always requests a bounded area', () => {
  const url = new URL(vehicleUrl({ getWest: () => -0.43, getEast: () => -0.37, getSouth: () => 51.64, getNorth: () => 51.69 }));
  assert.deepEqual(Object.fromEntries(url.searchParams), { xmin: '-0.43000', ymin: '51.64000', xmax: '-0.37000', ymax: '51.69000' });
});
