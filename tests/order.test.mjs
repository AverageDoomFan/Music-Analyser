import test from "node:test";
import assert from "node:assert/strict";
import { orderTracks, PLAY_ORDERS, queueAfter } from "../src/live/order.js";

test("▶ on a track: it goes first, then the scan continues where it was", () => {
  const all = "abcdefgh".split("").map((id) => ({ id }));
  const q = (first, todo, o) => queueAfter(all.find((x) => x.id === first), todo, { order: all, ...o }).map((x) => x.id).join("");
  // no previous scan: the rest in play order
  assert.equal(q("f", all), "fabcdegh");
  // the previous scan reached d (unfinished): d, then on, then the ones before
  assert.equal(q("f", all, { resumeFrom: "d" }), "fdeghabc");
  // tracks done in this session are skipped; d finished is not in todo
  const done = new Set(["a", "b", "c", "d"]);
  assert.equal(q("f", all.filter((x) => x.id !== "d"), { resumeFrom: "d", skip: (x) => done.has(x.id) }), "fegh");
  // a resume point missing from the playlist: plain play order
  assert.equal(q("b", all, { resumeFrom: "zz" }), "bacdefgh");
});

const tracks = [
  { id: "1", name: "beta", artists: ["Zed"], album: "B", durationMs: 200000, addedAt: "2026-01-02T00:00:00Z" },
  { id: "2", name: "Alpha", artists: ["amy"], album: "C", durationMs: 100000, addedAt: "2026-03-01T00:00:00Z" },
  { id: "3", name: "track 10", artists: ["Bob"], album: "A", durationMs: 300000, addedAt: null },
  { id: "4", name: "track 9", artists: ["Bob"], album: "A", durationMs: null, addedAt: "2025-05-05T00:00:00Z" },
];
const ids = (list) => list.map((t) => t.id).join("");

test("play orders: alphabetical, duration, added, score, reverse", () => {
  assert.equal(ids(orderTracks(tracks, "playlist")), "1234");
  assert.equal(ids(orderTracks(tracks, "reverse")), "4321");
  assert.equal(ids(orderTracks(tracks, "title")), "2143", "case-insensitive, numeric-aware");
  assert.equal(ids(orderTracks(tracks, "artist")), "2431");
  assert.equal(ids(orderTracks(tracks, "album")), "4312");
  assert.equal(ids(orderTracks(tracks, "shortest")), "2134", "unknown duration last");
  assert.equal(ids(orderTracks(tracks, "longest")), "3124");
  assert.equal(ids(orderTracks(tracks, "added")), "2143");
  const scores = { 1: 80, 2: 20, 3: null, 4: 50 };
  assert.equal(ids(orderTracks(tracks, "scoreAsc", { scoreOf: (t) => scores[t.id] })), "2413");
  assert.equal(ids(orderTracks(tracks, "scoreDesc", { scoreOf: (t) => scores[t.id] })), "1423");
  assert.equal(ids(tracks), "1234", "input untouched");
  for (const o of PLAY_ORDERS) assert.equal(orderTracks(tracks, o.key).length, 4, o.key);
});

test("random order: a permutation, stable for a seed, different for another", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `t${i}` }));
  const a = ids(orderTracks(many, "random", { seed: 42 }));
  assert.equal(a, ids(orderTracks(many, "random", { seed: 42 })));
  assert.notEqual(a, ids(orderTracks(many, "random", { seed: 43 })));
  assert.notEqual(a, ids(many));
  assert.deepEqual(orderTracks(many, "random", { seed: 42 }).map((t) => +t.id).sort((x, y) => x - y), many.map((t) => +t.id));
});
