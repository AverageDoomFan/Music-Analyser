// Raw feature extraction. Pure function: PCM in, plain object out.
// Runs in a Web Worker in the browser and directly in Node for tests.
// These values are NOT scores: they are inputs for src/scoring/model.js.

import { FFT } from "./fft.js";
import { ANALYSIS, FEATURE_VERSION } from "../config.js";

const EPS = 1e-12;
const BANDS = [
  ["sub", 20, 60],
  ["bass", 60, 250],
  ["lowMid", 250, 2000],
  ["highMid", 2000, 6000],
  ["high", 6000, 22050],
];

/**
 * @param {Float32Array} mono  mono PCM, [-1, 1]
 * @param {number} sampleRate
 * @param {object} [extra]     values measured elsewhere (e.g. per-channel clipping)
 * @param {(p:number)=>void} [onProgress]
 */
export function extractFeatures(mono, sampleRate, extra = {}, onProgress = () => {}) {
  const { fftSize: N, hopSize: H } = ANALYSIS;
  const fft = new FFT(N);
  const nBins = N / 2 + 1;
  const binHz = sampleRate / N;
  const nyquist = sampleRate / 2;
  const bin = (hz) => Math.max(1, Math.min(nBins - 1, Math.round(hz / binHz)));
  const kLo = bin(40);
  const kHi = bin(Math.min(16000, nyquist - binHz));
  const kFlatLo = bin(60);
  const bandRanges = BANDS.map(([name, lo, hi]) => [name, bin(lo), bin(Math.min(hi, nyquist))]);

  const segments = chooseSegments(mono.length, sampleRate);
  const analyzedSamples = segments.reduce((a, [s, e]) => a + (e - s), 0);
  const frameRate = sampleRate / H;

  const mag = new Float64Array(nBins);
  const prevLog = new Float64Array(nBins);
  const curNorm = new Float64Array(nBins);
  const prevNorm = new Float64Array(nBins);

  // Accumulators (over non-silent frames)
  const acc = {
    frames: 0, silent: 0,
    centroid: [], bandwidth: [], rolloff: [], flatness: [], flux: [], zcr: [], crest: [], fill: [], rmsDb: [],
    bandPower: Object.fromEntries(BANDS.map(([n]) => [n, 0])),
  };
  const onsetTimes = [];
  const onsetPeaks = [];
  const onsetEnvAll = [];
  let acSum = null;
  let acWeight = 0;
  let totalFrames = 0;
  let framesDone = 0;
  const estFrames = Math.max(1, Math.floor(analyzedSamples / H));

  for (const [segStart, segEnd] of segments) {
    const env = [];
    let havePrev = false;
    for (let off = segStart; off + N <= segEnd || (off === segStart && off < segEnd); off += H) {
      totalFrames++;
      // --- time domain: RMS / ZCR over the frame
      let sq = 0, zc = 0, prev = mono[off];
      const end = Math.min(off + N, segEnd);
      for (let i = off; i < end; i++) {
        const v = mono[i];
        sq += v * v;
        if ((v >= 0) !== (prev >= 0)) zc++;
        prev = v;
      }
      const len = end - off;
      const rms = Math.sqrt(sq / Math.max(1, len));
      const rmsDb = 20 * Math.log10(rms + EPS);

      fft.magnitudes(mono, off, mag);

      // --- onset envelope (log-compressed spectral flux, level dependent on purpose)
      let od = 0;
      for (let k = kLo; k <= kHi; k++) {
        const l = Math.log1p(1000 * mag[k]);
        if (havePrev) {
          const d = l - prevLog[k];
          if (d > 0) od += d;
        }
        prevLog[k] = l;
      }
      od /= kHi - kLo + 1;
      env.push(havePrev ? od : 0);

      if (rmsDb < ANALYSIS.silenceDb) {
        acc.silent++;
        havePrev = true;
        prevNorm.fill(0);
        framesDone++;
        continue;
      }
      acc.frames++;
      acc.rmsDb.push(rmsDb);
      acc.zcr.push(zc / Math.max(1, len));

      // --- spectral shape
      let sumM = 0, sumFM = 0, sumP = 0, maxM = 0, maxP = 0;
      for (let k = kLo; k <= kHi; k++) {
        const m = mag[k];
        const p = m * m;
        sumM += m;
        sumFM += k * binHz * m;
        sumP += p;
        if (m > maxM) maxM = m;
        if (p > maxP) maxP = p;
      }
      const centroid = sumFM / (sumM + EPS);
      let sumVar = 0;
      for (let k = kLo; k <= kHi; k++) {
        const df = k * binHz - centroid;
        sumVar += df * df * mag[k];
      }
      const bandwidth = Math.sqrt(sumVar / (sumM + EPS));
      let cum = 0, rolloff = kHi * binHz;
      const target = 0.85 * sumM;
      for (let k = kLo; k <= kHi; k++) {
        cum += mag[k];
        if (cum >= target) { rolloff = k * binHz; break; }
      }
      // flatness on power spectrum 60 Hz – 16 kHz
      let logSum = 0, linSum = 0, fillCount = 0;
      const nFlat = kHi - kFlatLo + 1;
      const fillThresh = maxP * 1e-4; // -40 dB below the frame's peak bin
      for (let k = kFlatLo; k <= kHi; k++) {
        const p = mag[k] * mag[k];
        logSum += Math.log(p + EPS);
        linSum += p;
        if (p > fillThresh) fillCount++;
      }
      const flatness = Math.exp(logSum / nFlat) / (linSum / nFlat + EPS);
      const crest = maxM / (sumM / (kHi - kLo + 1) + EPS);

      // normalised flux (level independent timbre change)
      let flux = 0;
      for (let k = kLo; k <= kHi; k++) {
        curNorm[k] = mag[k] / (sumM + EPS);
        const d = curNorm[k] - prevNorm[k];
        if (d > 0) flux += d;
      }
      const fluxValid = havePrev && prevNorm[kLo] + prevNorm[kHi] + prevNorm[(kLo + kHi) >> 1] > 0;
      prevNorm.set(curNorm);

      for (const [name, lo, hi] of bandRanges) {
        let p = 0;
        for (let k = lo; k <= hi; k++) p += mag[k] * mag[k];
        acc.bandPower[name] += p;
      }

      acc.centroid.push(centroid);
      acc.bandwidth.push(bandwidth);
      acc.rolloff.push(rolloff);
      acc.flatness.push(flatness);
      acc.crest.push(crest);
      acc.fill.push(fillCount / nFlat);
      if (fluxValid) acc.flux.push(flux);

      havePrev = true;
      framesDone++;
      if ((framesDone & 511) === 0) onProgress(Math.min(0.95, framesDone / estFrames));
    }

    // --- onsets for this segment
    const offsetSec = segStart / sampleRate;
    const picked = pickOnsets(env, frameRate);
    for (const [idx, val] of picked) {
      onsetTimes.push(offsetSec + idx / frameRate);
      onsetPeaks.push(val);
    }
    for (const v of env) onsetEnvAll.push(v);

    // --- tempo autocorrelation for this segment
    const ac = onsetAutocorrelation(env, frameRate);
    if (ac) {
      const w = env.length;
      if (!acSum) acSum = new Float64Array(ac.values.length);
      for (let i = 0; i < ac.values.length; i++) acSum[i] += ac.values[i] * w;
      acWeight += w;
      acSum.lagMin = ac.lagMin;
    }
  }

  // ---------- aggregates ----------
  const nonSilentSeconds = (acc.frames * H) / sampleRate || analyzedSamples / sampleRate;
  const tempo = estimateTempo(acSum, acWeight, frameRate);
  // a periodicity made of barely audible fluctuations is not a reliable beat
  tempo.confidence = Math.round(tempo.confidence * clamp01(mean(onsetPeaks) / 0.05) * 1000) / 1000;
  if (onsetTimes.length < 4) tempo.confidence = 0;
  const onsetEnvMean = mean(onsetEnvAll);
  const loud = loudness(mono, sampleRate, segments);
  const bandTotal = Object.values(acc.bandPower).reduce((a, b) => a + b, 0) + EPS;
  const bandEnergy = Object.fromEntries(Object.entries(acc.bandPower).map(([k, v]) => [k, v / bandTotal]));

  let peak = 0, sumSq = 0, n = 0;
  for (const [s, e] of segments) {
    for (let i = s; i < e; i++) {
      const a = Math.abs(mono[i]);
      if (a > peak) peak = a;
      sumSq += mono[i] * mono[i];
      n++;
    }
  }
  const nonSilentFraction = acc.frames / Math.max(1, totalFrames);
  const globalRms = Math.sqrt(sumSq / Math.max(1, n) / Math.max(0.05, nonSilentFraction));
  const peakDb = 20 * Math.log10(peak + EPS);

  // rhythmic regularity: coefficient of variation of inter-onset intervals
  const ioi = [];
  for (let i = 1; i < onsetTimes.length; i++) {
    const d = onsetTimes[i] - onsetTimes[i - 1];
    if (d > 0 && d < 2) ioi.push(d);
  }
  const ioiCv = ioi.length > 4 ? std(ioi) / (mean(ioi) + EPS) : 1;

  onProgress(1);

  return {
    featureVersion: FEATURE_VERSION,
    sampleRate,
    duration: mono.length / sampleRate,
    analyzedSeconds: analyzedSamples / sampleRate,
    excerpted: segments.length > 1,

    // temporal
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    onsetRate: onsetTimes.length / Math.max(1, nonSilentSeconds),
    onsetStrength: mean(onsetPeaks),           // absolute (level dependent)
    transientStrength: onsetPeaks.length ? mean(onsetPeaks) / (onsetEnvMean + EPS) : 0, // peak vs typical flux
    onsetEnvMean,
    ioiCv,
    rmsDbMean: mean(acc.rmsDb),
    rmsDbStd: std(acc.rmsDb),
    silenceRatio: acc.silent / Math.max(1, totalFrames),

    // spectral
    centroidMean: mean(acc.centroid),
    centroidStd: std(acc.centroid),
    bandwidthMean: mean(acc.bandwidth),
    rolloffMean: mean(acc.rolloff),
    fluxMean: mean(acc.flux),
    fluxStd: std(acc.flux),
    flatnessMean: mean(acc.flatness),
    flatnessMedian: median(acc.flatness),
    zcrMean: mean(acc.zcr),
    spectralCrestMean: mean(acc.crest),
    spectralFill: mean(acc.fill),
    bandEnergy,
    bassRatio: bandEnergy.sub + bandEnergy.bass,
    midRatio: bandEnergy.lowMid + bandEnergy.highMid,
    highRatio: bandEnergy.high,

    // general
    loudnessLufs: loud.integrated,
    loudnessRange: loud.range,
    shortTermMaxLufs: loud.shortTermMax,
    peakDb,
    crestDb: peakDb - 20 * Math.log10(globalRms + EPS),
    clippingRatio: extra.clippingRatio ?? 0,
    channelPeakDb: extra.channelPeakDb ?? peakDb,
  };
}

