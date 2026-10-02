import test from "node:test";
import assert from "node:assert/strict";
import { medianLag, spotifyLag, recordSpotifyLag, DEFAULT_LAG } from "../src/spotify/lag.js";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

test("medianLag: odd, even, empty, junk", () => {
  assert.equal(medianLag([0.4, 0.2, 0.3]), 0.3);
  assert.ok(Math.abs(medianLag([0.2, 0.4]) - 0.3) < 1e-9);
  assert.equal(medianLag([]), null);
  assert.equal(medianLag([NaN, null]), null);
});

test("spotifyLag: estimate first, then the median of this browser's measures", () => {
  store.clear();
  assert.deepEqual(spotifyLag(), { value: DEFAULT_LAG, measured: false, n: 0 });
  for (const x of [0.36, 0.38, 5, -3, NaN, 0.41]) recordSpotifyLag(x);
  const l = spotifyLag();
  assert.equal(l.measured, true);
  assert.equal(l.n, 3);
  assert.equal(l.value, 0.38);
  for (let i = 0; i < 40; i++) recordSpotifyLag(0.5);
  assert.equal(spotifyLag().n, 25);
  assert.equal(spotifyLag().value, 0.5);
});
