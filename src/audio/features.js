// Raw feature extraction. Pure function: PCM in, plain object out.
// Runs in a Web Worker in the browser and directly in Node for tests.
// These values are NOT scores: they are inputs for src/scoring/model.js.
//
// Level independence: the signal is first normalised to a reference loudness
// (ANALYSIS.referenceLufs), so the mastering level of a file never changes its
// features. The file's own loudness is kept for information only.

import { FFT } from "./fft.js";
import { ANALYSIS, FEATURE_VERSION } from "../config.js";
import { detectKey, detectSections, melFilterbank, dctMatrix } from "./music.js";
import { fastPulseBlocks } from "./fast-pulse.js";

const EPS = 1e-12;
const BANDS = [
  ["sub", 20, 60],
  ["bass", 60, 250],
  ["lowMid", 250, 2000],
  ["highMid", 2000, 6000],
  ["high", 6000, 22050],
];

/**
 * @param {Float32Array} mono  mono PCM, [-1, 1] (normalised in place)
 * @param {number} sampleRate
 * @param {object} [extra]     values measured elsewhere (e.g. per-channel clipping), and for
 *   captured audio: `segments` [{start, end, trackTime}] (sample ranges of `mono` holding
 *   excerpts that start at `trackTime` seconds in the track), `duration` (track length),
 *   `gainDb` / `referenceLoudness` (live analysis of a window: normalise with the loudness
 *   of the track heard so far instead of the window's own)
 * @param {(p:number)=>void} [onProgress]
 * @returns global features + `timeline` (the same features per analysis window)
 */
export function extractFeatures(mono, sampleRate, extra = {}, onProgress = () => {}) {
  const given = extra.segments?.length ? extra.segments : null;
  const segments = given ? given.map((s) => [s.start, s.end]) : chooseSegments(mono.length, sampleRate);
  // buffer time → track time, per segment
  const offsets = given ? given.map((s) => s.trackTime - s.start / sampleRate) : segments.map(() => 0);
  const analyzedSamples = segments.reduce((a, [s, e]) => a + (e - s), 0);

  // --- loudness normalisation (in place: the caller hands over its buffer)
  const kChunks = kWeightedChunks(mono, sampleRate, segments);
  const sourceLoud = extra.referenceLoudness ?? loudnessFromChunks(kChunks.flat());
  let sourcePeak = 0;
  for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > sourcePeak) sourcePeak = a; }
  const gainDb = Number.isFinite(extra.gainDb) ? extra.gainDb
    : sourceLoud.integrated > -70 ? Math.max(-30, Math.min(50, ANALYSIS.referenceLufs - sourceLoud.integrated)) : 0;
  const gain = 10 ** (gainDb / 20);
  if (gain !== 1) for (let i = 0; i < mono.length; i++) mono[i] *= gain;

  const frames = analyzeFrames(mono, sampleRate, segments, (p) => onProgress(p * 0.9));
  const ctx = {
    frames, sampleRate, chunks: kChunks.flat(), sourceLoud, gainDb,
    clippingRatio: extra.clippingRatio ?? 0,
  };

  // Whole track: every frame of every segment.
  const global = summarize(ctx, frames.segments.map((sg) => [sg.start, sg.end]), true);

  // Timeline: the same summary over sliding windows inside each segment.
  const winFrames = Math.round(ANALYSIS.windowSeconds * frames.frameRate);
  const hopFrames = Math.round(ANALYSIS.windowHopSeconds * frames.frameRate);
  const windows = [];
  frames.segments.forEach((sg, si) => {
    const len = sg.end - sg.start;
    if (len <= 0) return;
    if (len <= winFrames) {
      windows.push([sg.start, sg.end, si]);
      return;
    }
    for (let a = sg.start; a + winFrames <= sg.end; a += hopFrames) windows.push([a, a + winFrames, si]);
    const last = windows.at(-1);
    if (last[1] < sg.end - hopFrames / 2) windows.push([sg.end - winFrames, sg.end, si]);
  });
  const times = [];
  const series = {};
  windows.forEach(([a, b, si], i) => {
    const w = summarize(ctx, [[a, b]], false);
    times.push(round4((frames.time[a] + frames.time[b - 1]) / 2 + ANALYSIS.fftSize / 2 / sampleRate + offsets[si]));
    for (const key of TIMELINE_KEYS) (series[key] ??= []).push(round4(w[key] ?? 0));
    if (i % 8 === 0) onProgress(0.9 + (0.1 * i) / windows.length);
  });

  // tempo: fold each window's estimate to the octave closest to the global
  // tempo (window estimates often jump to half / double), then measure how
  // steady the tempo is
  const tempo = foldTempo(global.bpm, series.bpm ?? [], series.bpmConfidence ?? []);
  if (series.bpm) series.bpm = tempo.folded;

  // structure: needs a contiguous listening of (almost) the whole track
  const duration = extra.duration ?? mono.length / sampleRate;
  let sections = null;
  const longest = frames.segments.reduce((m, sg, i) => (sg.end - sg.start > (m?.len ?? 0) ? { sg, i, len: sg.end - sg.start } : m), null);
  if (longest && longest.len / frames.frameRate >= duration * 0.9) {
    const off = offsets[longest.i] + frames.time[longest.sg.start];
    sections = structureOf(frames, longest.sg, frames.frameRate).map((x) => ({ ...x, start: round4(x.start + off), end: round4(x.end + off) }));
  }

  onProgress(1);
  return {
    featureVersion: FEATURE_VERSION,
    sampleRate,
    duration,
    analyzedSeconds: analyzedSamples / sampleRate,
    excerpted: segments.length > 1 || analyzedSamples / sampleRate < (extra.duration ?? 0) * 0.97,
    ...global,
    // general (level independent)
    loudnessRange: sourceLoud.range,
    shortTermPeakLu: sourceLoud.shortTermMax - sourceLoud.integrated,
    plrDb: 20 * Math.log10(sourcePeak + EPS) - sourceLoud.integrated,
    // informative only, never scored
    sourceLoudnessLufs: sourceLoud.integrated,
    normalizationGainDb: gainDb,
    peakDb: global.peakDb - gainDb,
    clippingRatio: ctx.clippingRatio,
    channelPeakDb: extra.channelPeakDb ?? global.peakDb - gainDb,
    bpmStability: tempo.stability,
    bpmAlt: tempo.alt,
    sections,
    timeline: {
      windowSeconds: ANALYSIS.windowSeconds,
      hopSeconds: ANALYSIS.windowHopSeconds,
      times,
      series,
    },
  };
}

