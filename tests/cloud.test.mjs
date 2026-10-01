import { test } from "node:test";
import assert from "node:assert/strict";
import { tracks, SR } from "./synth.mjs";
import { extractFeatures } from "../src/audio/features.js";
import { scoreFeatures } from "../src/scoring/index.js";
import { DEFAULT_WEIGHTS, DEFAULT_AGGREGATION } from "../src/config.js";
import {
  versionCode, keywords, queryWords, matchesQuery, communityMean, voteValue, voteDelta,
  packFeatures, unpackFeatures, gzipJson, gunzipJson, randomCode, cleanCode, showCode, cleanName,
  boardValues, libraryCard, listeningCard, heatFromCard, duelTracks, CODE_ALPHABET,
} from "../src/cloud/pack.js";
import { createRecord, applyFeatures, computeFinal, setUseCommunity, setManualScore } from "../src/core/track.js";
import { heatmapBins, listeningTotals } from "../src/stats/listening.js";

test("extractor versions become integers that sort like the versions", () => {
  assert.equal(versionCode("1.8"), 10800);
  assert.ok(versionCode("1.10") > versionCode("1.9"));
  assert.ok(versionCode("2.0") > versionCode("1.99"));
  assert.equal(versionCode(null), 0);
});

test("search words: accents, case and filler words ignored; prefixes match", () => {
  assert.deepEqual(keywords("Rip & Tear", "Mick Gordon"), ["rip", "tear", "mick", "gordon"]);
  assert.deepEqual(keywords("Café del Mar (Remastered)", "Energy 52"), ["cafe", "del", "mar", "energy", "52"]);
  assert.deepEqual(queryWords("the GORDON rip"), ["gordon", "rip"]);
  assert.ok(matchesQuery(["rip", "tear", "mick", "gordon"], ["gordon", "ti"].slice(0, 1)));
  assert.ok(matchesQuery(["rip", "tear"], ["te", "rip"]));
  assert.ok(!matchesQuery(["rip", "tear"], ["doom"]));
});

test("votes: integer scores, exact counter changes, mean of the votes", () => {
  assert.equal(voteValue(72.6), 73);
  assert.equal(voteValue(-3), 0);
  assert.equal(voteValue(NaN), null);
  assert.deepEqual(voteDelta(null, 80), { dc: 1, ds: 80 });
  assert.deepEqual(voteDelta(80, 90), { dc: 0, ds: 10 });
  assert.deepEqual(voteDelta(90, null), { dc: -1, ds: -90 });
  assert.equal(voteDelta(80, 80), null);
  assert.equal(communityMean(0, 0), null);
  assert.equal(communityMean(155, 2), 77.5);
});

test("packed measures: a few KB, and the same score once unpacked", async () => {
  const audio = Object.values(tracks).map((fn) => fn());
  const all = new Float32Array(audio.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const x of audio) { all.set(x, o); o += x.length; }
  const f = extractFeatures(all, SR);
  const z = await packFeatures(f);
  assert.ok(z.length < JSON.stringify(f).length / 2.5, `packed ${z.length} bytes`);
  const back = await unpackFeatures(z);
  assert.equal(back.timeline.times.length, f.timeline.times.length);
  assert.deepEqual(Object.keys(back.timeline.series).sort(), Object.keys(f.timeline.series).sort());
  const a = scoreFeatures(f, DEFAULT_WEIGHTS, DEFAULT_AGGREGATION);
  const b = scoreFeatures(back, DEFAULT_WEIGHTS, DEFAULT_AGGREGATION);
  assert.ok(Math.abs(a.score - b.score) < 0.2, `${a.score} vs ${b.score}`);
  for (const k of Object.keys(a.subscores)) assert.ok(Math.abs(a.subscores[k] - b.subscores[k]) < 0.5, k);
});

test("packed measures keep missing values", async () => {
  const f = { featureVersion: "1.8", duration: 9, bpm: 120, timeline: { windowSeconds: 6, hopSeconds: 3, times: [3, 6], series: { bpm: [120, null], flat: [0.5, 0.5] } } };
  const back = await unpackFeatures(await packFeatures(f));
  assert.deepEqual(back.timeline.series.bpm, [120, null]);
  assert.deepEqual(back.timeline.series.flat, [0.5, 0.5]);
  assert.equal(back.bpm, 120);
});

