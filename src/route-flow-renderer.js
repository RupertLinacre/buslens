import L from 'leaflet';
import { DASH_LENGTH, DASH_SPACING, FLOW_SPEED, offsetLine, directionArrows, flowOffset } from './route-flow-geometry.js';

// Leaflet 1.9 Canvas extension: keep its clipping, hit testing, stacking and
// projection lifecycle; cache only the painted paths between map movements.
export const RouteFlowRenderer = L.Canvas.extend({
  onAdd(map) {
    this._flowCache = new WeakMap();
    this._flowPhase = 0;
    this._flowMoving = false;
    this._motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._syncFlow = this._syncFlow.bind(this);
    this._flowStart = () => { this._flowMoving = true; this._syncFlow(); };
    this._flowEnd = () => { this._flowMoving = false; this._syncFlow(); };
    L.Canvas.prototype.onAdd.call(this, map);
    map.on('movestart zoomstart', this._flowStart);
    map.on('moveend zoomend', this._flowEnd);
    document.addEventListener('visibilitychange', this._syncFlow);
    this._motionPreference.addEventListener('change', this._syncFlow);
    this._syncFlow();
  },

  onRemove(map) {
    cancelAnimationFrame(this._flowFrame);
    map.off('movestart zoomstart', this._flowStart);
    map.off('moveend zoomend', this._flowEnd);
    document.removeEventListener('visibilitychange', this._syncFlow);
    this._motionPreference.removeEventListener('change', this._syncFlow);
    L.Canvas.prototype.onRemove.call(this, map);
  },

  _addPath(layer) {
    L.Canvas.prototype._addPath.call(this, layer);
    if (!this._flowFrame) this._syncFlow();
  },

  syncFlow() {
    this._syncFlow();
  },

  _hasFlowPaths() {
    for (let order = this._drawFirst; order; order = order.next) {
      if (order.layer?.options?.routeFlow) return true;
    }
    return false;
  },

  _queueFlowRedraw() {
    this._redrawBounds = null;
    this._redrawRequest = this._redrawRequest || L.Util.requestAnimFrame(this._redraw, this);
  },

  _extendRedrawBounds(layer) {
    // Include the offset lanes and static arrowheads in partial style redraws.
    L.Canvas.prototype._extendRedrawBounds.call(this, {
      _pxBounds: layer._pxBounds,
      options: { weight: (layer.options.weight || 0) + 6 },
    });
  },

  _syncFlow() {
    cancelAnimationFrame(this._flowFrame);
    this._flowFrame = null;
    if (!this._map || document.hidden || this._flowMoving) return;
    this._queueFlowRedraw();
    if (this._motionPreference.matches || !this._hasFlowPaths()) return;
    this._flowLastTime = null;
    const tick = (time) => {
      if (!this._hasFlowPaths()) { this._flowFrame = null; return; }
      this._flowFrame = requestAnimationFrame(tick);
      if (this._flowLastTime === null) this._flowLastTime = time;
      const elapsed = time - this._flowLastTime;
      // A single 30fps loop for every route; no geometry work in animation frames.
      if (elapsed < 1000 / 30) return;
      this._flowLastTime = time;
      this._flowPhase = (this._flowPhase + Math.min(elapsed, 100)) % (DASH_SPACING * 1000 / FLOW_SPEED);
      this._queueFlowRedraw();
    };
    this._flowFrame = requestAnimationFrame(tick);
  },

  _updatePoly(layer, closed) {
    if (!this._drawing || !layer._parts.length) return;
    if (closed || !layer.options.routeFlow) { L.Canvas.prototype._updatePoly.call(this, layer, closed); return; }
    let cached = this._flowCache.get(layer);
    if (!cached || cached.parts !== layer._parts) {
      const path = new Path2D();
      const arrows = new Path2D();
      for (const part of layer._parts) {
        const points = offsetLine(part);
        points.forEach((point, index) => path[index ? 'lineTo' : 'moveTo'](point.x, point.y));
        for (const arrow of directionArrows(points)) {
          const dx = Math.cos(arrow.angle);
          const dy = Math.sin(arrow.angle);
          arrows.moveTo(arrow.x - dx * 4 - dy * 3, arrow.y - dy * 4 + dx * 3);
          arrows.lineTo(arrow.x, arrow.y);
          arrows.lineTo(arrow.x - dx * 4 + dy * 3, arrow.y - dy * 4 - dx * 3);
        }
      }
      cached = { parts: layer._parts, path, arrows };
      this._flowCache.set(layer, cached);
    }
    const ctx = this._ctx;
    const options = layer.options;
    ctx.save();
    ctx.strokeStyle = options.color;
    ctx.lineWidth = options.weight;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = options.opacity;
    ctx.setLineDash([DASH_LENGTH, DASH_SPACING - DASH_LENGTH]);
    ctx.lineDashOffset = this._motionPreference.matches ? 0 : flowOffset(this._flowPhase);
    ctx.stroke(cached.path);
    if (this._motionPreference.matches) {
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.lineWidth = 1.8;
      ctx.stroke(cached.arrows);
    }
    ctx.restore();
  },
});
