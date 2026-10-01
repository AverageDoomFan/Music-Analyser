// Concert mode: the pure logic behind the visuals (no DOM, no WebGL), so it
// can be unit-tested in Node: the show prepared from a stored analysis
// (timeline sampled at any time, drops, beat clock, events), the synthesized
// spectrum for tracks with no audio in the page, onset / kick detection on
// analyser frames, the intensity → palette mapping, the flash limiter
// (photosensitivity safety) and small smoothing helpers.

import { intensityRgb } from "./live-draw.js";
import { unpackHits } from "../audio/features.js";

/** Top of the visual scale (white hot). Scores above it still show, the visuals stay at the top. */
export const GAUGE_TOP = 150;
const SCORE_MAX = GAUGE_TOP;

export const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
export const mix = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential approach (rate: 1/s). */
export const approach = (cur, target, dt, rate) => cur + (target - cur) * (1 - Math.exp(-rate * Math.max(0, dt)));

/**
 * Spectral-flux onset detector on AnalyserNode frames (dB magnitudes, as
 * getFloatFrequencyData gives them). Two bands: the full spectrum (any attack)
 * and the low end (kicks, 40–160 Hz). Each band keeps a running mean and
 * deviation of its flux; a frame whose flux clears mean + k·deviation (and a
 * floor) after a refractory time is an onset. Strength is how far it cleared,
 * 0..1.
 */
export class OnsetDetector {
  /**
   * @param {{sampleRate:number, fftSize:number, kickLo?:number, kickHi?:number, maxHz?:number,
   *   k?:number, kickK?:number, refractory?:number, kickRefractory?:number}} o
   */
  constructor({ sampleRate, fftSize, kickLo = 40, kickHi = 160, maxHz = 12000, k = 1.6, kickK = 1.5, refractory = 0.09, kickRefractory = 0.16 }) {
    const bins = fftSize / 2;
    const hz = sampleRate / fftSize;
    this.bins = bins;
    this.kLo = Math.max(1, Math.floor(kickLo / hz));
    this.kHi = Math.max(this.kLo + 1, Math.ceil(kickHi / hz));
    this.top = Math.min(bins, Math.ceil(maxHz / hz));
    this.prev = new Float32Array(bins);
    this.mag = new Float32Array(bins);
    this.k = k;
    this.kickK = kickK;
    this.refractory = refractory;
    this.kickRefractory = kickRefractory;
    this.full = { mean: 0, dev: 0, last: -1 };
    this.low = { mean: 0, dev: 0, last: -1 };
    this.primed = 0;
    this.out = { onset: false, kick: false, strength: 0, kickStrength: 0, flux: 0, kickFlux: 0, bass: 0, mid: 0, high: 0, loud: 0 };
  }

  reset() {
    this.prev.fill(0);
    this.full.mean = this.full.dev = this.low.mean = this.low.dev = 0;
    this.full.last = this.low.last = -1;
    this.primed = 0;
  }

  /**
   * @param {Float32Array} db  frequency data in dB (getFloatFrequencyData)
   * @param {number} time      seconds
   * @returns {{onset:boolean, kick:boolean, strength:number, kickStrength:number, flux:number, kickFlux:number, bass:number, mid:number, high:number, loud:number}}
   *   bass/mid/high/loud: band levels 0..1 (a -80..-20 dB scale)
   */
  push(db, time) {
    const { mag, prev, kLo, kHi, top } = this;
    let flux = 0, kickFlux = 0, bass = 0, mid = 0, high = 0, loud = 0;
    const midLo = kHi, midHi = Math.min(top, kHi * 16);
    for (let i = 1; i < top; i++) {
      const d = db[i];
      // loudness-compressed magnitude: 0 at -90 dB, 1 at -10 dB
      const m = d > -90 ? (d > -10 ? 1 : (d + 90) / 80) : 0;
      mag[i] = m;
      const rise = m - prev[i];
      if (rise > 0) {
        flux += rise;
        if (i >= kLo && i <= kHi) kickFlux += rise;
      }
      prev[i] = m;
      if (i <= kHi) bass = Math.max(bass, d);
      else if (i < midHi) mid += m;
      else high += m;
      loud += m;
    }
    flux /= Math.max(1, top - 1);
    kickFlux /= Math.max(1, kHi - kLo + 1);
    const o = this.out;
    o.flux = flux;
    o.kickFlux = kickFlux;
    o.bass = clamp((bass + 80) / 60);
    o.mid = clamp((mid / Math.max(1, midHi - midLo)) * 1.6);
    o.high = clamp((high / Math.max(1, top - midHi)) * 2.2);
    o.loud = clamp((loud / Math.max(1, top - 1)) * 1.8);
    this.primed++;
    const hit = (band, x, k, refr, floor) => {
      const thr = band.mean + k * band.dev + floor;
      const ok = this.primed > 8 && x > thr && (band.last < 0 || time - band.last >= refr);
      // running statistics (~0.7 s memory at 60 frames/s), updated after the test
      const a = 0.025;
      const dx = x - band.mean;
      band.mean += a * dx;
      band.dev += a * (Math.abs(dx) - band.dev);
      if (!ok) return 0;
      band.last = time;
      return clamp((x - thr) / (thr + 1e-4));
    };
    const s = hit(this.full, flux, this.k, this.refractory, 0.004);
    const ks = hit(this.low, kickFlux, this.kickK, this.kickRefractory, 0.02);
    o.onset = s > 0;
    o.strength = s > 0 ? Math.max(0.15, s) : 0;
    o.kick = ks > 0;
    o.kickStrength = ks > 0 ? Math.max(0.2, ks) : 0;
    return o;
  }
}

