// Human correction: targeted questions -> sub-score overrides -> new score.
//
// Answers are stored as-is. Overrides and the corrected score are always
// re-derived from (auto sub-scores + answers), so a future algorithm version
// can re-apply the same answers to its own sub-scores.

import { computeIntensity } from "./model.js";
import { DEFAULT_WEIGHTS } from "../config.js";
import { t } from "../i18n/index.js";

export const QUESTIONS = [
  {
    id: "overall",
    text: t("How intense does it feel overall?"),
    options: [t("Very calm"), t("Calm"), t("Medium"), t("Intense"), t("Very intense"), t("Extreme")],
    // target score for each option; the corrected score is kept within ±BAND
    targets: [6, 22, 45, 64, 80, 94],
    dims: [],
  },
  {
    id: "aggression",
    text: t("Is the track aggressive / brutal?"),
    options: [t("Not at all"), t("A little"), t("Moderately"), t("A lot"), t("Extremely")],
    targets: [5, 25, 50, 75, 95],
    dims: ["harshness"],
    secondary: { energy: 0.4 },
  },
  {
    id: "density",
    text: t("How dense is the sound?"),
    options: [t("Very airy"), t("Airy"), t("Medium"), t("Dense"), t("Very dense")],
    targets: [8, 28, 50, 72, 94],
    dims: ["density"],
  },
  {
    id: "noise",
    text: t("How noisy / saturated is the sound?"),
    options: [t("Very clean"), t("Rather clean"), t("Mixed"), t("Noisy"), t("Extremely noisy")],
    targets: [2, 15, 40, 70, 96],
    dims: ["noise"],
    secondary: { harshness: 0.35 },
  },
  {
    id: "speed",
    text: t("How fast are the rhythms / transitions?"),
    options: [t("Very slow"), t("Slow"), t("Moderate"), t("Fast"), t("Extremely fast")],
    targets: [6, 28, 50, 74, 95],
    dims: ["tempo"],
    secondary: { complexity: 0.3 },
  },
];

export const BAND = 7;
const MAX_FOLLOW_UPS = 3;
const CONFIDENT = 0.72;

export const questionById = (id) => QUESTIONS.find((q) => q.id === id);

/**
 * Chooses which follow-up questions are worth asking once the overall
 * impression is known. A dimension is asked about when it could explain the
 * gap (it is low while the user wants higher, or the opposite), weighs in the
 * model, and the analysis is not already confident about it.
 * @returns {string[]} question ids, most useful first
 */
export function selectFollowUps(auto, overallIndex, weights = DEFAULT_WEIGHTS) {
  const target = QUESTIONS[0].targets[overallIndex];
  const gap = target - auto.score;
  const candidates = [];
  for (const q of QUESTIONS.slice(1)) {
    const dim = q.dims[0];
    const value = auto.subscores[dim] / 100;
    const conf = auto.confidences[dim] ?? 0.5;
    const room = gap > 0 ? 1 - value : value;         // can this dimension move in the needed direction?
    const influence = dim === "noise" ? (target >= 75 || auto.score >= 75 ? 1.2 : 0.3) : (weights[dim] ?? 0.5);
    const usefulness = influence * room * (1.15 - conf);
    candidates.push({ id: q.id, usefulness, conf });
  }
  candidates.sort((a, b) => b.usefulness - a.usefulness);
  if (Math.abs(gap) < 5) return candidates.filter((c) => c.conf < 0.45).slice(0, 1).map((c) => c.id);
  const chosen = candidates.filter((c) => c.conf < CONFIDENT || c.usefulness > 0.35).slice(0, MAX_FOLLOW_UPS);
  // The top of the scale is where noisiness decides the order: always ask then.
  if (target >= 80 && !chosen.some((c) => c.id === "noise")) chosen.push(candidates.find((c) => c.id === "noise"));
  return chosen.map((c) => c.id);
}

/**
 * Applies answers ({questionId: optionIndex}) to automatic sub-scores.
 * @returns {{overrides:Object, subscores:Object, modelScore:number, score:number, deltas:Object}}
 */
export function applyCorrection(auto, answers, weights = DEFAULT_WEIGHTS) {
  const subscores = { ...auto.subscores };
  const overrides = {};
  const strength = {};
  for (const q of QUESTIONS.slice(1)) {
    const idx = answers[q.id];
    if (idx == null) continue;
    const target = q.targets[idx];
    for (const dim of q.dims) setOverride(dim, target, 1);
    for (const [dim, s] of Object.entries(q.secondary ?? {})) setOverride(dim, target, s);
  }
  function setOverride(dim, target, s) {
    // primary answers win over secondary influences
    if ((strength[dim] ?? 0) >= s) return;
    strength[dim] = s;
    const value = auto.subscores[dim] + (target - auto.subscores[dim]) * s;
    overrides[dim] = Math.round(value * 10) / 10;
    subscores[dim] = overrides[dim];
  }

  // The automatic score aggregates a curve, so the correction is applied as the
  // change it causes on the aggregated sub-scores, added to that score.
  const modelScore = auto.score + computeIntensity(subscores, weights) - computeIntensity(auto.subscores, weights);
  let score = Math.max(0, modelScore);
  if (answers.overall != null) {
    const t = QUESTIONS[0].targets[answers.overall];
    score = Math.min(t + BAND, Math.max(t - BAND, modelScore));
  }
  score = Math.round(score * 10) / 10;

  const deltas = {};
  for (const [dim, v] of Object.entries(overrides)) deltas[dim] = Math.round((v - auto.subscores[dim]) * 10) / 10;
  return { overrides, subscores, modelScore, score, deltas };
}

/** "+++" / "--" style summary of a sub-score delta. */
export function deltaSymbol(delta) {
  const a = Math.abs(delta);
  const n = a >= 35 ? 3 : a >= 18 ? 2 : a >= 6 ? 1 : 0;
  if (!n) return "=";
  return (delta > 0 ? "+" : "−").repeat(n);
}
