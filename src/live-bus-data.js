export const MAX_AGE_MS = 5 * 60_000;
export const MAX_BUSES = 500;

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
