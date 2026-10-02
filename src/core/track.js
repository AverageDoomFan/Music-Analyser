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
//   draft: boolean          // Live "follow" capture heard < 60 %: kept out of stats and games until validated
//   cloud: null | { shared: extractor code of the shared entry, community: null | { mean, n } (votes of every user),
//                   vote: my vote as stored online, validated: score I agreed with (a vote), at }
// }

import { ALGORITHM_VERSION, FEATURE_VERSION, DEFAULT_WEIGHTS, DEFAULT_AGGREGATION } from "../config.js";
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
  record.manual = value == null ? null : { score: Math.max(0, Math.round(value)), createdAt: Date.now() };
  record.finalScore = computeFinal(record);
  record.updatedAt = Date.now();
  pushHistory(record, value == null ? "manual score removed" : "manual score", record.finalScore);
}

let useCommunity = true;
/** Whether the community score (mean of everyone's votes) replaces the automatic one. */
export const setUseCommunity = (on) => { useCommunity = !!on; };

/** The community score that applies to a record (null when none or turned off). */
export const communityScore = (record) => (useCommunity && record?.cloud?.community?.n > 0 && Number.isFinite(record.cloud.community.mean) ? record.cloud.community.mean : null);

/**
 * Manual score wins; then the correction; then the community score (the votes
 * already include each voter's own adjustments); otherwise the automatic score.
 * The correction and automatic scores are shifted by the lyrics rating.
 */
export function computeFinal(record) {
  record.valence = computeValence(record);
  if (record.manual) return record.manual.score;
  const community = record.correction ? null : communityScore(record);
  if (community != null && record.auto) return community;
  const base = record.correction ? record.correction.score : record.auto ? record.auto.score : null;
  if (base == null) return null;
  const d = lyricsEffect(record.lyrics).intensity;
  return d ? Math.round(Math.max(0, base + d) * 10) / 10 : base;
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

/** A draft (partly heard Live capture) waits for the user's validation. */
export const isDraft = (record) => !!record?.draft;

/** Analysed and not a draft: what stats, games, sets and progressions use. */
export const isCounted = (record) => record?.finalScore != null && !record.draft;

export const needsReanalysis = (record) => !!record.features && record.featureVersion !== FEATURE_VERSION;

/** Compares dotted versions numerically ("1.10" > "1.9"); a missing version is the oldest. */
export function compareVersions(a, b) {
  const pa = String(a ?? "0").split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b ?? "0").split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Stored features come from an older extractor than FEATURE_VERSION (the audio must be analysed again). */
export const featuresOutdated = (record) =>
  !!record?.features && compareVersions(record.features.featureVersion ?? record.featureVersion, FEATURE_VERSION) < 0;

function pushHistory(record, kind, score) {
  record.history = [...(record.history ?? []), { at: Date.now(), kind, score, algorithmVersion: ALGORITHM_VERSION }].slice(-MAX_HISTORY);
}

/**
 * How the score moved since the last algorithm update: the current score
 * against the last one recorded under an older algorithm version.
 * Null when the track was only ever scored by the current version.
 * @returns {{ delta:number, from:string, before:number } | null}
 */
export function algoTrend(record) {
  if (record?.finalScore == null) return null;
  const h = record.history ?? [];
  for (let i = h.length - 1; i >= 0; i--) {
    const e = h[i];
    if (e?.algorithmVersion && e.algorithmVersion !== ALGORITHM_VERSION && Number.isFinite(e.score)) {
      return { delta: record.finalScore - e.score, from: e.algorithmVersion, before: e.score };
    }
  }
  return null;
}
