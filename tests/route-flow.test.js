import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DASH_LENGTH, DASH_SPACING, FLOW_SPEED, offsetLine, directionArrows, flowOffset } from '../src/route-flow-geometry.js';

test('opposing shapes are separated onto the left side of travel', () => {
  assert.deepEqual(offsetLine([{ x: 0, y: 0 }, { x: 100, y: 0 }]), [{ x: 0, y: -3 }, { x: 100, y: -3 }]);
  assert.deepEqual(offsetLine([{ x: 100, y: 0 }, { x: 0, y: 0 }]), [{ x: 100, y: 3 }, { x: 0, y: 3 }]);
});
test('duplicates, sharp bends and reversals never create spikes or NaN', () => {
  const points = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }];
  const result = offsetLine(points);
  assert.equal(result.length, 3);
  assert.ok(result.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.y) <= 6));
});
test('phase advances towards the end and wraps without a jump', () => {
  assert.equal(DASH_LENGTH, 9);
  assert.equal(flowOffset(100), -0.8);
  assert.ok(Math.abs(flowOffset(DASH_SPACING * 1000 / FLOW_SPEED)) < 1e-10);
  const arrows = directionArrows([{ x: 200, y: 0 }, { x: 0, y: 0 }]);
  assert.deepEqual(arrows.map(a => a.x), [150, 50]);
  assert.ok(arrows.every(a => a.angle === Math.PI));
});

function rendererHarness() {
  let built = 0;
  const frames = new Map();
  let id = 0;
  const request = fn => { frames.set(++id, fn); return id; };
  const preference = { matches: false, addEventListener() {}, removeEventListener() {} };
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const base = { onAdd() {}, onRemove() {}, _extendRedrawBounds() {} };
  const L = { Canvas: { prototype: base, extend: methods => methods }, Util: { requestAnimFrame: (fn, ctx) => request(fn.bind(ctx)) } };
  class Path2D { constructor() { built++; } moveTo() {} lineTo() {} }
  const context = vm.createContext({ L, Path2D, DASH_LENGTH, DASH_SPACING, FLOW_SPEED, offsetLine, directionArrows, flowOffset, WeakMap, Math, window: { matchMedia: () => preference }, document, requestAnimationFrame: request, cancelAnimationFrame: id => frames.delete(id) });
  const source = readFileSync(new URL('../src/route-flow-renderer.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export const RouteFlowRenderer =', 'this.renderer =');
  vm.runInContext(source, context);
  const r = context.renderer;
  const map = { on() {}, off() {} };
  r._map = map;
  r._drawFirst = { layer: { options: { routeFlow: true } }, next: null };
  r._redraw = () => { r._redrawRequest = null; };
  r.onAdd(map);
  r._drawing = true;
  const strokes = [];
  r._ctx = { save() {}, restore() {}, setLineDash() {}, stroke(path) { strokes.push({ path, phase: this.lineDashOffset }); } };
  return { r, strokes, preference, document, frames, built: () => built };
}
test('animation reuses paths; projection change invalidates cache; reduced motion includes arrows', () => {
  const h = rendererHarness();
  const layer = { _parts: [[{ x: 0, y: 0 }, { x: 200, y: 0 }]], options: { color: 'green', weight: 3.5, opacity: .84, routeFlow: true } };
  h.r._updatePoly(layer, false);
  h.r._flowPhase = 100;
  h.r._updatePoly(layer, false);
  assert.equal(h.built(), 2);
  assert.equal(h.strokes[0].path, h.strokes[1].path);
  assert.equal(h.strokes[1].phase, -0.8);
  layer._parts = [[{ x: 0, y: 0 }, { x: 400, y: 0 }]];
  h.r._updatePoly(layer, false);
  assert.equal(h.built(), 4);
  h.preference.matches = true;
  h.r._updatePoly(layer, false);
  assert.equal(h.strokes.length, 5);
  assert.equal(h.strokes[3].phase, 0);
});
test('animation cancels while hidden, moving, reduced-motion or removed', () => {
  const h = rendererHarness();
  h.document.hidden = true; h.r._syncFlow();
  assert.equal(h.r._flowFrame, null);
  h.document.hidden = false; h.r._syncFlow();
  assert.ok(h.r._flowFrame);
  h.r._flowStart(); assert.equal(h.r._flowFrame, null);
  h.r._flowEnd(); assert.ok(h.r._flowFrame);
  h.preference.matches = true; h.r._syncFlow(); assert.equal(h.r._flowFrame, null);
  h.preference.matches = false; h.r._syncFlow();
  const frame = h.r._flowFrame;
  h.r.onRemove(h.r._map);
  assert.equal(h.frames.has(frame), false);
});