// ---------------------------------------------------------------------------

function chooseSegments(length, sampleRate) {
  const dur = length / sampleRate;
  if (dur <= ANALYSIS.maxFullAnalysisSeconds) return [[0, length]];
  const segLen = Math.floor(ANALYSIS.excerptSeconds * sampleRate);
  const count = ANALYSIS.excerptCount;
  const usable = length - segLen;
  const segs = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((usable * (i + 0.5)) / count);
    segs.push([start, start + segLen]);
  }
  return segs;
}

function pickOnsets(env, frameRate) {
  const n = env.length;
  if (n < 5) return [];
  const W = Math.max(3, Math.round(0.12 * frameRate));
  const minGap = Math.max(1, Math.round(0.025 * frameRate));
  const globalMean = mean(env);
  const out = [];
  // adaptive threshold: local median + fraction of the global mean
  let last = -Infinity;
  const win = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - W);
    const hi = Math.min(n - 1, i + W);
    win.length = 0;
    for (let j = lo; j <= hi; j++) win.push(env[j]);
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1];
    const thresh = med + 0.35 * globalMean + 0.008;
    const v = env[i];
    if (v <= thresh) continue;
    // local maximum within ±minGap
    let isMax = true;
    for (let j = Math.max(0, i - minGap); j <= Math.min(n - 1, i + minGap); j++) {
      if (env[j] > v) { isMax = false; break; }
    }
    if (!isMax || i - last < minGap) continue;
    out.push([i, v]);
    last = i;
  }
  return out;
}

