// Intensity model: raw features -> 8 interpretable sub-scores -> 0..100, and
// beyond for what is off the charts.
//
// The score is a practical perceptual ranking tool, not a scientific measure.
// No genre rule anywhere: only audio features. To replace the model, write a
// module exposing the same functions and point src/scoring/index.js to it.

import { ALGORITHM_VERSION, CALIBRATION, DEFAULT_WEIGHTS, DEFAULT_AGGREGATION, SUBSCORE_SCALES, ATTACK_POINTS } from "../config.js";
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
const ATTACK_MAX = ATTACK_POINTS.at(-1)[1];
/** Points for a regular attack rate (hits/s), see ATTACK_POINTS. */
export function attackPoints(rate) {
  return rate > 0 ? interp(ATTACK_POINTS, rate) : 0;
}

function components(raw) {
  const f = withFallbacks(raw);
  const hf = (f.bandEnergy?.highMid ?? 0) + (f.bandEnergy?.high ?? 0);
  const flatDb = db(f.flatnessMedian);
  // Everything below is level independent: the extractor normalises each
  // file to a reference loudness, so the mastering level never counts.
  // Ranges follow real libraries (not theoretical extremes): a loud, dense
  // modern pop mix must not max out what a metal or hardcore track reaches.
  // a low peak-to-loudness ratio (limiter, clipping) only means "crushed"
  // when there are attacks: a sustained pad has it naturally
  const active = lin(f.onsetRate, 0.5, 3);
  // 2.3: a wider PLR range and more weight (heavy genres sit at 5-8 dB, loud
  // pop at 9-11). A steady level no longer counts: loud pop is steadier than
  // metal, it said nothing about intensity.
  const squash = (1 - lin(f.plrDb, 4.5, 13)) * active;
  const onsets = lin(f.onsetRate, 0.5, 12);
  const motion = lin(f.onsetEnvMean, 0.05, 0.17);
  const clip = lin(Math.log10(f.clippingRatio + 1e-6), -5, -1.5);
  const conf = clamp01(f.bpmConfidence);
  const bpmNorm = f.bpm ? lin(f.bpm, 60, 180) : onsets;
  const bassPresence = lin(f.bassRatio, 0.05, 0.35);  // low-end measures only count if there is a low end
  const kicks = lin(f.lowPulse, 0.13, 0.28) * bassPresence;
  // kicks per second, never folded (speedcore, extratone); only when the low
  // end has a clear regular pulse. Extractor 1.4+.
  const kickSpeed = f.pulseRate != null
    ? lin(f.pulseRate, 2.5, 9) * lin(f.pulseStrength, 0.3, 0.5) * lin(f.lowPulse, 0.06, 0.12) * bassPresence
    : null;
  // distortion: flatness of the mids (extractor 1.4+), else the whole spectrum.
  // 2.3: range up to -4 dB, it was saturated on nearly every real master.
  const distortion = f.midFlatnessMedian != null ? lin(db(f.midFlatnessMedian), -32, -4) : lin(flatDb, -34, -10);

  return {
    energy: [
      ["Spectral motion", motion, 0.35],
      ["Attack density", lin(f.onsetRate, 1, 8), 0.15],
      ["Low-end attacks", kicks, 0.2],
      ["Crushed master", squash, 0.6],
    ],
    tempo: [
      ["Onsets / s", onsets, 0.55],
      ["BPM (weighted by reliability)", conf * bpmNorm + (1 - conf) * onsets, 0.45],
      ...(kickSpeed != null ? [["Kick speed", kickSpeed, 0]] : []),
    ],
    density: [
      ["Spectral fill", lin(f.spectralFill, 0.13, 0.65), 0.4],
      ["Bandwidth", lin(f.bandwidthMean, 1000, 4500), 0.25],
      ["Attack density", lin(f.onsetRate, 1, 10), 0.2],
      ["Tight dynamics", (1 - lin(f.loudnessRange, 3, 16)) * active, 0.15],
    ],
    brightness: [
      ["Centroid", lin(f.centroidMean, 500, 5000), 0.4],
      ["Rolloff", lin(f.rolloffMean, 1500, 12000), 0.3],
      ["Energy > 2 kHz", lin(hf, 0.01, 0.3), 0.3],
    ],
    harshness: [
      ["Distortion", distortion, 0.84],
      ["High-frequency energy", lin(hf, 0.02, 0.35), 0.1],
      ["Centroid", lin(f.centroidMean, 1500, 4500), 0.15],
      ["Spectral flux", lin(f.fluxMean, 0.15, 0.23), 0.15],
      ["Clipping", clip, 0.1],
      ["Saturation / compression", (1 - lin(f.crestDb, 7, 13)) * active, 0.15],
    ],
    // what makes a track "heavy": kick / bass attacks, hard-hitting kicks and
    // a crushed master. A strong low end alone is common to almost every
    // modern mix (calm ones included): it weighs little.
    pressure: [
      ["Low-end attacks (kicks)", kicks, 0.45],
      ["Kick punch", lin(f.kickPunch, 0.6, 1.1) * bassPresence, 0.15],
      ["Crushed master (low PLR)", squash * bassPresence, 0.75],
      ["Low-end weight", lin(f.bassRatio, 0.4, 0.9), 0.15],
    ],
    complexity: [
      // unpredictability, not busyness: a dense but perfectly regular loop is simple
      ["Irregular rhythm", lin(f.ioiCv, 0.3, 0.6) * lin(f.onsetRate, 0.5, 3), 0.35],
      ["Non-repetitive pulse", (1 - conf) * lin(f.onsetRate, 0.5, 3), 0.25],
      ["Centroid variation", lin(f.centroidStd, 300, 2000), 0.2],
      ["Flux variation", lin(f.fluxStd, 0.03, 0.12), 0.2],
    ],
    // 2.4, extractor 1.7+: fast regular attacks. Not a dimension of the base:
    // points on top of the calibrated score (see computeIntensity), here as a
    // share of the maximum
    ...(f.fastPulseShare != null ? {
      attackSpeed: [["Attacks / s", attackPoints(f.fastPulseRate) / ATTACK_MAX
        * lin(f.fastPulseShare, 0.2, 0.6) * lin(f.fastPulseStrength, 0.2, 0.5), 1]],
    } : {}),
    noise: [
      ["Spectral flatness", lin(flatDb, -25, -3), 0.45],
      ["Full spectrum", lin(f.spectralFill, 0.3, 0.95), 0.2],
      ["Few tonal peaks", 1 - lin(f.spectralCrestMean, 5, 60), 0.15],
      ["Clipping", clip, 0.1],
      ["Crushed (low crest)", 1 - lin(f.crestDb, 3, 10), 0.1],
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
    // very fast kicks are fast whatever the (folded) BPM says
    if (dim === "tempo") value = Math.max(value, list.find(([label]) => label === "Kick speed")?.[1] ?? 0);
    subscores[dim] = round1(toDisplay(dim, value) * 100);
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
 * towards 100, but only once the track is already intense or harsh, so a
 * noisy yet soft texture (rain, tape hiss) is not ranked as extreme.
 */
export function computeIntensity(subscores, weights = DEFAULT_WEIGHTS) {
  const score = calibrate(rawIntensity(subscores, weights));
  // fast regular attacks add points, up to beyond what the calibrated scale reaches
  const attacks = clamp01((subscores.attackSpeed ?? 0) / 100) * lin(score, 50, 85);
  return round1(score + ATTACK_MAX * attacks);
}


/** Intensity before calibration, 0..1. */
export function rawIntensity(subscores, weights = DEFAULT_WEIGHTS) {
  // the weights work on the model's internal scale, not the displayed one
  const m = (dim) => toModel(dim, (subscores[dim] ?? 0) / 100);
  let s = 0, w = 0;
  for (const dim of Object.keys(subscores)) {
    if (dim === "noise" || dim === "attackSpeed") continue;
    const wi = Math.max(0, weights[dim] ?? 0);
    s += wi * m(dim);
    w += wi;
  }
  const base = w ? s / w : 0;
  const noise = m("noise");
  const gate = smoothstep(0.35, 0.7, Math.max(base, 0.9 * m("harshness")));
  const push = clamp01(Math.max(0, weights.noise ?? 0) * noise * gate);
  return base + (1 - base) * push;
}

/** Piecewise-linear interpolation through increasing points [[x, y], ...]. */
function interp(points, x, from = 0, to = 1) {
  if (x <= points[0][from]) return points[0][to];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (x <= b[from]) return a[to] + ((x - a[from]) / (b[from] - a[from])) * (b[to] - a[to]);
  }
  return points.at(-1)[to];
}

/** Internal sub-score (0..1) → displayed sub-score (0..1), see SUBSCORE_SCALES. */
export function toDisplay(dim, v) {
  const p = SUBSCORE_SCALES[dim];
  return p ? interp(p, clamp01(v)) : clamp01(v);
}

/** Displayed sub-score (0..1) → internal sub-score (0..1). */
export function toModel(dim, v) {
  const p = SUBSCORE_SCALES[dim];
  return p ? interp(p, clamp01(v), 1, 0) : clamp01(v);
}

export function calibrate(raw) {
  const x = clamp01(raw);
  for (let i = 1; i < CALIBRATION.length; i++) {
    const [x0, y0] = CALIBRATION[i - 1];
    const [x1, y1] = CALIBRATION[i];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return CALIBRATION.at(-1)[1];
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
    // extractor 1.7 kept no per-window attack rate
    if (w.fastPulseShare != null) w.fastPulseRate ??= features.fastPulseRate;
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