/** Per-window features stored in the timeline (columnar, one array per key). */
export const TIMELINE_KEYS = [
  "bpm", "bpmConfidence", "onsetRate", "onsetStrength", "transientStrength", "onsetEnvMean", "ioiCv",
  "rmsDbMean", "rmsDbStd", "silenceRatio",
  "centroidMean", "centroidStd", "bandwidthMean", "rolloffMean", "fluxMean", "fluxStd",
  "flatnessMean", "flatnessMedian", "zcrMean", "spectralCrestMean", "spectralFill",
  "bandSub", "bandBass", "bandLowMid", "bandHighMid", "bandHigh", "bassRatio", "midRatio", "highRatio",
  "lowPulse", "kickRate", "kickPunch", "lowBandDbStd", "lowFlatnessMedian", "midFlatnessMedian", "pulseRate", "pulseStrength",
  "fastPulseShare", "fastPulseStrength",
  "plrDb", "crestDb", "loudnessRel",
  "keyIndex", "keyConfidence", "midModulation", "midLowCorr",
  "spectralContrast", "spectralEntropy", "dissonance", "fastKickRatio",
];

/**
 * Share of kicks inside double-kick / blast runs: at least 4 strong kicks in a
 * row, 60–130 ms apart. A single kick often yields two close detections (attack
 * and body), so isolated short intervals never count.
 */
function fastKicks(kicks, frameRate) {
  const strong = kicks.filter((k) => k[1] >= 0.5 * median(kicks.map((x) => x[1])));
  if (strong.length < 4) return 0;
  let inRuns = 0, run = 1;
  const close = (run) => { if (run >= 4) inRuns += run; };
  for (let i = 1; i < strong.length; i++) {
    const d = (strong[i][0] - strong[i - 1][0]) / frameRate;
    if (d >= 0.06 && d <= 0.13) run++;
    else { close(run); run = 1; }
  }
  close(run);
  return inRuns / strong.length;
}

// ---------------------------------------------------------------------------
// Frame pass: one row per STFT frame, stored in typed arrays.

