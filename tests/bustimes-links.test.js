import test from 'node:test';
import assert from 'node:assert/strict';
import { bustimesStopUrl } from '../src/bustimes-links.js';

test('links directly using the selected ATCO code, preserving leading zeroes', () => {
  assert.equal(bustimesStopUrl('210021409770'), 'https://bustimes.org/stops/210021409770');
  assert.equal(bustimesStopUrl('049000000920'), 'https://bustimes.org/stops/049000000920');
  assert.equal(bustimesStopUrl('3400001552OP'), 'https://bustimes.org/stops/3400001552OP');
});
test('missing or malformed stop IDs do not create links', () => {
  for (const id of [null, undefined, '', '../services/20', '" onclick="bad', 'a?b']) {
    assert.equal(bustimesStopUrl(id), null);
  }
});
