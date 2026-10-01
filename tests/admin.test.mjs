import { test } from "node:test";
import assert from "node:assert/strict";
import { modelVerdict, fromCloud, fromFile, mergeDatasets, overview, userStats, disputedTracks } from "../src/admin/aggregate.js";
import { duelDoc, reportDoc, userDoc, duelId, reportId } from "../src/cloud/docs.js";

const duel = (user, a, b, winner, scores, at = 1) => ({ user, a, b, aName: a.toUpperCase(), bName: b.toUpperCase(), winner, scores, at, algorithm: "2.4.1", source: "game" });

test("the model's verdict comes from the scores stored with the answer", () => {
  assert.equal(modelVerdict([60, 40]), "a");
  assert.equal(modelVerdict([40, 60]), "b");
  assert.equal(modelVerdict([50, 51.5]), "tie");
  assert.equal(modelVerdict(null), null);
  assert.equal(modelVerdict([null, 40]), null);
});

test("overview and per-user agreement", () => {
  const ds = mergeDatasets([fromCloud({
    users: [{ id: "u1", name: "Alice", lastSync: 5 }, { id: "u2", name: "Bob", lastSync: { toMillis: () => 9 } }],
    duels: [duel("u1", "x", "y", "a", [60, 40]), duel("u1", "x", "z", "b", [70, 30], 2), duel("u2", "y", "z", "tie", [50, 50], 3)],
    reports: [{ user: "u2", trackId: "x", name: "X", at: "2026-10-01", expected: 30, finalScore: 60, comment: "calmer" }],
  })]);
  const o = overview(ds);
  assert.equal(o.duels, 3);
  assert.equal(Math.round(o.agreement * 100), 67);
  assert.equal(o.meanReportDelta, -30);
  const us = userStats(ds);
  assert.equal(us.find((u) => u.id === "u1").agreement, 0.5);
  assert.equal(us.find((u) => u.id === "u2").lastSync, 9);
});

test("disputed tracks: contradicted duels and reports point the same way", () => {
  const ds = mergeDatasets([fromCloud({
    users: [],
    // model says x > z, users say x < z twice: z should go up, x down
    duels: [duel("u1", "x", "z", "b", [70, 30]), duel("u2", "x", "z", "b", [70, 30], 2), duel("u1", "x", "y", "a", [60, 40], 3)],
    reports: [{ user: "u1", trackId: "x", name: "X", at: "1", expected: 20, finalScore: 70, comment: "way too high" }],
  })]);
  const list = disputedTracks(ds);
  const x = list.find((e) => e.id === "x"), z = list.find((e) => e.id === "z");
  assert.ok(x.direction < 0 && z.direction > 0);
  assert.equal(x.down, 2);
  assert.equal(x.reportDelta, -50);
  assert.deepEqual(x.comments, ["way too high"]);
  assert.equal(list[0].id, "x"); // strongest disagreement first
  assert.ok(!list.some((e) => e.id === "y"), "agreed duels do not make a track disputed");
});

test("exported files load as one user each, without duplicates", () => {
  const db = {
    app: "music-energy-analyzer", schemaVersion: 2, exportedAt: "2026-10-01T00:00:00Z",
    tracks: [{ id: "x", name: "X", finalScore: 40 }, { id: "y", name: "Y", finalScore: 60 }],
    duels: [{ a: "x", b: "y", winner: "b", at: 1, scores: [40, 60] }],
    reports: [{ id: "x", name: "X", at: "2026-10-01", expected: 10, finalScore: 40, comment: "c" }],
  };
  const a = fromFile(db, "alice.json");
  assert.equal(a.users[0].id, "file:alice.json");
  assert.equal(a.duels[0].aName, "X");
  const merged = mergeDatasets([a, fromFile(db, "alice.json")]);
  assert.deepEqual([merged.users.length, merged.duels.length, merged.reports.length], [1, 1, 1]);
  const diag = fromFile({ app: "mea-diagnostic", tracks: [{ n: "X", s: 40 }, { n: "Y", s: 60 }], duels: [[0, 1, "a"]] }, "d.json");
  assert.equal(modelVerdict(diag.duels[0].scores), "b");
  assert.throws(() => fromFile({ app: "other" }, "x.json"));
});

test("cloud documents match the rules' shapes", () => {
  const d = { a: "spotify:1", b: "spotify:2", winner: "tie", at: 123, source: "game", scores: [40, 50], algorithm: "2.4.1" };
  const doc = duelDoc(d, new Map([["spotify:1", "One"]]));
  assert.deepEqual(Object.keys(doc).sort(), ["a", "aName", "algorithm", "at", "b", "bName", "scores", "source", "winner"]);
  assert.equal(doc.aName, "One");
  assert.equal(duelId(d), duelId({ ...d }));
  assert.notEqual(duelId(d), duelId({ ...d, winner: "a" }));
  assert.ok(!reportId({ id: "a/b:c" }).includes("/"));
  const big = { id: "x", name: "X", at: "1", features: { timeline: { series: { v: new Array(200000).fill(0.123456) } } }, auto: { curves: {} } };
  const rd = reportDoc(big);
  assert.ok(rd.data.length <= 900000);
  assert.equal(JSON.parse(rd.data).trimmed, "timeline");
  const u = userDoc({ user: { displayName: "A", email: "a@x" }, records: [{ finalScore: 40 }, { finalScore: null }], duels: 3, reports: 1, app: { algorithm: "2", extractor: "1", lang: "fr" } }, "TS");
  assert.deepEqual(Object.keys(u).sort(), ["app", "counts", "email", "lastSync", "library", "name"]);
  assert.equal(u.counts.analysed, 1);
});