function analyzeFrames(mono, sampleRate, segments, onProgress) {
  const { fftSize: N, hopSize: H } = ANALYSIS;
  const fft = new FFT(N);
  const nBins = N / 2 + 1;
  const binHz = sampleRate / N;
  const nyquist = sampleRate / 2;
  const bin = (hz) => Math.max(1, Math.min(nBins - 1, Math.round(hz / binHz)));
  const kLo = bin(40);
  const kHi = bin(Math.min(16000, nyquist - binHz));
  const kFlatLo = bin(60);
  const kKickLo = bin(40), kKickHi = bin(150);
  const kBodyHi = bin(2500);  // drum "body" (kick, snare, toms): no hi-hats
  const kLowFlatLo = bin(30), kLowFlatHi = bin(500);
  const bandRanges = BANDS.map(([name, lo, hi]) => [name, bin(lo), bin(Math.min(hi, nyquist))]);
  const frameRate = sampleRate / H;
  // chroma: spectral peaks 55 Hz – 2.1 kHz of a longer FFT (close bass notes
  // must be resolved), frequency refined by interpolation, folded to 12 pitch
  // classes; computed every CHROMA_EVERY frames
  const NC = CHROMA_FFT;
  const fftC = new FFT(NC);
  const magC = new Float64Array(NC / 2 + 1);
  const binHzC = sampleRate / NC;
  const kChLo = Math.max(1, Math.round(55 / binHzC)), kChHi = Math.round(2100 / binHzC);
  const chroma = new Float64Array(12);
  const chromaLast = new Float64Array(12);
  // MFCC 1..12 on a 26-band mel filterbank (40 Hz – 10 kHz)
  const mel = melFilterbank(26, nBins, binHz, 40, Math.min(10000, nyquist));
  const dct = dctMatrix(MFCC_N, mel.length);
  const melLog = new Float64Array(mel.length);
  const mfccLast = new Float64Array(MFCC_N);
  const kMidLo = bin(300), kMidHi = bin(3400);
  const kMfLo = bin(400), kMfHi = bin(5000);
  // extractor 1.6, "hardness" cues (Czedik-Eysenberg et al. 2017-2024;
  // Herbst & Mynett 2022): spectral contrast, spectral entropy, dissonance
  const contrastBands = CONTRAST_BANDS.map(([lo, hi]) => [bin(lo), bin(Math.min(hi, nyquist - binHz))]);
  const contrastBuf = new Float64Array(nBins);
  const kEntLo = bin(200), kEntHi = bin(Math.min(11000, nyquist - binHz));
  const kDisLo = bin(60), kDisHi = bin(Math.min(5000, nyquist - binHz));
  const peakF = new Float64Array(DISSONANCE_PEAKS), peakA = new Float64Array(DISSONANCE_PEAKS);
  let dissonanceLast = 0;

  let total = 0;
  for (const [s, e] of segments) total += Math.max(1, Math.floor((e - s - N) / H) + 1);
  const cols = {};
  for (const k of FRAME_COLUMNS) cols[k] = new Float32Array(total);
  const silent = new Uint8Array(total);
  const fluxValid = new Uint8Array(total);

  const mag = new Float64Array(nBins);
  const prevLog = new Float64Array(nBins);
  const prevLowLog = new Float64Array(nBins);
  const curNorm = new Float64Array(nBins);
  const prevNorm = new Float64Array(nBins);
  const segs = [];
  let f = 0;

  for (const [segStart, segEnd] of segments) {
    const first = f;
    let havePrev = false;
    prevNorm.fill(0);
    for (let off = segStart; (off + N <= segEnd || off === segStart) && off < segEnd && f < total; off += H, f++) {
      cols.time[f] = off / sampleRate;
      let sq = 0, zc = 0, pk = 0, prev = mono[off];
      const end = Math.min(off + N, segEnd);
      for (let i = off; i < end; i++) {
        const v = mono[i];
        sq += v * v;
        const a = v < 0 ? -v : v;
        if (a > pk) pk = a;
        if ((v >= 0) !== (prev >= 0)) zc++;
        prev = v;
      }
      const len = end - off;
      cols.sumSq[f] = sq / Math.max(1, len);
      cols.peak[f] = pk;
      const rmsDb = 10 * Math.log10(cols.sumSq[f] + EPS);
      cols.rmsDb[f] = rmsDb;
      cols.zcr[f] = zc / Math.max(1, len);

      fft.magnitudes(mono, off, mag);

      // onset envelopes: broadband and low band (kicks), log-compressed flux
      let od = 0, lod = 0, bod = 0, lowP = 0;
      for (let k = kLo; k <= kHi; k++) {
        const l = Math.log1p(1000 * mag[k]);
        if (havePrev) { const d = l - prevLog[k]; if (d > 0) { od += d; if (k <= kBodyHi) bod += d; } }
        prevLog[k] = l;
      }
      for (let k = kKickLo; k <= kKickHi; k++) {
        const l = Math.log1p(1000 * mag[k]);
        if (havePrev) { const d = l - prevLowLog[k]; if (d > 0) lod += d; }
        prevLowLog[k] = l;
        lowP += mag[k] * mag[k];
      }
      cols.od[f] = havePrev ? od / (kHi - kLo + 1) : 0;
      cols.lowOd[f] = havePrev ? lod / (kKickHi - kKickLo + 1) : 0;
      cols.bodyOd[f] = havePrev ? bod / (kBodyHi - kLo + 1) : 0;
      cols.lowDb[f] = 10 * Math.log10(lowP + EPS);
      let midP = 0;
      for (let k = kMidLo; k <= kMidHi; k++) midP += mag[k] * mag[k];
      cols.midDb[f] = 10 * Math.log10(midP + EPS);

      if (rmsDb < ANALYSIS.silenceDb) {
        silent[f] = 1;
        havePrev = true;
        prevNorm.fill(0);
        continue;
      }

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
      let cum = 0, rolloff = kHi * binHz;
      const target = 0.85 * sumM;
      for (let k = kLo; k <= kHi; k++) {
        cum += mag[k];
        if (cum >= target) { rolloff = k * binHz; break; }
      }
      let logSum = 0, linSum = 0, fillCount = 0;
      const nFlat = kHi - kFlatLo + 1;
      const fillThresh = maxP * 1e-4; // -40 dB below the frame's peak bin
      for (let k = kFlatLo; k <= kHi; k++) {
        const p = mag[k] * mag[k];
        logSum += Math.log(p + EPS);
        linSum += p;
        if (p > fillThresh) fillCount++;
      }
      // flatness of the low end: a clean kick / sub is nearly sinusoidal,
      // a distorted one spreads harmonics and noise over 30–500 Hz
      let ls = 0, ll = 0;
      const nl = kLowFlatHi - kLowFlatLo + 1;
      for (let k = kLowFlatLo; k <= kLowFlatHi; k++) {
        const p = mag[k] * mag[k];
        ls += Math.log(p + EPS);
        ll += p;
      }
      // flatness of the mids: distorted guitars and saturated synths fill
      // 400 Hz – 5 kHz with harmonics and noise, clean voices and instruments
      // leave it peaky
      let ms = 0, ml = 0;
      const nm = kMfHi - kMfLo + 1;
      for (let k = kMfLo; k <= kMfHi; k++) {
        const p = mag[k] * mag[k];
        ms += Math.log(p + EPS);
        ml += p;
      }
      // normalised flux (level independent timbre change)
      let flux = 0;
      for (let k = kLo; k <= kHi; k++) {
        curNorm[k] = mag[k] / (sumM + EPS);
        const d = curNorm[k] - prevNorm[k];
        if (d > 0) flux += d;
      }
      fluxValid[f] = havePrev && prevNorm[kLo] + prevNorm[kHi] + prevNorm[(kLo + kHi) >> 1] > 0 ? 1 : 0;
      prevNorm.set(curNorm);

      cols.centroid[f] = centroid;
      cols.bandwidth[f] = Math.sqrt(sumVar / (sumM + EPS));
      cols.rolloff[f] = rolloff;
      cols.flatness[f] = Math.exp(logSum / nFlat) / (linSum / nFlat + EPS);
      cols.crest[f] = maxM / (sumM / (kHi - kLo + 1) + EPS);
      cols.fill[f] = fillCount / nFlat;
      cols.lowFlat[f] = Math.exp(ls / nl) / (ll / nl + EPS);
      cols.midFlat[f] = Math.exp(ms / nm) / (ml / nm + EPS);
      cols.flux[f] = flux;
      cols.contrast[f] = spectralContrast(mag, contrastBands, contrastBuf);
      cols.entropy[f] = spectralEntropy(mag, kEntLo, kEntHi);
      if ((f - first) % DISSONANCE_EVERY === 0) dissonanceLast = dissonance(mag, kDisLo, kDisHi, binHz, peakF, peakA);
      cols.dissonance[f] = dissonanceLast;
      for (const [name, lo, hi] of bandRanges) {
        let p = 0;
        for (let k = lo; k <= hi; k++) p += mag[k] * mag[k];
        cols[`band_${name}`][f] = p;
      }
      if ((f - first) % CHROMA_EVERY === 0) {
        // centred on the short frame when the segment allows it
        const cOff = Math.max(segStart, Math.min(off + N / 2 - NC / 2, segEnd - NC));
        chroma.fill(0);
        let chSum = 0;
        if (cOff >= segStart && cOff + NC <= segEnd) {
          fftC.magnitudes(mono, cOff, magC);
          let mx = 0;
          for (let k = kChLo; k <= kChHi; k++) if (magC[k] > mx) mx = magC[k];
          const floor = mx * 0.02;
          for (let k = kChLo; k <= kChHi; k++) {
            const m0 = magC[k];
            if (m0 < floor || m0 < magC[k - 1] || m0 < magC[k + 1]) continue;
            const la = Math.log(magC[k - 1] + EPS), lb = Math.log(m0 + EPS), lc = Math.log(magC[k + 1] + EPS);
            const den = la - 2 * lb + lc;
            const delta = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (la - lc)) / den)) : 0;
            const semis = 12 * Math.log2(((k + delta) * binHzC) / 440) + 69;
            const r = Math.round(semis);
            const e = m0 * m0 * (1 - Math.abs(semis - r));
            chroma[((r % 12) + 12) % 12] += e;
            chSum += e;
          }
        }
        for (let c = 0; c < 12; c++) chromaLast[c] = chSum > 0 ? chroma[c] / chSum : 0;
      }
      for (let c = 0; c < 12; c++) cols[CHROMA_COLS[c]][f] = chromaLast[c];
      if ((f - first) % MFCC_EVERY === 0) {
        for (let m = 0; m < mel.length; m++) {
          const { idx, w } = mel[m];
          let e = 0;
          for (let j = 0; j < idx.length; j++) { const v = mag[idx[j]]; e += v * v * w[j]; }
          melLog[m] = Math.log(e + 1e-10);
        }
        for (let c = 0; c < MFCC_N; c++) {
          const row = dct[c];
          let v = 0;
          for (let m = 0; m < melLog.length; m++) v += row[m] * melLog[m];
          mfccLast[c] = v;
        }
      }
      for (let c = 0; c < MFCC_N; c++) cols[MFCC_COLS[c]][f] = mfccLast[c];
      havePrev = true;
      if ((f & 511) === 0) onProgress(f / total);
    }
    // onsets, picked per segment so they never straddle a gap
    const env = cols.od.subarray(first, f);
    const onsets = pickOnsets(env, frameRate).map(([i, v]) => [first + i, v]);
    const kicks = pickOnsets(cols.lowOd.subarray(first, f), frameRate, KICK_PICK).map(([i, v]) => [first + i, v]);
    // extratone (1.7): each frame takes the strongest fast pulse of the blocks covering it
    for (const bl of fastPulseBlocks(mono, segStart, segEnd, sampleRate)) {
      if (!bl.rate) continue;
      for (let i = first; i < f; i++) {
        const pos = segStart + (i - first) * H + N / 2;
        if (pos >= bl.start && pos < bl.end && bl.strength > cols.fastStr[i]) { cols.fastStr[i] = bl.strength; cols.fastRate[i] = bl.rate; }
      }
    }
    segs.push({ start: first, end: f, onsets, kicks });
  }
  return { ...cols, silent, fluxValid, count: f, frameRate, segments: segs };
}