/**
 * Limits full-screen flashes: never more than `maxPerSecond` (3 by default,
 * the WCAG general flash threshold), and a softer, rarer flash with
 * prefers-reduced-motion. `request` returns the flash amount to start (0: refused).
 */
export class FlashLimiter {
  constructor({ maxPerSecond = 3, reduced = false } = {}) {
    this.set({ maxPerSecond, reduced });
    this.last = -Infinity;
  }
  set({ maxPerSecond = 3, reduced = false }) {
    this.reduced = reduced;
    this.gap = 1 / Math.min(3, reduced ? Math.min(1, maxPerSecond) : maxPerSecond);
    this.cap = reduced ? 0.25 : 0.85;
  }
  /** @param {number} time seconds  @param {number} amount 0..1 */
  request(time, amount) {
    if (amount <= 0 || time - this.last < this.gap) return 0;
    this.last = time;
    return Math.min(this.cap, amount);
  }
}

/** Heat-ramp colours for an intensity (0..SCORE_MAX) as 0..1 floats. */
export function concertPalette(intensity) {
  const v = clamp(intensity ?? 0, 0, SCORE_MAX);
  const f = (c) => c.map((x) => x / 255);
  // the body colour stays saturated (magenta at most): past 100 the white
  // heat goes to the accents (streaks, ring, sparks), not the whole screen
  const base = f(intensityRgb(Math.min(v, 96)));
  const accent = f(intensityRgb(Math.min(SCORE_MAX, v + 14)));
  // deep shadows: the ramp colour darkened and pulled towards a night blue-violet
  const NIGHT = [0.035, 0.02, 0.09];
  const shadow = f(intensityRgb(Math.max(0, v - 22))).map((x, i) => x * 0.13 + NIGHT[i] * 0.55);
  // 0 below 100, 1 at SCORE_MAX: white-hot "off the charts"
  const hot = clamp((v - 100) / (SCORE_MAX - 100));
  // 0 calm .. 1 at 100
  const heat = clamp(v / 100);
  return { base, accent, shadow, hot, heat };
}

/**
 * Visual drive derived from the intensity and the sub-scores: every number is
 * 0..1 (or a small multiplier) so the renderers stay simple.
 */
export function concertDrive(intensity, sub = null) {
  const heat = clamp((intensity ?? 0) / 100);
  const s = (k) => clamp((sub?.[k] ?? intensity ?? 0) / 100);
  return {
    heat,
    hot: clamp(((intensity ?? 0) - 100) / (SCORE_MAX - 100)),
    speed: 0.15 + 1.6 * heat ** 1.4 + 0.5 * s("tempo"),
    turbulence: 0.2 + 0.9 * (0.6 * heat + 0.4 * s("complexity")),
    sparkle: s("brightness"),
    grit: 0.35 * s("harshness") + 0.65 * s("noise") * heat,
    density: 0.3 + 0.7 * s("density"),
    shake: heat < 0.55 ? 0 : (heat - 0.55) / 0.45,
  };
}

const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };

/**
 * Fills the renderers' frame parameters from the show state. Feedback
 * amounts are per 1/60 s and scaled by dt, so trails look the same at any
 * frame rate.
 * @param {object} f  frame object to fill (reused)
 * @param {{time:number, dt:number, travel:number, kick:number, bass:number, loud:number, idle:number,
 *   flash:number, drive:object, palette:object, reduced?:boolean, kickAt?:number, kickStrength?:number}} s
 *   kickAt / kickStrength: time and strength of the last kick (shockwave)
 *   tension: build-up before a drop (0..1): the feedback turns inwards, the ring tightens
 *   bigAt / bigStrength: the last drop or section change (a slow, refracting shockwave)
 *   cam: {x, y, zoom, roll} camera offset of the final image
 *   pump / kickRate: envelope of the last kick (0..1) and kicks per second here
 *   snap / snapRate: same for the other attacks (snares, claps)
 *   fast: fast-attack drive (0..1)
 *   laser / laserCount / beats / laserHit: laser amount, beams, beat count (sweeps), kick envelope
 */
