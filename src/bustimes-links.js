export function bustimesStopUrl(stopId) {
  // Our stop IDs are NaPTAN/ATCO codes, not Bustimes service slugs.
  const code = String(stopId ?? '');
  return /^[a-z0-9]+$/i.test(code) ? `https://bustimes.org/stops/${code}` : null;
}