const MFCC_N = 12;
const CONTRAST_BANDS = [[1600, 3200], [3200, 6400]]; // Hz; below 11 kHz, where lossy codecs leave holes
const CONTRAST_ALPHA = 0.2;  // fraction of bins averaged for the peak and for the valley (Jiang et al. 2002)
const DISSONANCE_PEAKS = 30;
const DISSONANCE_EVERY = 2;  // frames

/**
 * Spectral contrast (Jiang et al. 2002): peak-to-valley ratio of each band in
 * dB, averaged over the bands. Harmonic sounds (voices, clean synths) leave
 * deep valleys between partials; a distorted guitar wall fills them.
 */
function spectralContrast(mag, bands, buf) {
  let sum = 0, n = 0;
  for (const [lo, hi] of bands) {
    const len = hi - lo + 1;
    if (len < 5) continue;
    for (let k = 0; k < len; k++) buf[k] = mag[lo + k] * mag[lo + k];
    const band = buf.subarray(0, len).sort();
    const m = Math.max(1, Math.round(len * CONTRAST_ALPHA));
    let valley = 0, peak = 0;
    for (let k = 0; k < m; k++) { valley += band[k]; peak += band[len - 1 - k]; }
    sum += 10 * Math.log10((peak + EPS) / (valley + EPS));
    n++;
  }
  return n ? sum / n : 0;
}