export function visualParams(f, { time, dt, travel, kick: k, bass, loud, idle, flash, drive, palette, reduced = false, kickAt = -100, kickStrength = 0,
  tension = 0, bigAt = -100, bigStrength = 0, cam = null, pump = 0, kickRate = 0, snap = 0, snapRate = 0, fast = 0,
  laser = 0, laserCount = 4, beats = 0, laserHit = 0 }) {
  const { heat, hot } = drive;
  const n = clamp(dt * 60, 0.25, 6); // frames of 1/60 s in this one
  const calm = reduced ? 0.35 : 1;
  f.shake ??= [0, 0];
  const shakeAmp = reduced ? 0 : (0.004 * drive.shake + 0.012 * k * heat + 0.009 * hot) * (1 - idle);
  f.shake[0] = shakeAmp * (Math.sin(time * 53.1) * 0.6 + Math.sin(time * 31.7 + 1.3) * 0.4);
  f.shake[1] = shakeAmp * (Math.sin(time * 47.3 + 0.7) * 0.6 + Math.sin(time * 27.9) * 0.4);
  f.time = time;
  f.travel = travel;
  f.heat = heat;
  f.hot = hot;
  f.kick = k;
  f.bass = bass;
  f.loud = loud * (1 - idle * 0.8);
  f.idle = idle;
  f.tunnel = smooth(0.35, 0.85, heat);
  const ten = tension * (1 - idle);
  // tension: the trails implode towards the centre and spin, before the drop releases them
  f.zoom = 1 - (0.002 + 0.009 * heat + 0.016 * k) * calm * n * (1 - ten) + 0.011 * ten * calm * n;
  f.rot = ((0.0012 + 0.004 * drive.turbulence) * Math.sin(time * 0.07) + 0.008 * hot * Math.sin(time * 1.3) + 0.01 * ten * ten) * calm * n;
  f.decay = Math.pow(Math.min(0.95, 0.78 + 0.08 * heat + 0.08 * idle + 0.08 * ten), n);
  f.fade = 0.004 * n;
  f.tension = ten;
  f.ringR = 0.26 * (1 + 0.16 * k * (reduced ? 0.3 : 1)) * (1 - 0.2 * ten);
  f.ringH = 0.06 + 0.13 * heat;
  f.bloom = 0.3 + 0.35 * heat + 0.4 * k;
  f.bloomThreshold = 0.75 - 0.25 * heat + 0.2 * hot;
  f.ca = (0.0015 + 0.007 * heat * heat + 0.012 * k * heat + 0.018 * hot) * (reduced ? 0.3 : 1);
  f.exposure = 1.15 + 0.3 * heat + 0.5 * hot;
  f.grain = 0.022 + 0.05 * drive.grit;
  f.glitch = hot > 0 ? (0.25 + 0.75 * hot * (0.4 + k)) * (reduced ? 0.25 : 1) : 0;
  f.flash = flash;
  f.shock ??= [0, 0];
  f.shock[0] = Math.max(0, time - kickAt);
  f.shock[1] = kickStrength * (reduced ? 0.4 : 1) * (0.75 + 0.25 * heat) * (1 - idle);
  f.shock2 ??= [0, 0];
  f.shock2[0] = Math.max(0, time - bigAt);
  f.shock2[1] = bigStrength * (reduced ? 0.4 : 1) * (1 - idle);
  f.cam ??= [0, 0, 1, 0];
  f.cam[0] = cam?.x ?? 0;
  f.cam[1] = cam?.y ?? 0;
  f.cam[2] = cam?.zoom ?? 1;
  f.cam[3] = cam?.roll ?? 0;
  f.starBright = 0.2 + 0.5 * heat + 0.3 * hot + 0.6 * ten;
  f.exposure *= 1 - 0.22 * ten;
  f.ca += 0.01 * ten * (reduced ? 0.3 : 1);
  // kick pump: the whole picture breathes on each kick, less when kicks come fast
  // (no strobing past ~2.5 a second) and not at all with reduced motion
  f.pump = reduced ? 0 : 0.2 * pump * Math.min(1, 2.5 / Math.max(1e-3, kickRate)) * (1 - idle);
  // snare / clap: light panels on the sides of the screen (a small area, never a full flash)
  f.snap = (reduced ? 0.3 : 1) * snap * Math.min(1, 3 / Math.max(1e-3, snapRate)) * (1 - idle);
  // fast attacks (speedcore, blast beats, extratone): the rings vibrate
  f.fast = (reduced ? 0.3 : 1) * fast * (1 - idle);
  f.laser ??= [0, 0, 0, 0];
  f.laser[0] = laser * (1 - idle);
  f.laser[1] = laserCount;
  f.laser[2] = beats;
  f.laser[3] = laserHit;
  f.palette = palette;
  f.drive = drive;
  return f;
}

