import { test } from "node:test";
import assert from "node:assert/strict";
import { tracks, SR } from "./synth.mjs";
import { extractFeatures, measureClipping } from "../src/audio/features.js";
import { scoreFeatures, computeIntensity, toDisplay, toModel, attackPoints } from "../src/scoring/model.js";
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
    assert.ok(r.score >= 0 && Number.isFinite(r.score));
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
  // 2.4: fast regular attacks add points, extratone ends on top
  assert.ok(s("speedcore") < s("extratone"));
  assert.ok(s("harshNoise") < s("extratone"));
  assert.ok(s("extratone") > 120, `extratone ${s("extratone")}`);
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
  assert.equal(calibrate(1), 125);
  assert.ok(calibrate(0.92) > 100 && calibrate(0.92) < 125);
  assert.equal(calibrate(0.85), 100);
  assert.equal(stageFor(112), STAGES.at(-1));
  assert.equal(STAGES.at(-1).min, 100);
  assert.notEqual(stageFor(99), STAGES.at(-1));
});

test("the playback volume never changes the score", async () => {
  const { renderTrack, SR } = await import("../src/testlab/synth.js");
  const { extractFeatures } = await import("../src/audio/features.js");
  for (const p of [{}, { drive: 6, bpm: 170 }]) {
    const base = renderTrack(p, 12);
    const scores = [0, -20, -40].map((db) => scoreFeatures(extractFeatures(Float32Array.from(base, (v) => v * 10 ** (db / 20)), SR, {})).score);
    for (const s of scores) assert.ok(Math.abs(s - scores[0]) <= 0.5, `${scores}`);
  }
});

test("extractor 1.6: hardness cues react to distortion and double kick", async () => {
  const { renderTrack } = await import("../src/testlab/synth.js");
  const feat = (p) => { const x = renderTrack(p, 12); return extractFeatures(x, SR, measureClipping([x])); };
  const clean = feat({}), driven = feat({ drive: 25, clip: 0.3 });
  assert.ok(driven.spectralContrast < clean.spectralContrast - 8, `contrast ${clean.spectralContrast} → ${driven.spectralContrast}`);
  assert.ok(driven.dissonance > clean.dissonance);
  assert.ok(driven.spectralEntropy > clean.spectralEntropy);
  assert.ok(feat({ bpm: 180, kickDiv: 4, kick: 0.9 }).fastKickRatio > 0.8);
  assert.ok(clean.fastKickRatio < 0.1);
});

test("fast regular attacks add points along a rising curve, to intense windows only", () => {
  assert.equal(attackPoints(2), 0);
  assert.ok(attackPoints(5) > 0 && attackPoints(5) < attackPoints(9));
  assert.ok(attackPoints(16) - attackPoints(12) > attackPoints(9) - attackPoints(5));
  const loud = { energy: 90, tempo: 70, density: 85, brightness: 85, harshness: 92, pressure: 80, complexity: 55, noise: 65 };
  const calm = { energy: 20, tempo: 30, density: 30, brightness: 30, harshness: 10, pressure: 15, complexity: 20, noise: 0 };
  const base = computeIntensity(loud);
  assert.ok(computeIntensity({ ...loud, attackSpeed: 100 }) >= base + 50);
  const max = Object.fromEntries(Object.keys(loud).map((k) => [k, 100]));
  assert.ok(computeIntensity({ ...max, attackSpeed: 100 }) > SCORE_MAX, "no ceiling on the score");
  assert.equal(stageFor(SCORE_MAX + 1).label, "???");
  assert.notEqual(stageFor(SCORE_MAX).label, "???");
  assert.equal(computeIntensity({ ...calm, attackSpeed: 100 }), computeIntensity(calm));
});
