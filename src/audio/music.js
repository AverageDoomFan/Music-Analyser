// Musical descriptors computed from the extractor's frame data: key / mode
// (chroma + Krumhansl-Kessler profiles, Camelot wheel), timbre fingerprint
// helpers (MFCC), song structure (self-similarity novelty). Pure functions.

export const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// usual spellings: flats for major keys, sharps for most minor keys
const MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

// Krumhansl-Kessler key profiles (C major / C minor)
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Camelot numbers by tonic pitch class
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];  // C=8B, Db=3B, D=10B…
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];  // Cm=5A, C#m=12A, Dm=7A…

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    s += x * y; sa += x * x; sb += y * y;
  }
  return sa && sb ? s / Math.sqrt(sa * sb) : 0;
}

/**
 * Key from a 12-bin chroma vector (index 0 = C).
 * @returns {{index:number, tonic:number, mode:"major"|"minor", confidence:number}}
 *   index = tonic for major (0..11), 12 + tonic for minor; confidence 0..1
 */
export function detectKey(chroma) {
  let sum = 0;
  for (const v of chroma) sum += v;
  if (!(sum > 0)) return { index: -1, tonic: -1, mode: null, confidence: 0 };
  const scores = [];
  for (let t = 0; t < 12; t++) {
    const rot = (p) => Array.from({ length: 12 }, (_, i) => p[(i - t + 12) % 12]);
    scores.push({ index: t, r: pearson(chroma, rot(MAJOR)) });
    scores.push({ index: 12 + t, r: pearson(chroma, rot(MINOR)) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  // relative major/minor share the same notes: margin to the best *other* key family
  const second = scores.find((s) => s.index !== best.index && s.index !== relative(best.index)) ?? scores[1];
  const confidence = Math.max(0, Math.min(1, (best.r - second.r) / 0.25)) * Math.max(0, Math.min(1, best.r / 0.6));
  return { index: best.index, tonic: best.index % 12, mode: best.index < 12 ? "major" : "minor", confidence: round3(confidence) };
}

/** Relative key (C major ↔ A minor). */
export function relative(index) {
  return index < 12 ? 12 + ((index + 9) % 12) : (index - 12 + 3) % 12;
}

export function keyName(index) {
  if (index == null || index < 0) return "—";
  return index < 12 ? MAJOR_NAMES[index] : `${MINOR_NAMES[index - 12]}m`;
}

/** Camelot code, e.g. "8B" (C major) or "8A" (A minor). */
export function camelot(index) {
  if (index == null || index < 0) return null;
  const t = index % 12;
  return index < 12 ? `${CAMELOT_MAJOR[t]}B` : `${CAMELOT_MINOR[t]}A`;
}

/**
 * Harmonic distance between two keys on the Camelot wheel: 0 same key,
 * 1 compatible (±1 on the wheel, or relative major/minor), 2 = ±2 or
 * diagonal, more = clash. null when a key is unknown.
 */
export function keyDistance(a, b) {
  if (a == null || b == null || a < 0 || b < 0) return null;
  const ca = camelot(a), cb = camelot(b);
  const na = parseInt(ca, 10), nb = parseInt(cb, 10);
  const d = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  const sameLetter = ca.at(-1) === cb.at(-1);
  return sameLetter ? d : d + 1;
}

/** 0..1 harmonic compatibility for transitions. */
export function keyCompatibility(a, b) {
  const d = keyDistance(a, b);
  if (d == null) return 0.5;
  return [1, 0.85, 0.5, 0.25][d] ?? 0.05;
}

// ---------------------------------------------------------------- MFCC

/** Triangular mel filterbank over FFT bins (sparse). */
export function melFilterbank(nFilters, nBins, binHz, fLo, fHi) {
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const inv = (m) => 700 * (10 ** (m / 2595) - 1);
  const pts = [];
  for (let i = 0; i < nFilters + 2; i++) pts.push(inv(mel(fLo) + ((mel(fHi) - mel(fLo)) * i) / (nFilters + 1)));
  const filters = [];
  for (let m = 1; m <= nFilters; m++) {
    const [a, b, c] = [pts[m - 1], pts[m], pts[m + 1]];
    const k0 = Math.max(1, Math.floor(a / binHz)), k1 = Math.min(nBins - 1, Math.ceil(c / binHz));
    const idx = [], w = [];
    for (let k = k0; k <= k1; k++) {
      const f = k * binHz;
      const v = f < b ? (f - a) / (b - a) : (c - f) / (c - b);
      if (v > 0) { idx.push(k); w.push(v); }
    }
    filters.push({ idx: Int32Array.from(idx), w: Float64Array.from(w) });
  }
  return filters;
}

/** DCT-II matrix rows 1..n (c0, the level, is dropped). */
export function dctMatrix(n, size) {
  const out = [];
  for (let k = 1; k <= n; k++) {
    const row = new Float64Array(size);
    for (let i = 0; i < size; i++) row[i] = Math.cos((Math.PI * k * (i + 0.5)) / size) * Math.sqrt(2 / size);
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- structure

/**
 * Sections from block feature vectors (one per ~0.5 s): novelty of the
 * self-similarity matrix (checkerboard kernel), boundaries at novelty peaks,
 * then genre-neutral labels from the relative level of each section.
 * @param {number[][]} vectors  per-block features (any scale)
 * @param {number[]} levelDb    per-block level
 * @param {number} blockSec
 * @returns {{start:number,end:number,label:string,level:number}[]} level relative to the loudest section (dB)
 */
export function detectSections(vectors, levelDb, blockSec, { kernelSec = 6, minSec = 8 } = {}) {
  const n = vectors.length;
  if (n * blockSec < minSec * 2) return n ? [{ start: 0, end: n * blockSec, label: "Section", level: 0 }] : [];
  const dim = vectors[0].length;
  // z-score each dimension, then unit-normalise each block
  const mu = new Float64Array(dim), sd = new Float64Array(dim);
  for (const v of vectors) for (let d = 0; d < dim; d++) mu[d] += v[d] / n;
  for (const v of vectors) for (let d = 0; d < dim; d++) sd[d] += (v[d] - mu[d]) ** 2 / n;
  const X = vectors.map((v) => {
    const z = v.map((x, d) => (sd[d] > 1e-12 ? (x - mu[d]) / Math.sqrt(sd[d]) : 0));
    const norm = Math.hypot(...z) || 1;
    return z.map((x) => x / norm);
  });
  const L = Math.max(2, Math.round(kernelSec / blockSec));
  const sim = (i, j) => {
    let s = 0;
    const a = X[i], b = X[j];
    for (let d = 0; d < dim; d++) s += a[d] * b[d];
    return s;
  };
  // Gaussian-tapered checkerboard kernel
  const g = (u) => Math.exp(-0.5 * (u / (L * 0.5)) ** 2);
  const nov = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let i = -L; i < L; i++) {
      const a = t + i;
      if (a < 0 || a >= n) continue;
      for (let j = -L; j < L; j++) {
        const b = t + j;
        if (b < 0 || b >= n) continue;
        const sign = (i < 0) === (j < 0) ? 1 : -1;
        s += sign * g(i + 0.5) * g(j + 0.5) * sim(a, b);
      }
    }
    nov[t] = Math.max(0, s);
  }
  let m = 0, v = 0;
  for (const x of nov) m += x / n;
  for (const x of nov) v += (x - m) ** 2 / n;
  const thresh = m + 0.35 * Math.sqrt(v);
  const minBlocks = Math.round(minSec / blockSec);
  const peaks = [];
  for (let t = minBlocks; t < n - minBlocks; t++) {
    if (nov[t] < thresh) continue;
    let isMax = true;
    for (let k = Math.max(0, t - L); k <= Math.min(n - 1, t + L); k++) if (nov[k] > nov[t]) { isMax = false; break; }
    if (isMax && (!peaks.length || t - peaks.at(-1) >= minBlocks)) peaks.push(t);
  }
  const bounds = [0, ...peaks, n];
  const secs = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i], b = bounds[i + 1];
    const lv = levelDb.slice(a, b);
    const mean = lv.reduce((x, y) => x + y, 0) / lv.length;
    // level trend inside the section (first vs last quarter)
    const q = Math.max(1, Math.floor(lv.length / 4));
    const rise = avg(lv.slice(-q)) - avg(lv.slice(0, q));
    secs.push({ a, b, mean, rise });
  }
  const sorted = levelDb.slice().sort((x, y) => x - y);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const hi = pct(0.75), med = pct(0.5), lo = pct(0.3);
  const top = Math.max(...secs.map((s) => s.mean));
  return secs.map((s, i) => {
    let label = "Section";
    const next = secs[i + 1];
    if (s.mean >= hi - 1.5) label = "Pic";
    else if (i === 0 && s.mean < med - 1) label = "Intro";
    else if (i === secs.length - 1 && s.mean < med - 1) label = "Outro";
    else if (s.rise > 4 && next && next.mean >= hi - 1.5) label = "Montée";
    else if (s.mean <= lo && i > 0 && i < secs.length - 1) label = "Break";
    return { start: round2(s.a * blockSec), end: round2(s.b * blockSec), label, level: round2(s.mean - top) };
  });
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function round2(x) { return Math.round(x * 100) / 100; }
function round3(x) { return Math.round(x * 1000) / 1000; }
