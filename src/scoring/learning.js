// Global weight adaptation from user corrections.
// Fits the weights so that computeIntensity(auto sub-scores) gets closer to the
// user's final scores, with a pull towards the starting weights so a handful of
// corrections cannot wreck the model.

import { computeIntensity } from "./model.js";

const MIN_W = 0.05;
const MAX_W = 3;

/**
 * @param {{subscores:Object, target:number}[]} samples
 * @param {Object} startWeights
 * @returns {{weights:Object, errorBefore:number, errorAfter:number, n:number}}
 */
export function fitWeights(samples, startWeights, { iterations = 250, rate = 0.02, regularization = 0.15 } = {}) {
  const keys = Object.keys(startWeights);
  const w = { ...startWeights };
  const loss = (weights) => {
    let e = 0;
    for (const s of samples) e += ((computeIntensity(s.subscores, weights) - s.target) / 100) ** 2;
    let r = 0;
    for (const k of keys) r += (weights[k] - startWeights[k]) ** 2;
    return e / Math.max(1, samples.length) + regularization * r / keys.length;
  };
  const rmse = (weights) => Math.sqrt(samples.reduce((a, s) => a + (computeIntensity(s.subscores, weights) - s.target) ** 2, 0) / Math.max(1, samples.length));

  const errorBefore = rmse(w);
  const h = 1e-3;
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
