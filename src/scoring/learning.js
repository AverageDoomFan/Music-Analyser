// Global weight adaptation from user corrections.
// Fits the weights so that the automatic score (aggregated intensity curve)
// gets closer to the user's final scores, with a pull towards the starting
// weights so a handful of corrections cannot wreck the model.

import { computeIntensity } from "./model.js";
import { aggregate } from "./aggregate.js";

const MIN_W = 0.05;
const MAX_W = 6;

/**
 * @param {{windows:Object[], times?:number[], aggregation:string, target:number}[]} samples
 *        windows = per-window sub-scores of each corrected track
 * @param {Object} startWeights
 * @returns {{weights:Object, errorBefore:number, errorAfter:number, n:number}}
 */
export function fitWeights(samples, startWeights, { iterations = 200, rate = 0.02, regularization = 0.15 } = {}) {
  const keys = Object.keys(startWeights);
  const w = { ...startWeights };
  const predict = (s, weights) => aggregate(s.windows.map((sub) => computeIntensity(sub, weights)), s.aggregation, s.times);
  const loss = (weights) => {
    let e = 0;
    for (const s of samples) e += ((predict(s, weights) - s.target) / 100) ** 2;
    let r = 0;
    for (const k of keys) r += (weights[k] - startWeights[k]) ** 2;
    return e / Math.max(1, samples.length) + regularization * r / keys.length;
  };
  const rmse = (weights) => Math.sqrt(samples.reduce((a, s) => a + (predict(s, weights) - s.target) ** 2, 0) / Math.max(1, samples.length));

  const errorBefore = rmse(w);
  const h = 0.02; // scores are rounded to 0.1: a smaller step sees no change
  for (let it = 0; it < iterations; it++) {
    const base = loss(w);
    const grad = {};
    for (const k of keys) {
      const old = w[k];
      w[k] = old + h;
      grad[k] = (loss(w) - base) / h;
      w[k] = old;
    }
    for (const k of keys) w[k] = Math.min(MAX_W, Math.max(MIN_W, w[k] - (rate * grad[k]) / 0.01));
  }
  for (const k of keys) w[k] = Math.round(w[k] * 100) / 100;
  return { weights: w, errorBefore, errorAfter: rmse(w), n: samples.length };
}

/**
 * Weights from pairwise judgements ("A is more intense than B"), Bradley-Terry
 * style: P(A > B) = sigmoid((score A − score B) / scale), maximised with a pull
 * towards the starting weights. Ties ask for close scores.
 * @param {{a:Object, b:Object, winner:"a"|"b"|"tie"}[]} pairs  a / b = { windows, times, aggregation }
 */
export function fitPairwise(pairs, startWeights, { iterations = 150, rate = 0.05, regularization = 0.4, scale = 8 } = {}) {
  const keys = Object.keys(startWeights);
  const w = { ...startWeights };
  const predict = (s, weights) => aggregate(s.windows.map((sub) => computeIntensity(sub, weights)), s.aggregation, s.times);
  const sig = (x) => 1 / (1 + Math.exp(-x));
  const loss = (weights) => {
    let e = 0;
    for (const p of pairs) {
      const d = (predict(p.a, weights) - predict(p.b, weights)) / scale;
      if (p.winner === "a") e -= Math.log(sig(d) + 1e-9);
      else if (p.winner === "b") e -= Math.log(sig(-d) + 1e-9);
      else e += 0.5 * d * d;
    }
    let r = 0;
    for (const k of keys) r += (weights[k] - startWeights[k]) ** 2;
    return e / Math.max(1, pairs.length) + regularization * r / keys.length;
  };
  const agreement = (weights) => {
    const decided = pairs.filter((p) => p.winner !== "tie");
    if (!decided.length) return null;
    const ok = decided.filter((p) => (predict(p.a, weights) > predict(p.b, weights)) === (p.winner === "a")).length;
    return ok / decided.length;
  };
  const before = agreement(w);
  const h = 0.02; // scores are rounded to 0.1: a smaller step sees no change
  for (let it = 0; it < iterations; it++) {
    const base = loss(w);
    const grad = {};
    for (const k of keys) {
      const old = w[k];
      w[k] = old + h;
      grad[k] = (loss(w) - base) / h;
      w[k] = old;
    }
    for (const k of keys) w[k] = Math.min(MAX_W, Math.max(MIN_W, w[k] - rate * grad[k]));
  }
  for (const k of keys) w[k] = Math.round(w[k] * 100) / 100;
  const after = agreement(w);
  // judgements the weights cannot explain better: keep the current weights
  if (before != null && after != null && after <= before) {
    return { weights: { ...startWeights }, agreementBefore: before, agreementAfter: before, n: pairs.length, unchanged: true };
  }
  return { weights: w, agreementBefore: before, agreementAfter: after, n: pairs.length };
}
