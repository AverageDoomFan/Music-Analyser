// Track record logic, independent from UI and storage.
//
// Record shape (persisted in IndexedDB and in JSON exports):
// {
//   id, hashAlgorithm, name, size, type, lastModified, source: {kind, ...},
//   addedAt, updatedAt, duration, error,
//   featureVersion, features,                       // raw features, never altered
//   auto: { algorithmVersion, subscores, confidences, explain, score, computedAt, weightsKey },
//   initialAuto: { algorithmVersion, score, computedAt },   // first automatic score ever
//   correction: null | { answers, overrides, deltas, previousScore, modelScore, score,
//                         algorithmVersion, createdAt },
//   manual: null | { score, createdAt },
//   finalScore, history: [{ at, kind, score, algorithmVersion }]
// }

import { ALGORITHM_VERSION, FEATURE_VERSION } from "../config.js";
import { scoreFeatures } from "../scoring/index.js";
import { applyCorrection } from "../scoring/correction.js";

const MAX_HISTORY = 30;

export function createRecord({ id, hashAlgorithm, name, size, type, lastModified, source }) {
  const now = Date.now();
  return {
    id, hashAlgorithm, name, size, type, lastModified,
    source: source ?? { kind: "local" },
    addedAt: now, updatedAt: now,
    duration: null, error: null,
    featureVersion: null, features: null,
    auto: null, initialAuto: null,
    correction: null, manual: null,
    finalScore: null, history: [],
  };
}

export const weightsKey = (weights) => Object.keys(weights).sort().map((k) => `${k}:${weights[k]}`).join("|");

export function applyFeatures(record, features, weights) {
  record.features = features;
  record.featureVersion = features.featureVersion;
  record.duration = features.duration;
  record.error = null;
  record.auto = null; // force a fresh score
  rescore(record, weights, "analyse");
  return record;
}

/**
 * Recomputes the automatic score from cached features (no audio needed) and
 * re-applies the stored correction answers. Returns true if anything changed.
 */
export function rescore(record, weights, reason = "recalcul") {
  if (!record.features) return false;
  const key = weightsKey(weights);
  const upToDate = record.auto && record.auto.algorithmVersion === ALGORITHM_VERSION && record.auto.weightsKey === key;
  if (upToDate) return false;
  const prevFinal = record.finalScore;
  const auto = scoreFeatures(record.features, weights);
  record.auto = { ...auto, computedAt: Date.now(), weightsKey: key };
  if (!record.initialAuto) record.initialAuto = { algorithmVersion: auto.algorithmVersion, score: auto.score, computedAt: Date.now() };
  if (record.correction?.answers) {
    const c = applyCorrection(record.auto, record.correction.answers, weights);
    Object.assign(record.correction, {
      overrides: c.overrides, deltas: c.deltas, modelScore: c.modelScore, score: c.score,
      previousScore: auto.score, algorithmVersion: ALGORITHM_VERSION,
    });
  }
  record.finalScore = computeFinal(record);
  record.updatedAt = Date.now();
  if (record.finalScore !== prevFinal) pushHistory(record, reason, record.finalScore);
  return true;
}

export function commitCorrection(record, answers, weights) {
  const c = applyCorrection(record.auto, answers, weights);
  record.correction = {
    answers: { ...answers },
    overrides: c.overrides, deltas: c.deltas,
    previousScore: record.auto.score, modelScore: c.modelScore, score: c.score,
    algorithmVersion: ALGORITHM_VERSION, createdAt: Date.now(),
  };
  record.finalScore = computeFinal(record);
  record.updatedAt = Date.now();
  pushHistory(record, "correction", record.finalScore);
}

export function clearCorrection(record) {
  record.correction = null;
  record.finalScore = computeFinal(record);
  record.updatedAt = Date.now();
  pushHistory(record, "correction annulée", record.finalScore);
}

export function setManualScore(record, value) {
  record.manual = value == null ? null : { score: Math.max(0, Math.min(100, Math.round(value))), createdAt: Date.now() };
  record.finalScore = computeFinal(record);
  record.updatedAt = Date.now();
  pushHistory(record, value == null ? "score manuel retiré" : "score manuel", record.finalScore);
}

export function computeFinal(record) {
  if (record.manual) return record.manual.score;
  if (record.correction) return record.correction.score;
  return record.auto ? record.auto.score : null;
}

/** "pending" | "analyzed" | "corrected" | "error" */
export function statusOf(record) {
  if (record.error && !record.auto) return "error";
  if (!record.auto) return "pending";
  if (record.manual || record.correction) return "corrected";
  return "analyzed";
}

export const needsReanalysis = (record) => !!record.features && record.featureVersion !== FEATURE_VERSION;

function pushHistory(record, kind, score) {
  record.history = [...(record.history ?? []), { at: Date.now(), kind, score, algorithmVersion: ALGORITHM_VERSION }].slice(-MAX_HISTORY);
}
