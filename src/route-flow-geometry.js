export const DASH_LENGTH = 9;
export const DASH_SPACING = 24;
export const FLOW_SPEED = 8;

// Screen coordinates have y pointing down. This offsets to the left of travel,
// so reversed shapes appear on opposite sides of a shared road (UK traffic).
export function offsetLine(points, distance = 3) {
  const clean = points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  return clean.map((point, i) => {
    const normal = (a, b) => {
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      return { x: (b.y - a.y) / length, y: -(b.x - a.x) / length };
    };
    if (clean.length < 2) return { ...point };
    const before = normal(clean[Math.max(0, i - 1)], clean[i || 1]);
    const after = normal(clean[i === clean.length - 1 ? i - 1 : i], clean[Math.min(clean.length - 1, i + 1)]);
    const x = before.x + after.x;
    const y = before.y + after.y;
    const length = Math.hypot(x, y);
    if (length < 0.001) return { x: point.x + after.x * distance, y: point.y + after.y * distance };
    const projection = (x * after.x + y * after.y) / length;
    const scale = Math.min(distance / Math.max(projection, 0.5), distance * 2);
    return { x: point.x + x / length * scale, y: point.y + y / length * scale };
  });
}

export function directionArrows(points, spacing = 100) {
  const arrows = [];
  let next = spacing / 2;
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    while (next <= travelled + length) {
      const fraction = (next - travelled) / length;
      arrows.push({ x: a.x + fraction * (b.x - a.x), y: a.y + fraction * (b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) });
      next += spacing;
    }
    travelled += length;
  }
  return arrows;
}

export function flowOffset(elapsedMs) {
  // Negative dash offset advances the pattern from first point to last.
  return -((elapsedMs * FLOW_SPEED / 1000) % DASH_SPACING);
}
