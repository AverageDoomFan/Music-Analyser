import { test } from "node:test";
import assert from "node:assert/strict";
import { tracks, SR } from "./synth.mjs";
import { extractFeatures, measureClipping } from "../src/audio/features.js";
import { scoreFeatures, computeIntensity } from "../src/scoring/model.js";
import { DEFAULT_WEIGHTS, ALGORITHM_VERSION } from "../src/config.js";

const results = {};
for (const [name, gen] of Object.entries(tracks)) {
  const x = gen();
  const features = extractFeatures(x, SR, measureClipping([x]));
  results[name] = { features, ...scoreFeatures(features) };
}

test("features are finite and plausible", () => {
  for (const [name, r] of Object.entries(results)) {
    for (const [k, v] of Object.entries(r.features)) {
      if (typeof v === "number") assert.ok(Number.isFinite(v), `${name}.${k} = ${v}`);
    }
    assert.ok(Math.abs(r.features.duration - 16) < 0.01);
  }
  assert.ok(Math.abs(results.pop.features.bpm - 110) < 2, `pop bpm ${results.pop.features.bpm}`);
  assert.ok(Math.abs(results.hardstyle.features.bpm - 150) < 2, `hardstyle bpm ${results.hardstyle.features.bpm}`);
  assert.equal(results.ambient.features.onsetRate, 0);
  assert.ok(results.harshNoise.features.flatnessMedian > 0.3);
  assert.ok(results.speedcore.features.clippingRatio > 0.01);
  assert.equal(results.piano.features.clippingRatio, 0);
});

test("scores and sub-scores stay in range and carry the algorithm version", () => {
  for (const r of Object.values(results)) {
    assert.equal(r.algorithmVersion, ALGORITHM_VERSION);
    assert.ok(r.score >= 0 && r.score <= 100);
    for (const v of Object.values(r.subscores)) assert.ok(v >= 0 && v <= 100);
    for (const v of Object.values(r.confidences)) assert.ok(v >= 0 && v <= 1);
  }
});

test("coarse perceptual ordering", () => {
  const s = (n) => results[n].score;
  assert.ok(s("ambient") < 15, `ambient ${s("ambient")}`);
  assert.ok(s("ambient") < s("piano"));
  assert.ok(s("piano") < s("pop"));
  assert.ok(s("pop") < s("metal"));
  assert.ok(s("metal") < s("speedcore"));
  assert.ok(s("speedcore") < s("harshNoise"));
  assert.ok(s("extratone") > 90, `extratone ${s("extratone")}`);
  assert.ok(s("harshNoise") > 90);
});

test("harshness and noise separate loud tonal music from saturated music", () => {
  const { orchestralEpic: o, speedcore: sc } = results;
  assert.ok(sc.subscores.harshness - o.subscores.harshness > 40);
  assert.ok(o.subscores.noise < 10);
  assert.ok(results.harshNoise.subscores.noise > results.metal.subscores.noise);
});

test("noise only pushes when the base is already intense", () => {
  const calm = { energy: 15, tempo: 10, density: 20, brightness: 20, harshness: 10, loudness: 20, complexity: 10 };
  const a = computeIntensity({ ...calm, noise: 0 }, DEFAULT_WEIGHTS);
  const b = computeIntensity({ ...calm, noise: 100 }, DEFAULT_WEIGHTS);
  assert.equal(a, b);
  const loud = { energy: 85, tempo: 70, density: 85, brightness: 70, harshness: 80, loudness: 90, complexity: 50 };
  assert.ok(computeIntensity({ ...loud, noise: 100 }) - computeIntensity({ ...loud, noise: 0 }) > 5);
});

test("weights change the score", () => {
  const subs = results.rapSlow.subscores;
  const more = computeIntensity(subs, { ...DEFAULT_WEIGHTS, harshness: 0.05, loudness: 3 });
  const less = computeIntensity(subs, { ...DEFAULT_WEIGHTS, harshness: 3, loudness: 0.05 });
  assert.notEqual(more, less);
});

test("long files are analysed through excerpts", () => {
  const x = new Float32Array(SR * 60 * 13);
  const piece = tracks.pop();
  for (let i = 0; i < x.length; i++) x[i] = piece[i % piece.length];
  const f = extractFeatures(x, SR);
  assert.ok(f.excerpted);
  assert.ok(f.analyzedSeconds < 13 * 60);
  assert.ok(Math.abs(f.bpm - 110) < 2);
});