/**
 * How much of the laser show a moment gets (0..1): lasers come with the
 * heat, fully in a peak and after a drop, a little in a build-up (more as it
 * tightens), barely in a break, an intro or an outro.
 */
export function laserAmount(heat, smp) {
  const base = smooth(0.5, 0.85, heat);
  const label = smp?.section?.label;
  const part = label === "Peak" ? 1 : label === "Build-up" ? 0.35 + 0.5 * (smp.tension ?? 0)
    : label === "Break" || label === "Intro" || label === "Outro" ? 0.2 : 0.75;
  const afterDrop = smp?.sinceDrop != null && smp.sinceDrop < 16 ? 1.25 : 1;
  return clamp(base * part * afterDrop);
}

// ------------------------------------------------------------------ show from a stored analysis

export const BAND_KEYS = ["bandSub", "bandBass", "bandLowMid", "bandHighMid", "bandHigh"];
/** Band centres (Hz, geometric) of the analysis bands: sub, bass, low mids, high mids, highs. */
export const BAND_HZ = [35, 122, 707, 3464, 11500];
const SUB_KEYS = ["energy", "tempo", "density", "brightness", "harshness", "pressure", "complexity", "noise"];
const finite = (x) => typeof x === "number" && Number.isFinite(x);

function median3(a) {
  return a.map((v, i) => {
    const w = [a[Math.max(0, i - 1)], v, a[Math.min(a.length - 1, i + 1)]].sort((x, y) => x - y);
    return w[1];
  });
}

/**
 * Everything the concert needs from an analysed record, precomputed once:
 * per-window curves (intensity and sub-scores as the detail curve shows them,
 * band energies normalised per band, level, attack rates, folded BPM), the
 * sections, the drops and a beat clock. null when the record has no curve.
 * @param {object} r  a library record (r.auto.curves, r.features.timeline, r.auto.music)
 */
export function prepareShow(r) {
  const c = r?.auto?.curves;
  const times = c?.times;
  if (!times?.length || !c.intensity?.length) return null;
  const n = times.length;
  const f = r.features ?? {};
  const sr = f.timeline?.series ?? {};
  const col = (key, fallback) => {
    const a = sr[key];
    const fb = finite(fallback) ? fallback : 0;
    return Array.from({ length: n }, (_, i) => (a && finite(a[i]) ? a[i] : fb));
  };
  const intensity = c.intensity.map((v) => (finite(v) ? v : 0));
  const subs = {};
  for (const k of SUB_KEYS) subs[k] = Array.from({ length: n }, (_, i) => (finite(c.subscores?.[k]?.[i]) ? c.subscores[k][i] : intensity[i]));
  const be = f.bandEnergy ?? {};
  const globalBands = [be.sub, be.bass, be.lowMid, be.highMid, be.high];
  // each band on its own scale (its loudest window = 1): the highs carry a
  // hundredth of the energy of the lows, their movement is what matters
  const bands = BAND_KEYS.map((k, b) => {
    const a = col(k, globalBands[b] ?? 0.2);
    const top = Math.max(1e-9, ...a);
    return a.map((v) => Math.sqrt(clamp(v / top)));
  });
  // level of each window relative to the track (LU), else from the intensity
  const peakI = Math.max(...intensity);
  const rel = sr.loudnessRel ? col("loudnessRel", 0) : intensity.map((v) => (v - peakI) / 5);
  const level = rel.map((v) => clamp((v + 18) / 20));
  const onsetRate = col("onsetRate", f.onsetRate ?? 2);
  const share = col("fastPulseShare", f.fastPulseShare ?? 0);
  const fastRate = col("fastPulseRate", f.fastPulseRate ?? 0).map((v, i) => (share[i] >= 0.2 ? v : 0));
  const globalBpm = [r.auto?.music?.tempo?.bpm, f.bpm].find((x) => finite(x) && x >= 40 && x <= 250) ?? null;
  const conf = col("bpmConfidence", f.bpmConfidence ?? 0);
  const rawBpm = col("bpm", globalBpm ?? 0);
  const bpm = median3(rawBpm.map((v, i) => (v >= 50 && v <= 230 && conf[i] >= 0.3 ? v : globalBpm ?? 120)));
  const bpmSure = globalBpm != null || conf.some((x) => x >= 0.3);
  const heat = intensity.map((v) => clamp(v / 100));
  // how hard the beat hits: the intensity, the low end, the level
  const beatAmt = heat.map((h, i) => clamp((0.2 + 0.8 * h) * (0.55 + 0.45 * Math.max(bands[0][i], bands[1][i])) * (0.3 + 0.7 * level[i]) * (bpmSure ? 1 : 0.6)));
  const duration = [r.duration, f.duration].find((x) => finite(x) && x > 0) ?? times[n - 1] + 3;
  const sections = (r.auto?.music?.sections ?? f.sections ?? [])
    .filter((s) => finite(s?.start) && finite(s?.end) && s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end, label: s.label === "Montée" ? "Build-up" : s.label === "Pic" ? "Peak" : s.label || "Section" }))
    .sort((a, b) => a.start - b.start);
  // when the kicks and the other attacks land (extractor 1.9+), else null: the beat clock stands in
  const kicks = unpackHits(f.hits, "kick");
  const snaps = unpackHits(f.hits, "snap");
  const show = {
    id: r.id, duration, times, intensity, subs, bands, level, onsetRate, fastRate, bpm, beatAmt, sections,
    drops: [], cumBeats: null, beatOffset: 0, bpmSure, kicks, snaps, phaseFix: null,
    peak: peakI, score: finite(r.finalScore) ? r.finalScore : null,
  };
  show.drops = detectDrops(times, intensity, sections);
  // beat clock: beats integrated over the (per-window) tempo
  const cum = new Float64Array(n);
  cum[0] = (times[0] * bpm[0]) / 60;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + ((bpm[i - 1] + bpm[i]) / 2) * (times[i] - times[i - 1]) / 60;
  show.cumBeats = cum;
  // the beats' phase from the kicks heard at the analysis (the tempo alone says how often, not when)
  if (kicks && bpmSure) show.phaseFix = kickPhase(show, kicks);
  // a drop lands on a downbeat: anchor the bar grid on the first one (else on the first peak)
  const anchor = show.drops[0]?.time ?? sections.find((s) => s.label === "Peak")?.start ?? null;
  if (anchor != null) {
    const b = beatsAt(show, anchor);
    // with the phase known, only whole beats move (the anchor is only known to a beat or two)
    const on = show.phaseFix ? Math.round(b) : b;
    show.beatOffset = Math.round(on / 4) * 4 - b + (show.phaseFix ? b - on : 0);
  }
  return show;
}

