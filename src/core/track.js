// Track record logic, independent from UI and storage.
//
// Record shape (persisted in IndexedDB and in JSON exports):
// {
//   id, hashAlgorithm, name, size, type, lastModified, source: {kind, ...},
//   addedAt, updatedAt, duration, error,
//   featureVersion, features,                       // raw features, never altered
//   auto: { algorithmVersion, aggregation, subscores, confidences, explain, score, stats,
//           curves: { times, intensity, subscores }, computedAt, weightsKey },
//   initialAuto: { algorithmVersion, score, computedAt },   // first automatic score ever
//   correction: null | { answers, overrides, deltas, previousScore, modelScore, score,
//                         algorithmVersion, createdAt },
//   manual: null | { score, createdAt },
//   vocals: null | { state: "vocal" | "instrumental", source: "user" | "musicbrainz" | "lrclib" (older), at },
//   lyrics: null | { mood, strength (1..3), at },            // user's rating of the lyrics
//   extGenres: null | { source: "musicbrainz" | "lastfm" | "spotify" (older), genres, weights, mbid, at },
//   finalScore, valence, history: [{ at, kind, score, algorithmVersion }]
// }

import { ALGORITHM_VERSION, FEATURE_VERSION, DEFAULT_WEIGHTS, DEFAULT_AGGREGATION, SCORE_MAX } from "../config.js";
import { scoreFeatures } from "../scoring/index.js";
import { applyCorrection } from "../scoring/correction.js";
import { lyricsEffect } from "../scoring/describe.js";

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

/**
 * Scoring settings: { weights, aggregation }. A bare weights object is accepted
 * for convenience (default aggregation).
 */
export function normalizeScoring(scoring) {
  if (scoring?.weights) return { weights: scoring.weights, aggregation: scoring.aggregation ?? DEFAULT_AGGREGATION };
  return { weights: scoring ?? DEFAULT_WEIGHTS, aggregation: DEFAULT_AGGREGATION };
}

export const scoringKey = (scoring) => {
  const { weights, aggregation } = normalizeScoring(scoring);
  return `${aggregation}|` + Object.keys(weights).sort().map((k) => `${k}:${weights[k]}`).join("|");
};

export function applyFeatures(record, features, scoring) {
  record.features = features;
  record.featureVersion = features.featureVersion;
  record.duration = features.duration;
  record.error = null;
  record.auto = null; // force a fresh score
  rescore(record, scoring, "analysis");
  return record;
}

/**
 * Recomputes the automatic score from cached features (no audio needed) and
 * re-applies the stored correction answers. Returns true if anything changed.
 */
export function rescore(record, scoring, reason = "recompute") {
  if (!record.features) return false;
  const { weights, aggregation } = normalizeScoring(scoring);
  const key = scoringKey(scoring);
  const upToDate = record.auto && record.auto.algorithmVersion === ALGORITHM_VERSION && record.auto.weightsKey === key;
  if (upToDate) return false;
  const prevFinal = record.finalScore;
  const auto = scoreFeatures(record.features, weights, aggregation);
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

export function commitCorrection(record, answers, scoring) {
  const c = applyCorrection(record.auto, answers, normalizeScoring(scoring).weights);
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
  pushHistory(record, "correction removed", record.finalScore);
}

export function setManualScore(record, value) {
  record.manual = value == null ? null : { score: Math.max(0, Math.min(SCORE_MAX, Math.round(value))), createdAt: Date.now() };
  record.finalScore = computeFinal(record);
  record.updatedAt = Date.now();
  pushHistory(record, value == null ? "manual score removed" : "manual score", record.finalScore);
}

/** Manual score wins; otherwise correction (or automatic) score shifted by the lyrics rating. */
export function computeFinal(record) {
  record.valence = computeValence(record);
  if (record.manual) return record.manual.score;
  const base = record.correction ? record.correction.score : record.auto ? record.auto.score : null;
  if (base == null) return null;
  const d = lyricsEffect(record.lyrics).intensity;
  return d ? Math.round(Math.max(0, Math.min(SCORE_MAX, base + d)) * 10) / 10 : base;
}

/** Mood axis: model valence shifted by the lyrics rating. */
export function computeValence(record) {
  const v = record.auto?.music?.mood?.valence;
  if (v == null) return null;
  return Math.round(Math.max(0, Math.min(100, v + lyricsEffect(record.lyrics).valence)) * 10) / 10;
}

/** Stores (or clears) the user's rating of the lyrics. */
export function setLyricsRating(record, rating) {
  record.lyrics = rating?.mood ? { mood: rating.mood, strength: Math.max(1, Math.min(3, rating.strength ?? 2)), at: Date.now() } : null;
  if (rating?.mood) record.vocals = { state: "vocal", source: "user", at: Date.now() };
  const prev = record.finalScore;
  record.finalScore = computeFinal(record);
  record.updatedAt = Date.now();
  if (record.finalScore !== prev) pushHistory(record, rating?.mood ? "lyrics" : "lyrics removed", record.finalScore);
}

export function setVocals(record, stateValue, source = "user") {
  record.vocals = stateValue ? { state: stateValue, source, at: Date.now() } : null;
  if (stateValue === "instrumental") record.lyrics = null;
  record.finalScore = computeFinal(record);
  record.updatedAt = Date.now();
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
