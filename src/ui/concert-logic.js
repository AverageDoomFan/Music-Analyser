// Concert mode: the pure logic behind the visuals (no DOM, no WebGL), so it
// can be unit-tested in Node: onset / kick detection on analyser frames, the
// intensity → palette mapping, the flash limiter (photosensitivity safety)
// and small smoothing helpers.

import { intensityRgb } from "./live-draw.js";
import { SCORE_MAX } from "../config.js";

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

/**
 * Intensity the visuals follow when the live scan gives no reading yet (a
 * plain capture): a guess from the audio level, calm-ish, never "off the charts".
 * @param {number} loud  0..1 (OnsetDetector's loud)
 */
export const levelIntensity = (loud) => clamp(loud * 1.25) * 72;

const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };

/**
 * Fills the renderers' frame parameters from the show state. Feedback
 * amounts are per 1/60 s and scaled by dt, so trails look the same at any
 * frame rate.
 * @param {object} f  frame object to fill (reused)
 * @param {{time:number, dt:number, travel:number, kick:number, bass:number, loud:number, idle:number,
 *   flash:number, drive:object, palette:object, reduced?:boolean}} s
 */
export function visualParams(f, { time, dt, travel, kick: k, bass, loud, idle, flash, drive, palette, reduced = false }) {
  const { heat, hot } = drive;
  const n = clamp(dt * 60, 0.25, 6); // frames of 1/60 s in this one
  const calm = reduced ? 0.35 : 1;
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
  f.zoom = 1 - (0.002 + 0.009 * heat + 0.016 * k) * calm * n;
  f.rot = ((0.0012 + 0.004 * drive.turbulence) * Math.sin(time * 0.07) + 0.008 * hot * Math.sin(time * 1.3)) * calm * n;
  f.decay = Math.pow(0.78 + 0.08 * heat + 0.08 * idle, n);
  f.fade = 0.004 * n;
  f.ringR = 0.26 * (1 + 0.09 * k * (reduced ? 0.3 : 1));
  f.ringH = 0.06 + 0.13 * heat;
  f.bloom = 0.3 + 0.35 * heat + 0.4 * k;
  f.bloomThreshold = 0.75 - 0.25 * heat + 0.2 * hot;
  f.ca = (0.0015 + 0.007 * heat * heat + 0.012 * k * heat + 0.018 * hot) * (reduced ? 0.3 : 1);
  f.exposure = 1.15 + 0.3 * heat + 0.5 * hot;
  f.grain = 0.022 + 0.05 * drive.grit;
  f.glitch = hot > 0 ? (0.25 + 0.75 * hot * (0.4 + k)) * (reduced ? 0.25 : 1) : 0;
  f.flash = flash;
  f.starBright = 0.2 + 0.5 * heat + 0.3 * hot;
  f.palette = palette;
  f.drive = drive;
  return f;
}