/** Normalised spectral entropy of the power spectrum (0 = one partial, 1 = white noise). */
function spectralEntropy(mag, lo, hi) {
  let tot = 0;
  for (let k = lo; k <= hi; k++) tot += mag[k] * mag[k];
  if (tot <= 0) return 0;
  let h = 0;
  for (let k = lo; k <= hi; k++) {
    const p = (mag[k] * mag[k]) / tot;
    if (p > 0) h -= p * Math.log(p);
  }
  return h / Math.log(hi - lo + 1);
}

/**
 * Sensory dissonance (Plomp & Levelt, Sethares' model, as in Essentia):
 * beating between the strongest spectral peaks. Distortion adds dense
 * intermodulation products. Normalised by the peaks' energy, 0..~1.
 */
function dissonance(mag, lo, hi, binHz, pf, pa) {
  let n = 0;
  for (let k = Math.max(lo, 1); k <= hi && k + 1 < mag.length; k++) {
    const m = mag[k];
    if (m <= mag[k - 1] || m < mag[k + 1] || m <= 0) continue;
    // keep the DISSONANCE_PEAKS strongest peaks (insertion into a small sorted list)
    if (n === pf.length && m <= pa[n - 1]) continue;
    const a0 = Math.log(mag[k - 1] + EPS), b0 = Math.log(m + EPS), c0 = Math.log(mag[k + 1] + EPS);
    const den = a0 - 2 * b0 + c0;
    const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a0 - c0)) / den)) : 0;
    let i = n < pf.length ? n++ : n - 1;
    while (i > 0 && pa[i - 1] < m) { pa[i] = pa[i - 1]; pf[i] = pf[i - 1]; i--; }
    pa[i] = m;
    pf[i] = (k + d) * binHz;
  }
  if (n < 2) return 0;
  let dis = 0, norm = 0;
  for (let i = 0; i < n; i++) {
    norm += pa[i] * pa[i];
    for (let j = i + 1; j < n; j++) {
      const f1 = Math.min(pf[i], pf[j]), df = Math.abs(pf[i] - pf[j]);
      const sc = 0.24 / (0.0207 * f1 + 18.96);
      dis += pa[i] * pa[j] * (Math.exp(-3.5 * sc * df) - Math.exp(-5.75 * sc * df));
    }
  }
  return norm > 0 ? dis / norm : 0;
}
const CHROMA_FFT = 8192;   // 5.4 Hz bins at 44.1 kHz
const CHROMA_EVERY = 8;    // frames (~93 ms)
const MFCC_EVERY = 2;      // frames
const CHROMA_COLS = Array.from({ length: 12 }, (_, i) => `chroma_${i}`);
const MFCC_COLS = Array.from({ length: MFCC_N }, (_, i) => `mfcc_${i + 1}`);
const FRAME_COLUMNS = [
  "time", "sumSq", "peak", "rmsDb", "zcr", "od", "lowOd", "bodyOd", "lowDb", "midDb",
  "centroid", "bandwidth", "rolloff", "flatness", "crest", "fill", "lowFlat", "midFlat", "flux",
  "contrast", "entropy", "dissonance", "fastRate", "fastStr",
  ...BANDS.map(([n]) => `band_${n}`), ...CHROMA_COLS, ...MFCC_COLS,
];

// ---------------------------------------------------------------------------
// Summary of a set of frame ranges (whole track or one window).

