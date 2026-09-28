// Intensity model v1.0: raw features -> 8 interpretable sub-scores -> 0..100.
//
// The score is a practical perceptual ranking tool, not a scientific measure.
// No genre rule anywhere: only audio features. To replace the model, write a
// module exposing the same functions and point src/scoring/index.js to it.

import { ALGORITHM_VERSION, CALIBRATION, DEFAULT_WEIGHTS, DEFAULT_AGGREGATION } from "../config.js";
import { aggregate, aggregateAll } from "./aggregate.js";
import { describeMusic } from "./describe.js";

const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
/** Linear map of x from [lo, hi] to [0, 1], clamped. */
const lin = (x, lo, hi) => clamp01((x - lo) / (hi - lo));
const smoothstep = (lo, hi, x) => {
  const t = lin(x, lo, hi);
  return t * t * (3 - 2 * t);
};
const db = (x) => 10 * Math.log10(Math.max(x, 1e-12));

/**
 * Each dimension is a weighted blend of normalised components (0..1).
 * Keeping components explicit lets the UI explain a score and lets us derive
 * a confidence from how much the components agree.
 */
function components(raw) {
  const f = withFallbacks(raw);
  const hf = (f.bandEnergy?.highMid ?? 0) + (f.bandEnergy?.high ?? 0);
  const flatDb = db(f.flatnessMedian);
  // Everything below is level independent: the extractor normalises each
  // file to a reference loudness, so the mastering level never counts.
  const squash = 1 - lin(f.plrDb, 5, 16);              // peak-to-loudness ratio: limiter / clipping
  const steady = 1 - lin(f.loudnessRange, 3, 16);
  const onsets = lin(f.onsetRate, 0.5, 12);
  const motion = lin(f.onsetEnvMean, 0.005, 0.2);
  const clip = lin(Math.log10(f.clippingRatio + 1e-6), -5, -1.5);
  const conf = clamp01(f.bpmConfidence);
  const bpmNorm = f.bpm ? lin(f.bpm, 60, 180) : onsets;
  const bassPresence = lin(f.bassRatio, 0.05, 0.35);  // low-end measures only count if there is a low end
  const lowPunch = lin(f.lowPulse, 0.02, 0.25) * bassPresence;

  return {
    energy: [
      ["Mouvement spectral", motion, 0.35],
      ["Densité d'attaques", lin(f.onsetRate, 0.5, 8), 0.2],
      ["Dynamique resserrée", steady, 0.15],
      ["Attaques dans le grave", lowPunch, 0.15],
      ["Écrasement", squash, 0.15],
    ],
    tempo: [
      ["Onsets / s", onsets, 0.55],
      ["BPM (pondéré par la fiabilité)", conf * bpmNorm + (1 - conf) * onsets, 0.45],
    ],
    density: [
      ["Remplissage spectral", lin(f.spectralFill, 0.05, 0.6), 0.35],
      ["Largeur de bande", lin(f.bandwidthMean, 500, 4500), 0.2],
      ["Densité d'attaques", lin(f.onsetRate, 0.5, 10), 0.2],
      ["Dynamique resserrée", steady, 0.15],
      ["Peu de silences", lin(1 - f.silenceRatio, 0.7, 1), 0.1],
    ],
    brightness: [
      ["Centroïde", lin(f.centroidMean, 500, 5000), 0.4],
      ["Rolloff", lin(f.rolloffMean, 1500, 12000), 0.3],
      ["Énergie > 2 kHz", lin(hf, 0.01, 0.3), 0.3],
    ],
    harshness: [
      ["Planéité spectrale", lin(flatDb, -40, -8), 0.25],
      ["Énergie aiguë", lin(hf, 0.02, 0.35), 0.15],
      ["Centroïde", lin(f.centroidMean, 800, 5000), 0.15],
      ["Flux spectral", lin(f.fluxMean, 0.05, 0.22), 0.15],
      ["Transitoires", motion, 0.1],
      ["Clipping", clip, 0.1],
      ["Saturation / compression", 1 - lin(f.crestDb, 4, 14), 0.1],
    ],
    pressure: [
      ["Attaques dans le grave (kicks)", lowPunch, 0.3],
      ["Poids du grave", lin(f.bassRatio, 0.15, 0.85), 0.2],
      ["Grave soutenu", (1 - lin(f.lowBandDbStd, 1.5, 12)) * bassPresence, 0.15],
      ["Saturation du grave", lin(db(f.lowFlatnessMedian), -30, -5) * bassPresence, 0.15],
      ["Écrasement (PLR faible)", squash, 0.2],
    ],
    complexity: [
      ["Variation du centroïde", lin(f.centroidStd, 100, 1500), 0.35],
      ["Variation du flux", lin(f.fluxStd, 0.02, 0.1), 0.35],
      ["Rythme irrégulier et rapide", lin(f.onsetRate, 1, 10) * lin(f.ioiCv, 0.2, 1), 0.3],
    ],
    noise: [
      ["Planéité spectrale", lin(flatDb, -25, -3), 0.45],
      ["Spectre rempli", lin(f.spectralFill, 0.3, 0.95), 0.2],
      ["Peu de pics tonals", 1 - lin(f.spectralCrestMean, 5, 60), 0.15],
      ["Clipping", clip, 0.1],
      ["Écrasement (crest faible)", 1 - lin(f.crestDb, 3, 10), 0.1],
    ],
  };
}

/**
 * Features extracted by an older extractor lack some fields: approximate them
 * so old tracks keep a sensible score until they are re-analysed.
 */
function withFallbacks(f) {
  if (f.lowPulse != null) return f;
  return {
    ...f,
    lowPulse: (f.onsetEnvMean ?? 0) * 1.3,
    lowBandDbStd: f.rmsDbStd ?? 6,
    lowFlatnessMedian: f.flatnessMedian ?? 0,
    plrDb: f.plrDb ?? (f.crestDb ?? 12) + 2,
  };
}

