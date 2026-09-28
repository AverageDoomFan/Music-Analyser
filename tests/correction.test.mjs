import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCorrection, selectFollowUps, deltaSymbol, QUESTIONS, BAND } from "../src/scoring/correction.js";
import { fitWeights } from "../src/scoring/learning.js";
import { computeIntensity } from "../src/scoring/model.js";
import { DEFAULT_WEIGHTS } from "../src/config.js";

const subscores = { energy: 60, tempo: 50, density: 55, brightness: 40, harshness: 35, pressure: 70, complexity: 40, noise: 10 };
const auto = {
  subscores,
  confidences: { energy: 0.9, tempo: 0.95, density: 0.5, brightness: 0.8, harshness: 0.4, pressure: 0.9, complexity: 0.6, noise: 0.5 },
  score: computeIntensity(subscores),
};

test("answers override the matching sub-scores and raise the score", () => {
  const c = applyCorrection(auto, { overall: 4, aggression: 4, noise: 3 });
  assert.equal(c.overrides.harshness, 95);
  assert.equal(c.overrides.noise, 70);
  assert.ok(c.score > auto.score);
  const t = QUESTIONS[0].targets[4];
  assert.ok(c.score >= t - BAND && c.score <= t + BAND);
  assert.ok(c.deltas.harshness > 0);
});

test("the primary answer wins over a secondary influence", () => {
  const c = applyCorrection(auto, { aggression: 0, noise: 4 });
  assert.equal(c.overrides.harshness, 5);
});

test("follow-ups skip what the analysis is sure about", () => {
  const ids = selectFollowUps(auto, 5);
  assert.ok(!ids.includes("speed"), `asked ${ids}`);
  assert.ok(ids.includes("aggression"));
  assert.ok(ids.includes("noise"), "noise always asked at the top of the scale");
  assert.ok(ids.length <= 4);
});

test("delta symbols", () => {
  assert.equal(deltaSymbol(40), "+++");
  assert.equal(deltaSymbol(20), "++");
  assert.equal(deltaSymbol(-7), "−");
  assert.equal(deltaSymbol(2), "=");
});

test("weight fitting reduces the error on corrections", () => {
  // user systematically finds harsh tracks more intense than the model
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const windows = [0, 1, 2].map((k) => ({ energy: 50, tempo: 50, density: 50, brightness: 50, harshness: (i * 9 + k * 5) % 100, pressure: 50, complexity: 50, noise: 5 }));
    const target = mean(windows.map((w) => computeIntensity(w, { ...DEFAULT_WEIGHTS, harshness: 3 })));
    samples.push({ windows, aggregation: "mean", target });
  }
  const r = fitWeights(samples, DEFAULT_WEIGHTS);
  assert.ok(r.errorAfter < r.errorBefore);
  assert.ok(r.weights.harshness > DEFAULT_WEIGHTS.harshness);
});

test("a correction shifts the aggregated score by the change it causes", () => {
  const curveAuto = { ...auto, score: auto.score + 12 }; // e.g. "peak" aggregation above the mean
  const plain = applyCorrection(auto, { aggression: 4 });
  const shifted = applyCorrection(curveAuto, { aggression: 4 });
  assert.ok(Math.abs(shifted.modelScore - plain.modelScore - 12) < 0.01);
});

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

test("pairwise fit learns that pressure matters more", async () => {
  const { fitPairwise } = await import("../src/scoring/learning.js");
  const { DEFAULT_WEIGHTS } = await import("../src/config.js");
  const mk = (pressure, brightness, harshness) => ({ windows: [{ energy: 50, tempo: 50, density: 50, brightness, harshness, pressure, complexity: 50, noise: 10 }], times: [3], aggregation: "topMean" });
  // the user feels the heavy, dark track as more intense than the bright, harsh one
  const pairs = [];
  for (let i = 0; i < 12; i++) pairs.push({ a: mk(70 + i, 10, 45), b: mk(40, 90, 55 - i), winner: "a" });
  const res = fitPairwise(pairs, { ...DEFAULT_WEIGHTS });
  assert.ok(!res.unchanged);
  assert.ok(res.agreementAfter > res.agreementBefore, `${res.agreementBefore} → ${res.agreementAfter}`);
  assert.ok(res.weights.pressure > DEFAULT_WEIGHTS.pressure);
  // random judgements: weights are kept
  const noisy = [];
  for (let i = 0; i < 10; i++) noisy.push({ a: mk(50 + i, 50, 50), b: mk(50 - i, 50, 50), winner: i % 2 ? "a" : "b" });
  const keep = fitPairwise(noisy, { ...DEFAULT_WEIGHTS });
  assert.deepEqual(keep.weights, { ...DEFAULT_WEIGHTS });
});
