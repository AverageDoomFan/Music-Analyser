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
    const h = (i * 9) % 100;
    const s = { energy: 50, tempo: 50, density: 50, brightness: 50, harshness: h, pressure: 50, complexity: 50, noise: 5 };
    samples.push({ subscores: s, target: computeIntensity(s, { ...DEFAULT_WEIGHTS, harshness: 3 }) });
  }
  const r = fitWeights(samples, DEFAULT_WEIGHTS);
  assert.ok(r.errorAfter < r.errorBefore);
  assert.ok(r.weights.harshness > DEFAULT_WEIGHTS.harshness);
});