/**
 * Drops: a big rise of the intensity between windows (6 s windows, 3 s hop:
 * a sudden change shows over two steps) towards something lively. The time
 * is the steepest step, snapped to a section start when one is close (the
 * structure is measured per frame, finer than the windows).
 * @returns {{time:number, from:number, to:number, rise:number}[]}
 */
export function detectDrops(times, intensity, sections = [], { minRise = 14, minTo = 42, gap = 12 } = {}) {
  const n = intensity.length;
  if (n < 3) return [];
  const range = Math.max(...intensity) - Math.min(...intensity);
  const thr = Math.max(minRise, 0.25 * range);
  const rise = intensity.map((v, i) => (i === 0 ? 0 : v - Math.min(intensity[i - 1], intensity[Math.max(0, i - 2)])));
  const out = [];
  for (let i = 1; i < n; i++) {
    if (rise[i] < thr || intensity[i] < minTo) continue;
    // local maximum of the rise (ties: the first)
    if (rise[i - 1] >= rise[i] || (i + 1 < n && rise[i + 1] > rise[i])) continue;
    // steepest of the (up to) two steps that make the rise
    let j = i;
    if (i >= 2 && intensity[i - 1] - intensity[i - 2] > intensity[i] - intensity[i - 1]) j = i - 1;
    let time = (times[j - 1] + times[j]) / 2;
    let best = 4.5;
    for (const s of sections) {
      const d = Math.abs(s.start - time);
      if (d <= best && s.start > 0) { best = d; time = s.start; }
    }
    const from = Math.min(intensity[i - 1], intensity[Math.max(0, i - 2)]);
    const to = Math.max(...intensity.slice(i, i + 2));
    const prev = out.at(-1);
    if (prev && time - prev.time < gap) {
      if (rise[i] > prev.rise) out[out.length - 1] = { time, from, to, rise: rise[i] };
      continue;
    }
    out.push({ time, from, to, rise: rise[i] });
  }
  return out;
}

/**
 * Beat phase correction per window (beats to add, unwrapped) so the clock's
 * beats land on the stored kicks: circular mean of the kicks' phase over
 * ±4 s. Windows whose kicks do not agree (breakbeats, no kicks) take their
 * neighbours' value. null when no window is clear.
 */
export function kickPhase(show, kicks, { span = 4, minKicks = 4, minR = 0.35 } = {}) {
  const { times } = show;
  const n = times.length;
  const raw = new Array(n).fill(null);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (lo < kicks.time.length && kicks.time[lo] < times[i] - span) lo++;
    let c = 0, sn = 0, cnt = 0;
    for (let j = lo; j < kicks.time.length && kicks.time[j] <= times[i] + span; j++) {
      if (kicks.amp[j] < 0.35) continue;
      const ph = beatsAt(show, kicks.time[j]) * 2 * Math.PI;
      const w = kicks.amp[j];
      c += Math.cos(ph) * w;
      sn += Math.sin(ph) * w;
      cnt += w;
    }
    if (cnt < minKicks * 0.5 || Math.hypot(c, sn) / cnt < minR) continue;
    raw[i] = -Math.atan2(sn, c) / (2 * Math.PI);
  }
  const first = raw.findIndex((v) => v != null);
  if (first < 0) return null;
  // fill the gaps with the last known value, then unwrap (never a jump over half a beat)
  const fix = new Float64Array(n);
  let prev = raw[first];
  for (let i = 0; i < n; i++) {
    let v = raw[i] ?? prev;
    v -= Math.round(v - prev);
    fix[i] = prev = v;
  }
  return fix;
}