function blend(list) {
  let s = 0, w = 0;
  for (const [, v, wi] of list) { s += v * wi; w += wi; }
  return w ? s / w : 0;
}

function agreement(list) {
  const m = blend(list);
  let v = 0, w = 0;
  for (const [, x, wi] of list) { v += wi * (x - m) ** 2; w += wi; }
  return clamp01(1 - 1.8 * Math.sqrt(v / w));
}

/**
 * @returns {{subscores:Object<string,number>, confidences:Object<string,number>, explain:Object}}
 * sub-scores and confidences on 0..100 / 0..1.
 */
export function computeSubscores(features) {
  const comps = components(features);
  const subscores = {};
  const confidences = {};
  const explain = {};
  for (const [dim, list] of Object.entries(comps)) {
    let value = blend(list);
    if (dim === "noise") value = value ** 1.2; // keep melodic music near zero
    subscores[dim] = round1(value * 100);
    confidences[dim] = round3(agreement(list));
    explain[dim] = list.map(([label, v, w]) => ({ label, value: round3(v), weight: w }));
  }
  // Tempo reliability comes first from the beat tracker itself.
  const onsetPart = comps.tempo[0][1];
  const bpmNorm = features.bpm ? lin(features.bpm, 60, 180) : onsetPart;
  confidences.tempo = round3(0.6 * clamp01(features.bpmConfidence) + 0.4 * (1 - Math.abs(onsetPart - bpmNorm)));
  // Very short analyses are less trustworthy overall.
  const lengthFactor = lin(features.analyzedSeconds ?? 60, 5, 30) * 0.3 + 0.7;
  for (const k of Object.keys(confidences)) confidences[k] = round3(confidences[k] * lengthFactor);
  return { subscores, confidences, explain };
}

/**
 * Global intensity from sub-scores (0..100) and weights. The weighted mean of
 * the "musical" dimensions gives the base; `noise` then pushes the score
 * towards 100, but only once the base is already intense, so a noisy yet
 * quiet texture is not ranked as extreme.
 */
export function computeIntensity(subscores, weights = DEFAULT_WEIGHTS) {
  let s = 0, w = 0;
  for (const [dim, value] of Object.entries(subscores)) {
    if (dim === "noise") continue;
    const wi = Math.max(0, weights[dim] ?? 0);
    s += wi * (value / 100);
    w += wi;
  }
  const base = w ? s / w : 0;
  const noise = (subscores.noise ?? 0) / 100;
  const gate = smoothstep(0.35, 0.7, base);
  const push = clamp01(Math.max(0, weights.noise ?? 0) * noise * gate);
  const raw = base + (1 - base) * push;
  return round1(calibrate(raw));
}

export function calibrate(raw) {
  const x = clamp01(raw);
  for (let i = 1; i < CALIBRATION.length; i++) {
    const [x0, y0] = CALIBRATION[i - 1];
    const [x1, y1] = CALIBRATION[i];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 100;
}

/**
 * Rebuilds one feature object per timeline window. Track-level properties
 * (dynamic range, clipping, analysed length) are shared by every window.
 * Features without a timeline (older extractor) yield a single window.
 */
export function timelineWindows(features) {
  const tl = features.timeline;
  if (!tl?.times?.length) return { times: [features.duration ? features.duration / 2 : 0], windows: [features] };
  const context = {
    loudnessRange: features.loudnessRange,
    clippingRatio: features.clippingRatio,
    analyzedSeconds: features.analyzedSeconds,
    featureVersion: features.featureVersion,
  };
  const windows = tl.times.map((_, i) => {
    const w = { ...context };
    for (const [k, arr] of Object.entries(tl.series)) w[k] = arr[i];
    w.bandEnergy = { sub: w.bandSub, bass: w.bandBass, lowMid: w.bandLowMid, highMid: w.bandHighMid, high: w.bandHigh };
    return w;
  });
  return { times: tl.times, windows };
}

/** Sub-scores and intensity of every window: the curves of a track. */
export function computeCurves(features, weights = DEFAULT_WEIGHTS) {
  const { times, windows } = timelineWindows(features);
  const intensity = [];
  const subscores = {};
  const perWindow = [];
  for (const w of windows) {
    const s = computeSubscores(w).subscores;
    perWindow.push(s);
    intensity.push(computeIntensity(s, weights));
    for (const [dim, v] of Object.entries(s)) (subscores[dim] ??= []).push(v);
  }
  return { times, intensity, subscores, perWindow };
}

/**
 * Full automatic scoring. The score is an aggregation (see AGGREGATIONS) of
 * the intensity curve; displayed sub-scores use the same aggregation of their
 * own curves. Confidences and explanations describe the whole track.
 */
export function scoreFeatures(features, weights = DEFAULT_WEIGHTS, aggregation = DEFAULT_AGGREGATION) {
  const curves = computeCurves(features, weights);
  const stats = aggregateAll(curves.intensity, curves.times);
  const subscores = {};
  for (const [dim, values] of Object.entries(curves.subscores)) subscores[dim] = round1(aggregate(values, aggregation, curves.times));
  const { confidences, explain } = computeSubscores(features);
  return {
    algorithmVersion: ALGORITHM_VERSION,
    aggregation,
    subscores,
    confidences,
    explain,
    stats,
    score: stats[aggregation],
    curves: { times: curves.times, intensity: curves.intensity, subscores: curves.subscores },
    music: describeMusic(features),
  };
}

function round1(x) { return Math.round(x * 10) / 10; }
function round3(x) { return Math.round(x * 1000) / 1000; }