function summarize(ctx, ranges, isGlobal) {
  const F = ctx.frames;
  const frameRate = F.frameRate;
  const pick = (col, filter = (i) => !F.silent[i]) => {
    const out = [];
    for (const [a, b] of ranges) for (let i = a; i < b; i++) if (filter(i)) out.push(col[i]);
    return out;
  };
  let frames = 0, silentCount = 0, sumSq = 0, peak = 0;
  const bandPower = Object.fromEntries(BANDS.map(([n]) => [n, 0]));
  for (const [a, b] of ranges) {
    for (let i = a; i < b; i++) {
      frames++;
      sumSq += F.sumSq[i];
      if (F.peak[i] > peak) peak = F.peak[i];
      if (F.silent[i]) { silentCount++; continue; }
      for (const [n] of BANDS) bandPower[n] += F[`band_${n}`][i];
    }
  }
  const active = frames - silentCount;
  const seconds = Math.max(active, 1) / frameRate;

  // onsets & kicks inside the ranges
  const inRanges = (i) => ranges.some(([a, b]) => i >= a && i < b);
  const onsets = [], kicks = [];
  for (const sg of F.segments) {
    for (const o of sg.onsets) if (inRanges(o[0])) onsets.push(o);
    for (const k of sg.kicks) if (inRanges(k[0])) kicks.push(k);
  }
  const onsetPeaks = onsets.map((o) => o[1]);
  const env = pick(F.od, () => true);
  const onsetEnvMean = mean(env);
  const ioi = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = (onsets[i][0] - onsets[i - 1][0]) / frameRate;
    if (d > 0 && d < 2) ioi.push(d);
  }

  // tempo: autocorrelation of the onset envelope, averaged over ranges
  let acSum = null, acWeight = 0;
  for (const [a, b] of ranges) {
    const ac = onsetAutocorrelation(F.od.subarray(a, b), frameRate);
    if (!ac) continue;
    const w = b - a;
    if (!acSum) acSum = new Float64Array(ac.values.length);
    for (let i = 0; i < ac.values.length; i++) acSum[i] += ac.values[i] * w;
    acWeight += w;
    acSum.lagMin = ac.lagMin;
  }
  const tempo = estimateTempo(acSum, acWeight, frameRate);
  const pulse = lowPulseRate(ranges, F.lowOd, frameRate);
  if (tempo.bpm) tempo.bpm = beatLevel(tempo.bpm, ranges, F.bodyOd, frameRate, pulse);
  // a periodicity made of barely audible fluctuations is not a reliable beat
  tempo.confidence = Math.round(tempo.confidence * clamp01(mean(onsetPeaks) / 0.05) * 1000) / 1000;
  if (onsets.length < 4) tempo.confidence = 0;

  const bandTotal = Object.values(bandPower).reduce((x, y) => x + y, 0) + EPS;
  const be = Object.fromEntries(Object.entries(bandPower).map(([k, v]) => [k, v / bandTotal]));
  const nonSilentFraction = active / Math.max(1, frames);
  const rms = Math.sqrt(sumSq / Math.max(1, frames) / Math.max(0.05, nonSilentFraction));
  const peakDb = 20 * Math.log10(peak + EPS);

  // loudness of the ranges relative to the whole track (the "volume" curve)
  const t0 = F.time[ranges[0][0]];
  const t1 = F.time[ranges.at(-1)[1] - 1] + ANALYSIS.fftSize / ctx.sampleRate;
  const winLoud = isGlobal ? ctx.sourceLoud : loudnessFromChunks(ctx.chunks.filter((c) => c.t >= t0 && c.t < t1), false);
  const loudnessRel = winLoud.integrated > -70 ? winLoud.integrated - ctx.sourceLoud.integrated : -30;
  const kickEnvMean = mean(pick(F.lowOd, () => true));

  const out = {
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    onsetRate: onsets.length / seconds,
    onsetStrength: mean(onsetPeaks),
    transientStrength: onsetPeaks.length ? mean(onsetPeaks) / (onsetEnvMean + EPS) : 0,
    onsetEnvMean,
    ioiCv: ioi.length > 4 ? std(ioi) / (mean(ioi) + EPS) : 1,
    rmsDbMean: mean(pick(F.rmsDb)),
    rmsDbStd: std(pick(F.rmsDb)),
    silenceRatio: silentCount / Math.max(1, frames),
    centroidMean: mean(pick(F.centroid)),
    centroidStd: std(pick(F.centroid)),
    bandwidthMean: mean(pick(F.bandwidth)),
    rolloffMean: mean(pick(F.rolloff)),
    fluxMean: mean(pick(F.flux, (i) => !F.silent[i] && F.fluxValid[i])),
    fluxStd: std(pick(F.flux, (i) => !F.silent[i] && F.fluxValid[i])),
    flatnessMean: mean(pick(F.flatness)),
    flatnessMedian: median(pick(F.flatness)),
    zcrMean: mean(pick(F.zcr)),
    spectralCrestMean: mean(pick(F.crest)),
    spectralFill: mean(pick(F.fill)),
    bandEnergy: be,
    bandSub: be.sub, bandBass: be.bass, bandLowMid: be.lowMid, bandHighMid: be.highMid, bandHigh: be.high,
    bassRatio: be.sub + be.bass,
    midRatio: be.lowMid + be.highMid,
    highRatio: be.high,
    // low end / pressure (all relative to the normalised level)
    lowPulse: kickEnvMean,                     // mean positive low-band flux: kick/bass attack activity
    kickRate: kicks.length / seconds,          // clearly separated kicks only (informative)
    kickPunch: mean(kicks.map((k) => k[1])),
    lowBandDbStd: std(pick(F.lowDb)),
    lowFlatnessMedian: median(pick(F.lowFlat)),
    midFlatnessMedian: median(pick(F.midFlat)),
    spectralContrast: median(pick(F.contrast)),
    spectralEntropy: median(pick(F.entropy)),
    dissonance: median(pick(F.dissonance)),
    // double kick / blast beats: share of kick intervals under 130 ms (16ths at 115+ BPM)
    fastKickRatio: kicks.length > 4 ? fastKicks(kicks, frameRate) : 0,
    // extratone (1.7): share of the time with a regular pulse of 12.5-24 hits/s
    // seen on the waveform (see fast-pulse.js), its rate and regularity
    fastPulseShare: mean(pick(F.fastRate).map((v) => (v > 0 ? 1 : 0))),
    fastPulseRate: median(pick(F.fastRate).filter((v) => v > 0)) || 0,
    fastPulseStrength: mean(pick(F.fastStr).filter((v) => v > 0)) || 0,
    crestDb: peakDb - 20 * Math.log10(rms + EPS),
    peakDb,
    loudnessRel,
  };
  // local peak-to-loudness ratio (the global one uses the source peak)
  out.plrDb = peakDb - (ANALYSIS.referenceLufs + loudnessRel);

  // key / mode from the mean chroma of the active frames
  const chroma = CHROMA_COLS.map((c) => mean(pick(F[c])));
  const key = detectKey(chroma);
  out.keyIndex = key.index;
  out.keyConfidence = key.confidence;

  // voice cues: syllable-rate (3–8 Hz) modulation of the 300–3400 Hz band,
  // and how much of it is shared with the low band (drums move both)
  out.pulseRate = pulse.rate;
  out.pulseStrength = pulse.strength;
  const mod = modulation(ranges, F.midDb, F.lowDb, frameRate);
  out.midModulation = mod.ratio;
  out.midLowCorr = mod.corr;

  if (isGlobal) {
    out.chroma = chroma.map(round4);
    out.mfccMean = MFCC_COLS.map((c) => round4(mean(pick(F[c]))));
    out.mfccStd = MFCC_COLS.map((c) => round4(std(pick(F[c]))));
  }
  return out;
}

