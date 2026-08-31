const decoder = new TextDecoder();

class BinaryReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  readBytes(length) {
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readVarint() {
    let value = 0;
    let multiplier = 1;
    while (true) {
      const byte = this.bytes[this.offset++];
      value += (byte & 0x7f) * multiplier;
      if (!(byte & 0x80)) return value;
      multiplier *= 128;
      if (multiplier > Number.MAX_SAFE_INTEGER) throw new Error('Invalid timetable varint');
    }
  }

  readSignedVarint() {
    const value = this.readVarint();
    return value % 2 ? -((value + 1) / 2) : value / 2;
  }

  readStringTable() {
    const count = this.readVarint();
    const values = [];
    let previous = '';
    for (let index = 0; index < count; index += 1) {
      const common = this.readVarint();
      const suffix = decoder.decode(this.readBytes(this.readVarint()));
      const value = previous.slice(0, common) + suffix;
      values.push(value);
      previous = value;
    }
    return values;
  }
}

async function fetchGzipBinary(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  // Development servers can transparently apply Content-Encoding. GitHub
  // Pages serves the checked-in gzip bytes, so only unpack when the gzip magic
  // remains after fetch.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (!('DecompressionStream' in window)) throw new Error('This browser cannot unpack timetable data');
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
    bytes = new Uint8Array(await stream.arrayBuffer());
  }
  return bytes;
}

function decodeTiming(bytes, stopCount) {
  const reader = new BinaryReader(bytes);
  const departures = new Array(stopCount);
  const arrivals = new Array(stopCount);
  departures[0] = 0;
  arrivals[0] = -reader.readSignedVarint();
  for (let index = 1; index < stopCount; index += 1) {
    departures[index] = departures[index - 1] + reader.readSignedVarint();
    arrivals[index] = departures[index] - reader.readSignedVarint();
  }
  return { arrivals, departures };
}

export function decodeTimetableShard(bytes) {
  const reader = new BinaryReader(bytes);
  if (decoder.decode(reader.readBytes(4)) !== 'BTT1') throw new Error('Unrecognised timetable data');
  if (reader.readVarint() !== 1) throw new Error('Unsupported timetable data version');
  const routes = reader.readStringTable();
  const services = reader.readStringTable();
  const headsigns = reader.readStringTable();
  const stops = reader.readStringTable();

  const patterns = Array.from({ length: reader.readVarint() }, () => {
    const pattern = [];
    let stopIndex = 0;
    const count = reader.readVarint();
    for (let index = 0; index < count; index += 1) {
      const token = reader.readVarint();
      const delta = token >> 4;
      stopIndex += delta % 2 ? -((delta + 1) / 2) : delta / 2;
      pattern.push({
        id: stops[stopIndex],
        pickup: (token >> 2) & 3,
        dropoff: token & 3,
      });
    }
    return pattern;
  });

  const encodedTimings = Array.from({ length: reader.readVarint() }, () => reader.readBytes(reader.readVarint()));
  const timingCache = new Map();
  const routesToJourneys = new Map();
  const groupCount = reader.readVarint();
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const routeId = routes[reader.readVarint()];
    const serviceId = services[reader.readVarint()];
    const headsign = headsigns[reader.readVarint()];
    const patternId = reader.readVarint();
    const timingId = reader.readVarint();
    const direction = reader.readVarint() - 1;
    const wheelchair = reader.readVarint();
    const approximate = Boolean(reader.readVarint());
    const starts = [];
    let start = 0;
    const startCount = reader.readVarint();
    for (let index = 0; index < startCount; index += 1) {
      start += reader.readVarint();
      starts.push(start);
    }
    const timingKey = `${timingId}:${patterns[patternId].length}`;
    if (!timingCache.has(timingKey)) {
      timingCache.set(timingKey, decodeTiming(encodedTimings[timingId], patterns[patternId].length));
    }
    if (!routesToJourneys.has(routeId)) routesToJourneys.set(routeId, []);
    routesToJourneys.get(routeId).push({
      serviceId,
      headsign,
      stops: patterns[patternId],
      ...timingCache.get(timingKey),
      starts,
      direction,
      wheelchair,
      approximate,
      groupIndex,
    });
  }
  if (reader.offset !== bytes.length) throw new Error('Timetable shard did not decode completely');
  return routesToJourneys;
}

export function createTimetableLoader(dataBase, chunkNameForRoute) {
  const cache = new Map();
  return async (routeIds) => {
    const chunks = [...new Set(routeIds.map(chunkNameForRoute))];
    const payloads = await Promise.all(chunks.map((chunk) => {
      const binaryChunk = chunk.replace('.json.gz', '.bin.gz');
      if (!cache.has(binaryChunk)) {
        cache.set(binaryChunk, fetchGzipBinary(`${dataBase}timetables/${binaryChunk}`).then(decodeTimetableShard));
      }
      return cache.get(binaryChunk);
    }));
    const journeys = new Map();
    routeIds.forEach((routeId) => {
      const payload = payloads.find((candidate) => candidate.has(routeId));
      if (payload) journeys.set(routeId, payload.get(routeId));
    });
    return journeys;
  };
}
