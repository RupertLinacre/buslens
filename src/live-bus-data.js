export const MAX_AGE_MS = 5 * 60_000;
export const MAX_BUSES = 500;
export const ROUTE_TOLERANCE_METRES = 120;

export function normaliseBuses(payload, now = Date.now()) {
  if (!Array.isArray(payload)) throw new Error('Invalid vehicle response');
  const buses = new Map();
  for (const item of payload) {
    const coordinates = item?.coordinates;
    const timestamp = Date.parse(item?.datetime);
    if (item?.id == null || !Array.isArray(coordinates) || coordinates.length !== 2
      || !coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180
      || Math.abs(coordinates[1]) > 90 || !Number.isFinite(timestamp)
      || now - timestamp > MAX_AGE_MS || timestamp - now > 60_000) continue;
    const id = String(item.id);
    const bus = {
      id, latlng: [coordinates[1], coordinates[0]], timestamp,
      heading: Number.isFinite(item.heading) ? ((item.heading % 360) + 360) % 360 : null,
      line: String(item.service?.line_name || 'Bus').slice(0, 20),
      destination: String(item.destination || 'Destination unavailable'),
      name: String(item.vehicle?.name || 'Vehicle details unavailable'),
    };
    if (!buses.has(id) || buses.get(id).timestamp < timestamp) buses.set(id, bus);
  }
  return [...buses.values()];
}

export function vehicleUrl(bounds, endpoint = 'https://bustimes.org/vehicles.json') {
  const params = new URLSearchParams({
    xmin: bounds.getWest().toFixed(5), ymin: bounds.getSouth().toFixed(5),
    xmax: bounds.getEast().toFixed(5), ymax: bounds.getNorth().toFixed(5),
  });
  return `${endpoint}?${params}`;
}

function distanceToSegmentMetres(point, first, second) {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(((point[0] + first[0] + second[0]) / 3) * Math.PI / 180);
  const project = ([latitude, longitude]) => [longitude * longitudeScale, latitude * latitudeScale];
  const target = project(point);
  const start = project(first);
  const end = project(second);
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared ? Math.max(0, Math.min(1, ((target[0] - start[0]) * dx + (target[1] - start[1]) * dy) / lengthSquared)) : 0;
  return Math.hypot(target[0] - (start[0] + fraction * dx), target[1] - (start[1] + fraction * dy));
}

export function buildRouteSegments(routes = []) {
  const segments = [];
  for (const route of routes) {
    for (const shape of route?.shapes || []) {
      for (const line of shape.coordinates || []) {
        for (let index = 1; index < line.length; index += 1) {
          const first = [line[index - 1][1], line[index - 1][0]];
          const second = [line[index][1], line[index][0]];
          segments.push({ first, second, minLat: Math.min(first[0], second[0]), maxLat: Math.max(first[0], second[0]), minLon: Math.min(first[1], second[1]), maxLon: Math.max(first[1], second[1]) });
        }
      }
    }
  }
  return segments;
}

export function isNearRoutePaths(latlng, segments, toleranceMetres = ROUTE_TOLERANCE_METRES) {
  if (!segments?.length) return false;
  const latitudeDelta = toleranceMetres / 111_320;
  const longitudeDelta = toleranceMetres / (111_320 * Math.max(0.2, Math.cos(latlng[0] * Math.PI / 180)));
  return segments.some((segment) => latlng[0] >= segment.minLat - latitudeDelta
    && latlng[0] <= segment.maxLat + latitudeDelta
    && latlng[1] >= segment.minLon - longitudeDelta
    && latlng[1] <= segment.maxLon + longitudeDelta
    && distanceToSegmentMetres(latlng, segment.first, segment.second) <= toleranceMetres);
}
