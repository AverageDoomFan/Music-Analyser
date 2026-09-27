import { test } from "node:test";
import assert from "node:assert/strict";
import { tracks, SR } from "./synth.mjs";
import { extractFeatures } from "../src/audio/features.js";
import { createRecord, applyFeatures, rescore, commitCorrection, setManualScore, statusOf } from "../src/core/track.js";
import { mergeRecord, buildExport, parseExport } from "../src/storage/backup.js";
import { buildProgression, toM3U } from "../src/playlist/progression.js";
import { DEFAULT_WEIGHTS, ALGORITHM_VERSION } from "../src/config.js";

const features = extractFeatures(tracks.pop(), SR);

function makeRecord(id = "abc") {
  const r = createRecord({ id, hashAlgorithm: "sha-256", name: `${id}.mp3`, size: 1000, type: "audio/mpeg", lastModified: 0 });
  return applyFeatures(r, features, DEFAULT_WEIGHTS);
}

test("record lifecycle: auto -> correction -> manual", () => {
  const r = makeRecord();
  assert.equal(statusOf(r), "analyzed");
  assert.equal(r.finalScore, r.auto.score);
  assert.equal(r.initialAuto.score, r.auto.score);
  commitCorrection(r, { overall: 5, noise: 4 }, DEFAULT_WEIGHTS);
  assert.equal(statusOf(r), "corrected");
  assert.equal(r.finalScore, r.correction.score);
  assert.ok(r.finalScore > r.auto.score);
  setManualScore(r, 42);
  assert.equal(r.finalScore, 42);
  setManualScore(r, null);
  assert.equal(r.finalScore, r.correction.score);
});

test("a new algorithm version rescored from cached features keeps corrections", () => {
  const r = makeRecord();
  commitCorrection(r, { overall: 1 }, DEFAULT_WEIGHTS);
  const initial = r.initialAuto.score;
  r.auto.algorithmVersion = "0.9"; // simulate a record from an older version
  assert.ok(rescore(r, DEFAULT_WEIGHTS));
  assert.equal(r.auto.algorithmVersion, ALGORITHM_VERSION);
  assert.deepEqual(r.correction.answers, { overall: 1 });
  assert.equal(r.initialAuto.score, initial);
  assert.equal(rescore(r, DEFAULT_WEIGHTS), false, "no-op when up to date");
  assert.ok(rescore(r, { ...DEFAULT_WEIGHTS, harshness: 3 }), "weights change triggers a rescore");
});

test("export / import roundtrip never loses corrections", () => {
  const local = makeRecord();
  const remote = JSON.parse(JSON.stringify(makeRecord()));
  commitCorrection(remote, { overall: 5 }, DEFAULT_WEIGHTS);
  const exported = JSON.stringify(buildExport([remote], { weights: DEFAULT_WEIGHTS }));
  const { tracks: imported } = parseExport(exported);
  local.updatedAt = Date.now() + 1000; // local is newer but has no correction
  const merged = mergeRecord(local, imported[0]);
  rescore(merged, DEFAULT_WEIGHTS);
  assert.deepEqual(merged.correction.answers, { overall: 5 });
  assert.ok(merged.auto.explain, "explain recomputed");
  assert.throws(() => parseExport("{}"));
});

test("progression is monotonic overall and flags big jumps", () => {
  const items = [5, 8, 12, 14, 15, 40, 42, 43, 90].map((score, i) => ({
    id: `t${i}`, name: `t${i}`, score,
    subscores: { energy: score, tempo: (i * 37) % 100, density: score, brightness: 50, harshness: score, loudness: score, complexity: 50, noise: 0 },
  }));
  const { steps, stats } = buildProgression(items, { tolerance: 4 });
  assert.equal(steps.length, items.length);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].score >= steps[i - 1].score - 4);
  assert.equal(stats.bigJumps, 2);
  assert.ok(toM3U(steps).startsWith("#EXTM3U"));
});