/**
 * Picks the metrical level of the beat among bpm / 2, bpm and bpm × 2. The
 * broadband onset envelope is dominated by hi-hats, so its autocorrelation
 * often lands an octave off (8th-note hats at 60 BPM read as 120; a backbeat
 * at 175 read as 88). The beat is the fastest level carried by the drum
 * bodies (kick, snare: onsets below 2.5 kHz) within 55–200 BPM. Above 200
 * (hardcore, speedcore) only when the kick itself hits regularly at that rate.
 */
function beatLevel(bpm, ranges, body, frameRate, pulse) {
  let ac = null, w = 0;
  for (const [a, b] of ranges) {
    const r = onsetAutocorrelation(body.subarray(a, b), frameRate);
    if (!r) continue;
    ac ??= { values: new Float64Array(r.values.length), lagMin: r.lagMin };
    for (let i = 0; i < r.values.length; i++) ac.values[i] += r.values[i] * (b - a);
    w += b - a;
  }
  if (!ac) return bpm;
  const at = (c) => {
    const lag = (60 * frameRate) / c - ac.lagMin;
    const i = Math.round(lag);
    let v = -Infinity;
    for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < ac.values.length) v = Math.max(v, ac.values[j] / w);
    return v;
  };
  const cands = [bpm / 2, bpm, bpm * 2].filter((c) => c >= 55 && c <= 200);
  if (!cands.includes(bpm)) cands.push(bpm);
  const vals = cands.map(at);
  const top = Math.max(...vals.filter(Number.isFinite));
  let best = bpm;
  if (top > 0.05) {
    // fastest well-supported level
    const ok = cands.map((c, i) => [c, vals[i]]).filter(([, v]) => Number.isFinite(v) && v >= 0.6 * top).sort((x, y) => y[0] - x[0]);
    if (ok.length) best = ok[0][0];
  }
  const fast = best * 2;
  const kickBpm = pulse.rate * 60;
  if (fast > 200 && fast <= 320 && pulse.strength >= 0.45 && Math.abs(kickBpm / fast - 1) <= 0.04) best = fast;
  return Math.round(best * 10) / 10;
}

/** Octave-folded window tempi, share of confident windows within ±4 % of the global tempo, alternative octave. */
function foldTempo(bpm, bpms, confs) {
  if (!bpm) return { folded: bpms, stability: 0, alt: null };
  let n = 0, ok = 0;
  // follow the tempo from window to window: each estimate takes the octave
  // closest to the previous confident one (fixes half / double jumps while
  // keeping real tempo changes, even beyond an octave over the track)
  let prev = bpm;
  const folded = bpms.map((b, i) => {
    if (!b) return b;
    let x = b;
    while (x / prev > Math.SQRT2) x /= 2;
    while (prev / x > Math.SQRT2) x *= 2;
    if ((confs[i] ?? 0) > 0.15) {
      prev = x;
      n++;
      if (Math.abs(x / bpm - 1) <= 0.04) ok++;
    }
    return round4(x);
  });
  const alt = bpm < 100 ? bpm * 2 : bpm / 2;
  return { folded, stability: n ? round4(ok / n) : 0, alt: Math.round(alt * 10) / 10 };
}

/**
 * Share of the (detrended) mid-band envelope's power at syllable rate,
 * and its correlation with the low-band envelope, over the given ranges.
 */
function modulation(ranges, mid, low, frameRate) {
  const W = Math.max(3, Math.round(0.5 * frameRate));
  let num = 0, den = 0, sxy = 0, sxx = 0, syy = 0;
  for (const [a, b] of ranges) {
    const n = b - a;
    if (n < 2 * W) continue;
    const dm = detrend(mid, a, b, W), dl = detrend(low, a, b, W);
    for (let i = 0; i < n; i++) { sxy += dm[i] * dl[i]; sxx += dm[i] * dm[i]; syy += dl[i] * dl[i]; }
    // Goertzel power at 3..8 Hz vs 0.5..20 Hz (0.5 Hz steps)
    for (let f = 0.5; f <= 20; f += 0.5) {
      const w = (2 * Math.PI * f) / frameRate;
      const c = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) { const s0 = dm[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      const p = s1 * s1 + s2 * s2 - c * s1 * s2;
      den += p;
      if (f >= 3 && f <= 8) num += p;
    }
  }
  return { ratio: den > 0 ? num / den : 0, corr: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0 };
}

/**
 * Fastest regular pulse of the low band (kicks / bass attacks per second),
 * from the autocorrelation of the low-band onset envelope. Unlike the BPM,
 * never folded into 60–180: speedcore at 280 BPM or extratone at 600+ BPM
 * (kicks too close to be picked one by one) come out as 4.7 or 10+ per second.
 */
function lowPulseRate(ranges, env, frameRate) {
  const lagMin = Math.max(2, Math.round(0.045 * frameRate));
  const lagMax = Math.round(0.75 * frameRate);
  const ac = new Float64Array(lagMax + 2);
  let zero = 0;
  for (const [a, b] of ranges) {
    const n = b - a;
    if (n < 3 * lagMax) continue;
    const x = detrend(env, a, b, Math.round(0.4 * frameRate));
    for (let i = 0; i < n; i++) zero += x[i] * x[i];
    for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
      ac[lag] += s;
    }
  }
  if (zero <= 0) return { rate: 0, strength: 0 };
  const peaks = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const v = ac[lag] / zero;
    if (v > 0 && ac[lag] >= ac[lag - 1] && ac[lag] > ac[lag + 1]) peaks.push([lag, v]);
  }
  if (!peaks.length) return { rate: 0, strength: 0 };
  const top = Math.max(...peaks.map((p) => p[1]));
  const [lag, v] = peaks.find((p) => p[1] >= 0.7 * top);
  return { rate: frameRate / lag, strength: v };
}