test("gzip JSON round trip", async () => {
  const v = { a: [1, 2, 3], b: "é" };
  assert.deepEqual(await gunzipJson(await gzipJson(v)), v);
});

test("friend codes: 8 unambiguous characters, typed loosely", () => {
  const c = randomCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(CODE_ALPHABET.length, 32);
  assert.equal(cleanCode(` ${showCode(c).toLowerCase()} `), c);
  assert.equal(cleanCode("ABCD-EFG0"), null);
  assert.equal(cleanCode("short"), null);
});

test("display names: trimmed, 2 to 30 characters, no control characters", () => {
  assert.equal(cleanName("  Doom   Fan "), "Doom Fan");
  assert.equal(cleanName("a"), null);
  assert.equal(cleanName("x".repeat(31)), null);
  assert.equal(cleanName("Bob\u0007"), "Bob");
});

test("leaderboard values from the games' stats", () => {
  const v = boardValues({ points: 420, bestStreak: 6, agree: 30, duels: 41, bullseyes: 3, hunts: 12 }, { "2026-09-30": { points: 80 }, "2026-10-01": { points: 55 } }, 2);
  assert.deepEqual(v, { daily: { v: 135, x: 2 }, trivia: { v: 420, x: 6 }, compare: { v: 30, x: 41 }, hunt: { v: 3, x: 12 } });
});

test("page summaries: library card without ids, listening heatmap round trip", () => {
  const card = libraryCard({
    count: 2, avg: 61.234, median: 61.2, over100: 0, stages: [0, 1, 1], bpm: [0, 2], bpmKnown: 2, modes: { major: 1, minor: 1 },
    keys: [], genres: [], genreKnown: 0, subscores: { energy: 55.55 }, top: [{ id: "spotify:x", name: "A", score: 70.04 }], bottom: [{ id: "y", name: "B", score: 52.4 }],
  });
  assert.equal(card.avg, 61.2);
  assert.deepEqual(card.top, [{ name: "A", score: 70 }]);
  assert.equal(libraryCard({ count: 0 }), null);
  const at = new Date(2026, 8, 30, 21, 10).getTime();
  const listens = [{ at, endedAt: at + 180e3, heardSeconds: 180, score: 80 }];
  const lis = listeningCard(listeningTotals(listens), heatmapBins(listens));
  assert.equal(lis.listens, 1);
  assert.equal(lis.heat.length, 7 * 24 * 2);
  const heat = heatFromCard(lis);
  const orig = heatmapBins(listens);
  assert.equal(heat.max, Math.round(orig.max));
  assert.deepEqual(heat.byDay.map(Math.round), orig.byDay.map(Math.round));
});

test("duel tracks: only what the duel uses, no test tracks or drafts", () => {
  const out = duelTracks([
    { n: "A - B", sid: "x", src: "spotify:whole:100", s: 70, a: 68, g: null, k: "A min", u: {}, sub: { energy: 60 }, f: { plr: 8, kick: 2, bpm: 128 } },
    { n: "Test", src: "test:file:100", s: 10, a: 10 },
    { n: "Draft", src: "spotify:follow:40", s: 50, a: 50, d: 1 },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].f, { plr: 8, bpm: 128 });
});

test("community score: replaces the automatic score, never the user's own", () => {
  const audio = tracks.piano();
  const r = applyFeatures(createRecord({ id: "spotify:abc", name: "x" }), extractFeatures(audio, SR), DEFAULT_WEIGHTS);
  const auto = r.finalScore;
  r.cloud = { community: { mean: auto + 20, n: 3 } };
  assert.equal(computeFinal(r), auto + 20);
  setUseCommunity(false);
  assert.equal(computeFinal(r), auto);
  setUseCommunity(true);
  setManualScore(r, 12);
  assert.equal(r.finalScore, 12);
});