const TEMPO_MIN = 45;
const TEMPO_MAX = 240;

function onsetAutocorrelation(env, frameRate) {
  const n = env.length;
  const lagMin = Math.floor((frameRate * 60) / TEMPO_MAX);
  const lagMax = Math.ceil((frameRate * 60) / TEMPO_MIN);
  if (n < lagMax * 4) return null;
  const m = mean(env);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i] - m;
  let ac0 = 0;
  for (let i = 0; i < n; i++) ac0 += x[i] * x[i];
  if (ac0 <= EPS) return null;
  const values = new Float64Array(lagMax - lagMin + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    values[lag - lagMin] = s / ac0 * (n / (n - lag));
  }
  return { values, lagMin };
}

function estimateTempo(acSum, weight, frameRate) {
  if (!acSum || weight <= 0) return { bpm: null, confidence: 0 };
  const values = Array.from(acSum, (v) => v / weight);
  const lagMin = acSum.lagMin;
  let best = -1, bestScore = -Infinity;
  for (let i = 1; i < values.length - 1; i++) {
    const lag = lagMin + i;
    const bpm = (60 * frameRate) / lag;
    // log-gaussian prior around 120 BPM (octave errors are common)
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const isPeak = values[i] >= values[i - 1] && values[i] >= values[i + 1];
    const score = values[i] * prior;
    if (isPeak && score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return { bpm: null, confidence: 0 };
  // parabolic interpolation
  const a = values[best - 1], b = values[best], c = values[best + 1];
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? 0.5 * (a - c) / denom : 0;
  const lag = lagMin + best + delta;
  const bpm = (60 * frameRate) / lag;
  const sorted = [...values].sort((x, y) => x - y);
  const med = sorted[sorted.length >> 1];
  const confidence = clamp01((b - Math.max(0, med)) / 0.3);
  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(confidence * 1000) / 1000 };
}

// ITU-R BS.1770 style loudness on the mono mix (approximation, +3 dB for dual mono).
function loudness(mono, sampleRate, segments) {
  const f1 = biquad("highshelf", 1681.974450955533, 3.999843853973347, 0.7071752369554196, sampleRate);
  const f2 = biquad("highpass", 38.13547087602444, 0, 0.5003270373238773, sampleRate);
  const blockLen = Math.round(0.4 * sampleRate);
  const blockHop = Math.round(0.1 * sampleRate);
  const stLen = Math.round(3 * sampleRate);
  const stHop = Math.round(1 * sampleRate);
  const blocks = [];
  const shortTerm = [];

  for (const [s, e] of segments) {
    // filtered squared signal, summed in 100 ms chunks
    const chunkSums = [];
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
    let acc = 0, cnt = 0;
    for (let i = s; i < e; i++) {
      const x = mono[i];
      const y = f1.b0 * x + f1.b1 * x1 + f1.b2 * x2 - f1.a1 * y1 - f1.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const z = f2.b0 * y + f2.b1 * u1 + f2.b2 * u2 - f2.a1 * z1 - f2.a2 * z2;
      u2 = u1; u1 = y; z2 = z1; z1 = z;
      acc += z * z;
      if (++cnt === blockHop) { chunkSums.push(acc); acc = 0; cnt = 0; }
    }
    const per = blockLen / blockHop; // 4 chunks per 400 ms block
    for (let i = 0; i + per <= chunkSums.length; i++) {
      let sum = 0;
      for (let j = 0; j < per; j++) sum += chunkSums[i + j];
      blocks.push(sum / blockLen);
    }
    const perSt = stLen / blockHop;
    const stStep = stHop / blockHop;
    for (let i = 0; i + perSt <= chunkSums.length; i += stStep) {
      let sum = 0;
      for (let j = 0; j < perSt; j++) sum += chunkSums[i + j];
      shortTerm.push(sum / stLen);
    }
  }
  const toLufs = (ms) => -0.691 + 10 * Math.log10(ms + EPS) + 3.01;
  const gate = (arr, rel) => {
    const abs = arr.filter((z) => toLufs(z) > -70);
    if (!abs.length) return [];
    const relThresh = toLufs(mean(abs)) + rel;
    return abs.filter((z) => toLufs(z) > relThresh);
  };
  const gated = gate(blocks, -10);
  const integrated = gated.length ? toLufs(mean(gated)) : -70;
  const stGated = gate(shortTerm, -20).map(toLufs).sort((a, b) => a - b);
  const range = stGated.length > 2 ? quantile(stGated, 0.95) - quantile(stGated, 0.1) : 0;
  const shortTermMax = shortTerm.length ? Math.max(...shortTerm.map(toLufs)) : integrated;
  return { integrated, range, shortTermMax };
}

function biquad(type, fc, gainDb, q, rate) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * fc) / rate;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === "highshelf") {
    const sa = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + sa);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - sa);
    a0 = (A + 1) - (A - 1) * cw + sa;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - sa;
  } else {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cw;
    a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// ---------- small stats helpers ----------
function mean(a) {
  if (!a.length) return 0;
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}
function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) ** 2;
  return Math.sqrt(s / (a.length - 1));
}
function median(a) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1];
}
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Clipping estimate on raw channels: share of samples inside flat-topped runs
 * (>= 3 nearly identical consecutive samples) close to the peak. Smooth
 * waveform peaks, even of deep bass, never stay flat for 3 samples.
 */
export function measureClipping(channels) {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  let clipped = 0, total = 0;
  if (peak >= 0.5) {
    const thr = peak * 0.98;
    const flat = 2e-5;
    for (const ch of channels) {
      total += ch.length;
      let run = 0;
      for (let i = 1; i < ch.length; i++) {
        if (Math.abs(ch[i]) >= thr && Math.abs(ch[i] - ch[i - 1]) <= flat) run++;
        else { if (run >= 2) clipped += run + 1; run = 0; }
      }
      if (run >= 2) clipped += run + 1;
    }
  }
  return {
    clippingRatio: total ? clipped / total : 0,
    channelPeakDb: 20 * Math.log10(peak + EPS),
  };
}
