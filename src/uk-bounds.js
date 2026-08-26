// Coarse rectangles are sufficient for deciding whether to leave the initial
// Oxford view. They deliberately avoid geocoding, network requests, and heavy
// point-in-polygon work on startup.
const UK_BOUNDS = [
  [49.75, 54.9, -6.1, 1.9],   // England, Wales and southern Scotland
  [54.5, 58.8, -7.0, 0.2],   // northern England and mainland Scotland
  [58.7, 61.1, -8.0, -0.1],  // Orkney, Shetland and northern islands
  [54.0, 55.4, -8.25, -5.25], // Northern Ireland
  [49.8, 50.1, -6.65, -6.0], // Isles of Scilly
];

export function isWithinUk(latitude, longitude) {
  return UK_BOUNDS.some(([south, north, west, east]) => (
    latitude >= south && latitude <= north && longitude >= west && longitude <= east
  ));
}