/** Index of the last hit at or before t (-1 if none). */
export function hitIndex(hits, t) {
  const a = hits.time;
  if (!a.length || t < a[0]) return -1;
  let lo = 0, hi = a.length - 1;
  if (t >= a[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

/** Index k such that times[k] <= t < times[k + 1] (clamped to the ends). */
export function windowIndex(times, t) {
  let lo = 0, hi = times.length - 1;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

/** Smooth interpolation (Catmull-Rom, clamped between the two knots: no overshoot) of a per-window series. */
export function interpAt(arr, times, t, k = windowIndex(times, t)) {
  const n = arr.length;
  if (n === 1 || t <= times[0]) return arr[0];
  if (t >= times[n - 1]) return arr[n - 1];
  const p1 = arr[k], p2 = arr[k + 1];
  const p0 = arr[Math.max(0, k - 1)], p3 = arr[Math.min(n - 1, k + 2)];
  const u = (t - times[k]) / (times[k + 1] - times[k]);
  const u2 = u * u, u3 = u2 * u;
  const v = 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  return clamp(v, Math.min(p1, p2), Math.max(p1, p2));
}

/** Beats elapsed at time t (before the bar-grid offset). */
export function beatsAt(show, t) {
  const { times, bpm, cumBeats: cum, phaseFix: fix } = show;
  const n = times.length;
  if (t <= times[0]) return (t * bpm[0]) / 60 + (fix ? fix[0] : 0);
  if (t >= times[n - 1]) return cum[n - 1] + ((t - times[n - 1]) * bpm[n - 1]) / 60 + (fix ? fix[n - 1] : 0);
  const k = windowIndex(times, t);
  const u = (t - times[k]) / (times[k + 1] - times[k]);
  const b = bpm[k] + (bpm[k + 1] - bpm[k]) * u;
  return cum[k] + ((bpm[k] + b) / 2) * (t - times[k]) / 60 + (fix ? fix[k] + (fix[k + 1] - fix[k]) * u : 0);
}

/**
 * Beat clock at time t: beat count (on the bar grid), phase in the beat (0 on
 * the beat), beat in the bar (0 = downbeat), phase in the bar.
 * @param {number} [nudge]  extra phase (beats), e.g. locked on the kicks heard
 */
export function beatClock(show, t, nudge = 0, out = {}) {
  const b = beatsAt(show, t) + show.beatOffset + nudge;
  const beat = Math.floor(b);
  out.beats = b;
  out.beat = beat;
  out.phase = b - beat;
  out.inBar = ((beat % 4) + 4) % 4;
  out.barPhase = (out.inBar + out.phase) / 4;
  return out;
}

/**
 * The show at time t, written into `out` (reused): interpolated intensity,
 * sub-scores, bands, level, rates, tempo; the section, the next one, the next
 * drop, the build-up tension before it (0..1) and the time since the last.
 */
export function sampleShow(show, t, out = {}) {
  const { times } = show;
  const k = windowIndex(times, t);
  let I = interpAt(show.intensity, times, t, k);
  // a drop is a cliff, not a slope: hold the level before it, jump right on it
  let next = null, last = null;
  for (const d of show.drops) {
    if (d.time > t) { next = d; break; }
    last = d;
  }
  if (next && next.time - t < 4.5) I = Math.min(I, next.from + (I - next.from) * 0.3);
  if (last && t - last.time < 3.5) I = Math.max(I, last.to - (last.to - I) * 0.35);
  out.time = t;
  out.intensity = I;
  out.subs ??= {};
  for (const key of SUB_KEYS) out.subs[key] = interpAt(show.subs[key], times, t, k);
  out.bands ??= new Float32Array(5);
  for (let b = 0; b < 5; b++) out.bands[b] = interpAt(show.bands[b], times, t, k);
  out.level = interpAt(show.level, times, t, k);
  out.onsetRate = interpAt(show.onsetRate, times, t, k);
  out.fastRate = interpAt(show.fastRate, times, t, k);
  out.bpm = interpAt(show.bpm, times, t, k);
  out.beatAmt = interpAt(show.beatAmt, times, t, k);
  if (next && next.time - t < 4.5) out.beatAmt *= 0.55; // the beat drops out before the drop
  // sections
  let si = -1;
  for (let i = 0; i < show.sections.length; i++) if (show.sections[i].start <= t) si = i;
  out.sectionIndex = si;
  out.section = si >= 0 && t < show.sections[si].end + 0.5 ? show.sections[si] : null;
  const ns = show.sections[si + 1] ?? null;
  out.nextSection = ns;
  out.nextSectionIn = ns ? ns.start - t : null;
  out.nextDrop = next;
  out.nextDropIn = next ? next.time - t : null;
  out.sinceDrop = last ? t - last.time : null;
  // tension: the build-up before a drop (the build-up section if it leads to it, else 8 s)
  let tension = 0;
  if (next) {
    const build = show.sections.find((s) => s.label === "Build-up" && Math.abs(s.end - next.time) < 5);
    const L = clamp(build ? next.time - build.start : 8, 4, 16);
    const x = clamp(1 - (next.time - t) / L);
    tension = x * x;
  }
  out.tension = tension;
  out.progress = clamp(t / show.duration);
  // the stored hits around t: time since the last one, its strength, how many per second here
  hitState(show.kicks, t, out, "kick");
  hitState(show.snaps, t, out, "snap");
  return out;
}

function hitState(hits, t, out, name) {
  out[`${name}Known`] = !!hits;
  if (!hits) {
    out[`${name}Since`] = null;
    out[`${name}Amp`] = 0;
    out[`${name}Rate`] = 0;
    return;
  }
  const i = hitIndex(hits, t);
  out[`${name}Since`] = i >= 0 ? t - hits.time[i] : null;
  out[`${name}Amp`] = i >= 0 ? hits.amp[i] : 0;
  // local rate over the last 2 s (the flash safety and the fast-attack effects use it)
  let c = 0;
  for (let j = i; j >= 0 && hits.time[j] > t - 2; j--) c++;
  out[`${name}Rate`] = c / 2;
}

/**
 * Turns playback time into events, frame after frame: beats (downbeat every
 * 4), drops, section changes. A jump (seek, pause, first frame) fires
 * nothing; it only moves the clock.
 */
export class ShowDirector {
  constructor(show) {
    this.show = show;
    this.prev = null;
    this.events = [];
    this.nudge = 0;
  }
  reset() { this.prev = null; }
  /** @returns {{type:"beat"|"drop"|"section"|"kick"|"snap", time:number, index?:number, downbeat?:boolean, drop?:object, section?:object, amp?:number}[]} */
  advance(t) {
    const ev = this.events;
    ev.length = 0;
    const p = this.prev;
    this.prev = t;
    if (p == null || t <= p || t - p > 0.75) return ev;
    const off = this.show.beatOffset + this.nudge;
    const b0 = Math.floor(beatsAt(this.show, p) + off);
    const b1 = Math.floor(beatsAt(this.show, t) + off);
    if (b1 > b0) ev.push({ type: "beat", time: t, index: b1, downbeat: ((b1 % 4) + 4) % 4 === 0 });
    for (const d of this.show.drops) if (d.time > p && d.time <= t) ev.push({ type: "drop", time: d.time, drop: d });
    // stored hits: the strongest kick and attack of the frame (several in one frame look like one)
    for (const [name, hits] of [["kick", this.show.kicks], ["snap", this.show.snaps]]) {
      if (!hits) continue;
      let best = -1;
      for (let i = hitIndex(hits, t); i >= 0 && hits.time[i] > p; i--) if (best < 0 || hits.amp[i] > hits.amp[best]) best = i;
      if (best >= 0) ev.push({ type: name, time: hits.time[best], amp: hits.amp[best] });
    }
    this.show.sections.forEach((s, i) => {
      if (s.start > p && s.start <= t && s.start > 0.5) ev.push({ type: "section", time: s.start, section: s, index: i });
    });
    return ev;
  }
}

const hash = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/**
 * Decaying envelope (0..1) of the last stored hit, scaled by the beat
 * strength here; null when the track has no stored hits (the beat clock stands in).
 */
export function hitEnv(s, name, rate) {
  if (!s[`${name}Known`]) return null;
  const since = s[`${name}Since`];
  if (since == null) return 0;
  return (0.35 + 0.65 * (s.beatAmt ?? 0.6)) * (s[`${name}Amp`] ?? 0.6) * Math.exp(-since * rate);
}

/** Level (0..1) of the analysis bands at a frequency: interpolated in log frequency between band centres. */
export function bandLevelAt(bands, hz) {
  if (hz <= BAND_HZ[0]) return bands[0];
  const lf = Math.log(hz);
  for (let b = 1; b < 5; b++) {
    if (hz <= BAND_HZ[b]) {
      const u = (lf - Math.log(BAND_HZ[b - 1])) / (Math.log(BAND_HZ[b]) - Math.log(BAND_HZ[b - 1]));
      return bands[b - 1] + (bands[b] - bands[b - 1]) * u;
    }
  }
  return bands[4];
}

/**
 * A spectrum for a track whose audio is not in the page (Spotify): the stored
 * band energies spread over log-spaced bins (30 Hz – 16 kHz), shaped by the
 * beat clock (kick in the lows on each beat, snare in the mids on 2 and 4,
 * hi-hats on the fast pulse or the off-beats) and a deterministic shimmer.
 * @param {Float32Array} out  0..1 per bin
 * @param {{bands:ArrayLike<number>, level:number, beatAmt:number, fastRate:number, onsetRate:number, intensity?:number}} s
 * @param {{phase:number, inBar:number}} clock
 * @param {number} time  seconds (shimmer)
 */
export function synthSpectrum(out, s, clock, time) {
  const N = out.length;
  const lo = Math.log(30), hi = Math.log(16000);
  const heat = clamp((s.intensity ?? 50) / 100);
  const kick = hitEnv(s, "kick", 7) ?? s.beatAmt * Math.exp(-clock.phase * 7);
  const snare = hitEnv(s, "snap", 9) ?? (clock.inBar % 2 === 1 ? s.beatAmt * Math.exp(-clock.phase * 9) : 0);
  // hats: the regular fast pulse when there is one, else eighth notes
  const hatPhase = s.fastRate > 0 ? (time * s.fastRate) % 1 : (clock.phase * 2) % 1;
  const hat = clamp(s.onsetRate / 6) * Math.exp(-hatPhase * 12) * (0.4 + 0.6 * heat);
  const lvl = 0.25 + 0.75 * s.level;
  for (let i = 0; i < N; i++) {
    const hz = Math.exp(lo + ((hi - lo) * (i + 0.5)) / N);
    let v = bandLevelAt(s.bands, hz) * lvl * (0.45 + 0.35 * heat);
    // shimmer: two sines per bin, different speeds
    const h1 = hash(i * 1.3), h2 = hash(i * 7.1 + 3);
    v *= 0.72 + 0.18 * Math.sin(time * (1.1 + 3.2 * h1) + h2 * 6.283) + 0.1 * Math.sin(time * (5 + 9 * h2) + h1 * 6.283);
    if (hz < 160) v += kick * 0.55 * Math.exp(-Math.abs(Math.log(hz / 60)) * 1.4);
    else if (hz < 2500) v += snare * 0.35 * Math.exp(-Math.abs(Math.log(hz / 900)) * 1.1);
    if (hz > 5000) v += hat * 0.4 * (0.6 + 0.4 * h1);
    out[i] = clamp(v);
  }
  return out;
}

/** A waveform to go with the synthesized spectrum: low sines pumped by the kick, mids, a little hiss (about -1..1). */
export function synthWave(out, s, clock, time) {
  const N = out.length;
  const kick = hitEnv(s, "kick", 6) ?? s.beatAmt * Math.exp(-clock.phase * 6);
  const a0 = (0.25 + 0.75 * Math.max(s.bands[0], s.bands[1])) * (0.35 + 0.65 * kick);
  const a1 = 0.35 * s.bands[2], a2 = 0.25 * s.bands[3], a3 = 0.2 * s.bands[4];
  const lvl = 0.3 + 0.7 * s.level;
  const tick = Math.floor(time * 30) * 977;
  for (let i = 0; i < N; i++) {
    const x = i / N;
    const v = a0 * Math.sin(6.283 * (2 * x) + time * 2.1) +
      a1 * Math.sin(6.283 * (9 * x) - time * 5.3) +
      a2 * Math.sin(6.283 * (27 * x) + time * 11.7) +
      a3 * (hash(i + tick) - 0.5) * 2;
    out[i] = v * lvl * 0.8;
  }
  return out;
}

/** Rotates an RGB colour (0..1) around the grey axis by `deg` degrees. */
export function hueRotate(c, deg, out = [0, 0, 0]) {
  const a = (deg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  const k = (1 - cs) / 3, q = Math.sqrt(1 / 3) * sn;
  const r = c[0], g = c[1], b = c[2];
  out[0] = clamp(r * (cs + k) + g * (k - q) + b * (k + q));
  out[1] = clamp(r * (k + q) + g * (cs + k) + b * (k - q));
  out[2] = clamp(r * (k - q) + g * (k + q) + b * (cs + k));
  return out;
}

/** Palette hue offset (degrees) a section brings: the heat colours stay readable, each part gets its own light. */
export function sectionHue(label, index = 0) {
  switch (label) {
    case "Intro": return -25;
    case "Build-up": return 20;
    case "Peak": return index % 2 ? 12 : 0;
    case "Break": return -70;
    case "Outro": return -40;
    default: return index % 2 ? 30 : -30;
  }
}

/** m:ss */
export function clockText(s) {
  if (!finite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return `${m}:${String(x).padStart(2, "0")}`;
}