function detrend(col, a, b, W) {
  const n = b - a;
  const out = new Float64Array(n);
  let acc = 0;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { acc += col[a + i]; pre[i + 1] = acc; }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - W), hi = Math.min(n, i + W + 1);
    out[i] = col[a + i] - (pre[hi] - pre[lo]) / (hi - lo);
  }
  return out;
}

/** Block vectors (~0.5 s) for structure detection over one contiguous segment. */
function structureOf(F, sg, frameRate) {
  const B = Math.max(1, Math.round(0.5 * frameRate));
  const vectors = [], level = [];
  for (let a = sg.start; a + B <= sg.end; a += B) {
    const v = [];
    let rms = 0, act = 0;
    const sums = new Float64Array(12 + MFCC_N + BANDS.length);
    for (let i = a; i < a + B; i++) {
      rms += F.rmsDb[i];
      if (F.silent[i]) continue;
      act++;
      for (let c = 0; c < 12; c++) sums[c] += F[CHROMA_COLS[c]][i];
      for (let c = 0; c < MFCC_N; c++) sums[12 + c] += F[MFCC_COLS[c]][i];
      BANDS.forEach(([nm], j) => { sums[12 + MFCC_N + j] += F[`band_${nm}`][i]; });
    }
    for (let c = 0; c < 12; c++) v.push(act ? sums[c] / act : 0);
    for (let c = 0; c < MFCC_N; c++) v.push(act ? (sums[12 + c] / act) * 0.5 : 0);
    const bt = BANDS.reduce((x, _, j) => x + sums[12 + MFCC_N + j], 0) + EPS;
    BANDS.forEach((_, j) => v.push(Math.log10(sums[12 + MFCC_N + j] / bt + 1e-6)));
    const lv = rms / B;
    v.push(lv / 10);
    vectors.push(v);
    level.push(lv);
  }
  return detectSections(vectors, level, B / frameRate);
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

function pickOnsets(env, frameRate, { floor = 0.008, medianFactor = 1, meanFactor = 0.35, minGapSec = 0.025 } = {}) {
  const n = env.length;
  if (n < 5) return [];
  const W = Math.max(3, Math.round(0.12 * frameRate));
  const minGap = Math.max(1, Math.round(minGapSec * frameRate));
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
    const thresh = medianFactor * med + meanFactor * globalMean + floor;
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

// kicks need a clear low-band attack standing out from the local level
const KICK_PICK = { floor: 0.15, medianFactor: 2, meanFactor: 0.5, minGapSec: 0.04 };

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
// Returns, per segment, the K-weighted mean square of consecutive 100 ms chunks.
function kWeightedChunks(mono, sampleRate, segments) {
  const f1 = biquad("highshelf", 1681.974450955533, 3.999843853973347, 0.7071752369554196, sampleRate);
  const f2 = biquad("highpass", 38.13547087602444, 0, 0.5003270373238773, sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  return segments.map(([s, e]) => {
    const chunks = [];
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
    let acc = 0, cnt = 0, start = s;
    for (let i = s; i < e; i++) {
      const x = mono[i];
      const y = f1.b0 * x + f1.b1 * x1 + f1.b2 * x2 - f1.a1 * y1 - f1.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const z = f2.b0 * y + f2.b1 * u1 + f2.b2 * u2 - f2.a1 * z1 - f2.a2 * z2;
      u2 = u1; u1 = y; z2 = z1; z1 = z;
      acc += z * z;
      if (++cnt === hop) {
        chunks.push({ t: start / sampleRate, ms: acc / hop, seg: s });
        acc = 0; cnt = 0; start = i + 1;
      }
    }
    return chunks;
  });
}

/** Integrated loudness (400 ms blocks, gated), loudness range and max short-term loudness. */
function loudnessFromChunks(chunks, withRange = true) {
  const blocks = [];
  const shortTerm = [];
  for (let i = 0; i + 4 <= chunks.length; i++) {
    if (chunks[i + 3].seg !== chunks[i].seg) continue;
    blocks.push((chunks[i].ms + chunks[i + 1].ms + chunks[i + 2].ms + chunks[i + 3].ms) / 4);
  }
  if (withRange) {
    for (let i = 0; i + 30 <= chunks.length; i += 10) {
      if (chunks[i + 29].seg !== chunks[i].seg) continue;
      let sum = 0;
      for (let j = 0; j < 30; j++) sum += chunks[i + j].ms;
      shortTerm.push(sum / 30);
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

export function biquad(type, fc, gainDb, q, rate) {
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
/** 4 significant digits: keeps the stored timeline compact without losing tiny values. */
function round4(x) {
  return Number.isFinite(x) ? Number(x.toPrecision(4)) : 0;
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
  if (peak >= 0.01) {
    const thr = peak * 0.98;
    const flat = 2e-5 * peak; // relative, so the measure does not depend on the file's level
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
