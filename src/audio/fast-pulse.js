// Attack rate (extractor 1.8): the fastest regular train of hits, from 2 to
// 24 per second (120 to 1450 BPM), measured on the waveform itself.
//
// The frame pass runs at ~86 frames/s: it cannot resolve attacks closer than
// ~25 ms. Here the envelopes of two bands (200–1500 Hz and 2–12 kHz) are
// sampled at ~2 kHz and autocorrelated over 3 s blocks. A drum hit moves both
// bands at once (a broadband click), a hi-hat or a pad moves only one: a
// period counts only if both bands share it. The fastest shared period that
// is nearly as regular as the best one gives the rate (kicks on the beat:
// 2/s; speedcore: 5-10/s; blast beats: 13+/s; extratone: 16+/s).
//
// Faster than 24/s, a kick train is physically a pitched tone (49 kicks/s is
// a G1): it cannot be told from a distorted bass note, so it is not counted.
// A tone also correlates at every multiple of its period (a low power chord
// every 25-35 ms): a lag counts only if its fractions correlate much less.

import { FFT } from "./fft.js";

const ENV_RATE = 2000;
const LAG_MIN_S = 0.042, LAG_MAX_S = 0.5;
const NEAR_BEST = 0.6;
const BLOCK_S = 3, BLOCK_HOP_S = 1.5;
const MIN_R = 0.18;
const MATCH_S = 0.0015;

function biquad(type, f0, sr, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f0) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
  const a0 = 1 + al;
  const b = type === "lp" ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * cw) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function step(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
}

/** Rectified envelope of the lo..hi band of mono[s..e), low-passed at 110 Hz, one value per `dec` samples. */
function bandEnvelope(mono, s, e, sr, lo, hi, dec) {
  const chain = [biquad("hp", lo, sr), biquad("hp", lo, sr), biquad("lp", Math.min(hi, sr * 0.45), sr), biquad("lp", Math.min(hi, sr * 0.45), sr)];
  const smooth = [biquad("lp", 110, sr), biquad("lp", 110, sr)];
  const out = new Float32Array(Math.floor((e - s) / dec));
  let acc = 0, n = 0, k = 0;
  for (let i = s; i < e && k < out.length; i++) {
    let v = mono[i];
    for (const f of chain) v = step(f, v);
    v = v < 0 ? -v : v;
    for (const f of smooth) v = step(f, v);
    acc += v;
    if (++n === dec) { out[k++] = acc / dec; acc = 0; n = 0; }
  }
  return out;
}

/** Normalised autocorrelation of env[a..b) (moving average removed), through an FFT. */
function blockAc(fft, env, a, b, lagMax, W) {
  const n = b - a;
  const pre = new Float64Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += env[a + i]; pre[i + 1] = acc; }
  const { size, re, im, rev } = fft;
  re.fill(0); im.fill(0);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(n, i + W + 1);
    re[rev[i]] = env[a + i] - (pre[hi] - pre[lo]) / (hi - lo);
  }
  fft.transform();
  // power spectrum, then back (real and symmetric: a forward transform will do)
  const pw = new Float64Array(size);
  for (let k = 0; k < size; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
  for (let k = 0; k < size; k++) { re[rev[k]] = pw[k]; im[rev[k]] = 0; }
  fft.transform();
  const ac = new Float64Array(lagMax + 2);
  const zero = re[0];
  if (zero <= 0) return ac;
  for (let lag = 0; lag <= lagMax + 1; lag++) ac[lag] = re[lag] / zero;
  return ac;
}

function peaks(ac, lagMin, lagMax) {
  const out = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (ac[lag] >= MIN_R && ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1]) out.push(lag);
  }
  return out;
}

/**
 * A periodic tone (a note, a power chord) correlates at every multiple of its
 * period: a peak at `lag` whose half, third... correlates as much comes from
 * a faster period, not from hits `lag` apart.
 */
function pitched(ac, lag, match, lagFloor) {
  for (let k = 2; lag / k >= lagFloor; k++) {
    const c = Math.round(lag / k);
    for (let l = Math.max(lagFloor, c - match); l <= c + match; l++) {
      if (ac[l] > ac[l - 1] && ac[l] >= ac[l + 1] && ac[l] >= 0.7 * ac[lag]) return true;
    }
  }
  return false;
}

/**
 * @returns {{start:number, end:number, rate:number, strength:number}[]} one entry per
 *   3 s block of mono[s..e) (sample positions); rate 0 when nothing fast and regular.
 */
export function fastPulseBlocks(mono, s, e, sampleRate) {
  const dec = Math.max(1, Math.round(sampleRate / ENV_RATE));
  const envRate = sampleRate / dec;
  const mid = bandEnvelope(mono, s, e, sampleRate, 200, 1500, dec);
  const hi = bandEnvelope(mono, s, e, sampleRate, 2000, 12000, dec);
  const lagMin = Math.round(LAG_MIN_S * envRate), lagMax = Math.round(LAG_MAX_S * envRate);
  const match = Math.max(1, Math.round(MATCH_S * envRate));
  const lagFloor = Math.max(2, Math.round(0.005 * envRate));
  const W = Math.round(0.1 * envRate);
  const B = Math.round(BLOCK_S * envRate), H = Math.round(BLOCK_HOP_S * envRate);
  const out = [];
  const n = mid.length;
  let size = 1;
  while (size < Math.min(n, B) + lagMax + 2) size <<= 1;
  const fft = new FFT(size);
  const starts = [];
  for (let a = 0; a + B <= n; a += H) starts.push(a);
  if (!starts.length && n >= Math.round(1.5 * envRate)) starts.push(0);
  for (const a of starts) {
    const b = Math.min(n, a + B);
    const am = blockAc(fft, mid, a, b, lagMax, W);
    const ah = blockAc(fft, hi, a, b, lagMax, W);
    const ph = peaks(ah, lagMin, lagMax);
    const found = [];
    for (const lm of peaks(am, lagMin, lagMax)) {
      const lh = ph.find((l) => Math.abs(l - lm) <= match);
      if (lh == null) continue;
      if (pitched(am, lm, match, lagFloor) && pitched(ah, lh, match, lagFloor)) continue;
      found.push({ lag: (lm + lh) / 2, r: Math.min(am[lm], ah[lh]) });
    }
    // the fastest period nearly as regular as the most regular one
    const top = Math.max(0, ...found.map((c) => c.r));
    const best = found.filter((c) => c.r >= NEAR_BEST * top).sort((a, b) => a.lag - b.lag)[0] ?? null;
    out.push({
      start: s + a * dec,
      end: s + b * dec,
      rate: best ? envRate / best.lag : 0,
      strength: best ? best.r : 0,
    });
  }
  return out;
}
