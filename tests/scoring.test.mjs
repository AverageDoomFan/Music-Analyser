import { test } from "node:test";
import assert from "node:assert/strict";
import { tracks, SR } from "./synth.mjs";
import { extractFeatures, measureClipping } from "../src/audio/features.js";
import { scoreFeatures, computeIntensity, toDisplay, toModel } from "../src/scoring/model.js";
import { DEFAULT_WEIGHTS, ALGORITHM_VERSION, SUBSCORE_SCALES, SCORE_MAX, STAGES, stageFor } from "../src/config.js";

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
  assert.ok(Math.abs(results.pop.features.sourceLoudnessLufs - -6.4) < 1);
  assert.ok(Math.abs(results.pop.features.normalizationGainDb - (-14 - results.pop.features.sourceLoudnessLufs)) < 0.01);
  assert.equal(results.piano.features.clippingRatio, 0);
});

test("scores and sub-scores stay in range and carry the algorithm version", () => {
  for (const r of Object.values(results)) {
    assert.equal(r.algorithmVersion, ALGORITHM_VERSION);
    assert.ok(r.score >= 0 && r.score <= SCORE_MAX);
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
  const calm = { energy: 15, tempo: 10, density: 20, brightness: 20, harshness: 10, pressure: 20, complexity: 10 };
  const a = computeIntensity({ ...calm, noise: 0 }, DEFAULT_WEIGHTS);
  const b = computeIntensity({ ...calm, noise: 100 }, DEFAULT_WEIGHTS);
  assert.equal(a, b);
  const loud = { energy: 85, tempo: 70, density: 85, brightness: 70, harshness: 80, pressure: 90, complexity: 50 };
  assert.ok(computeIntensity({ ...loud, noise: 100 }) - computeIntensity({ ...loud, noise: 0 }) > 5);
});

test("weights change the score", () => {
  const subs = results.rapSlow.subscores;
  const more = computeIntensity(subs, { ...DEFAULT_WEIGHTS, harshness: 0.05, pressure: 3 });
  const less = computeIntensity(subs, { ...DEFAULT_WEIGHTS, harshness: 3, pressure: 0.05 });
  assert.notEqual(more, less);
});

test("the file's level does not change features or scores", () => {
  for (const name of ["piano", "pop", "metal", "speedcore"]) {
    const ref = results[name];
    for (const gain of [0.25, 0.5, 1.8]) {
      const x = tracks[name]();
      for (let i = 0; i < x.length; i++) x[i] *= gain;
      const r = scoreFeatures(extractFeatures(x, SR, measureClipping([x])));
      assert.ok(Math.abs(r.score - ref.score) < 0.5, `${name} ×${gain}: ${r.score} vs ${ref.score}`);
      for (const [dim, v] of Object.entries(r.subscores)) assert.ok(Math.abs(v - ref.subscores[dim]) < 1, `${name} ×${gain} ${dim}`);
    }
  }
});

test("features from the previous extractor still get a score", () => {
  const f = { ...results.pop.features, featureVersion: "1.0" };
  for (const k of ["lowPulse", "lowBandDbStd", "lowFlatnessMedian", "plrDb", "kickRate", "kickPunch"]) delete f[k];
  const r = scoreFeatures(f);
  assert.ok(Number.isFinite(r.score));
  assert.ok(Math.abs(r.score - results.pop.score) < 25);
});

test("pressure follows the low end, not the level", () => {
  const p = (n) => results[n].subscores.pressure;
  assert.ok(p("piano") < p("pop"));
  assert.ok(p("ambient") < p("hardstyle"));
  assert.ok(p("harshNoise") < p("metal"), "noise without bass has little low-end pressure");
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

test("perceptual sub-score scales: increasing, invertible, intensity computed on the model scale", () => {
  for (const [dim, pts] of Object.entries(SUBSCORE_SCALES)) {
    assert.deepEqual(pts[0], [0, 0], dim);
    assert.deepEqual(pts.at(-1), [1, 1], dim);
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i][0] > pts[i - 1][0] && pts[i][1] > pts[i - 1][1], dim);
    for (let x = 0; x <= 1; x += 0.05) assert.ok(Math.abs(toModel(dim, toDisplay(dim, x)) - x) < 1e-9, `${dim} ${x}`);
  }
  // the same internal values give the same intensity whether or not they are rescaled for display
  const internal = { energy: 0.5, tempo: 0.4, density: 0.25, brightness: 0.2, harshness: 0.6, pressure: 0.5, complexity: 0.3, noise: 0.3 };
  const shown = Object.fromEntries(Object.entries(internal).map(([d, v]) => [d, toDisplay(d, v) * 100]));
  const plain = Object.fromEntries(Object.entries(internal).map(([d, v]) => [d, v * 100]));
  assert.ok(shown.brightness > plain.brightness && shown.harshness > plain.harshness);
  const scaled = computeIntensity(shown);
  const saved = { ...SUBSCORE_SCALES };
  for (const k of Object.keys(SUBSCORE_SCALES)) delete SUBSCORE_SCALES[k];
  try {
    assert.equal(scaled, computeIntensity(plain));
  } finally {
    Object.assign(SUBSCORE_SCALES, saved);
  }
});

test("scores can go past 100 into the Off the charts stage", async () => {
  const { calibrate } = await import("../src/scoring/model.js");
  assert.equal(calibrate(1), SCORE_MAX);
  assert.ok(calibrate(0.92) > 100 && calibrate(0.92) < SCORE_MAX);
  assert.equal(calibrate(0.85), 100);
  assert.equal(stageFor(112), STAGES.at(-1));
  assert.equal(STAGES.at(-1).min, 100);
  assert.notEqual(stageFor(99), STAGES.at(-1));
});

test("a very quiet recording is heard as calmer (played level)", async () => {
  const { playedLevelGain } = await import("../src/scoring/model.js");
  assert.equal(playedLevelGain({ sourceLoudnessLufs: -13 }), 1);
  assert.equal(playedLevelGain({ sourceLoudnessLufs: -24 }), 1);
  assert.equal(playedLevelGain({ sourceLoudnessLufs: -40 }), 0.5);
  assert.equal(playedLevelGain({ sourceLoudnessLufs: -60 }), 0.5);
  assert.equal(playedLevelGain({}), 1);
  const f = results.calmPad?.features ?? Object.values(results)[0].features;
  const loud = scoreFeatures({ ...f, sourceLoudnessLufs: -14 }).score;
  const quiet = scoreFeatures({ ...f, sourceLoudnessLufs: -36 }).score;
  assert.ok(quiet < loud || loud === 0);
});
