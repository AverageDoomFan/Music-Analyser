// Band-level analysis for the rhythm map (pure: PCM in, arrays out).
//
// The spectrum is split into log-spaced bands (24 per octave by default: a
// quarter tone, fine enough to separate neighbouring notes). For each band we
// keep a log-compressed level and a SuperFlux-style onset envelope: the rise
// of the band's level over the maximum of itself and its immediate
// neighbours two frames earlier, weighted by how sudden the rise is (slow
// rises: beating partials, swells). The neighbours cancel vibrato / glissando;
// they are only used when they lie within a quarter tone, so a new note one
// semitone away from a ringing one (a piano scale) is never masked.
// Low bands narrower than one FFT bin are widened (and then have no
// neighbour masking).

import { FFT } from "../audio/fft.js";
import { RHYTHM } from "../config.js";

/**
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {{bandsPerOctave:number, fMin:number, fMax:number}} params
 * @returns {{nb, nf, frameRate, t0, bands:{lo,hi,center}[], flux:Float32Array, level:Float32Array,
 *            levelStep:number, rmsDb:Float32Array, duration:number}}
 *          flux / level are band-major (band * nf + frame); rmsDb is per frame.
 */
export function computeBandFlux(mono, sampleRate, params, onProgress = () => {}) {
  const N = RHYTHM.fftSize;
  const H = RHYTHM.hopSize;
  const fft = new FFT(N);
  const nBins = N / 2 + 1;
  const binHz = sampleRate / N;
  const bands = makeBands(params, binHz, nBins);
  const nb = bands.length;
  const nf = Math.max(1, Math.floor((mono.length - N) / H) + 1);
  const L = new Float32Array(nb * nf);
  const rmsDb = new Float32Array(nf);
  const mag = new Float64Array(nBins);

  for (let t = 0; t < nf; t++) {
    const off = t * H;
    let sq = 0;
    for (let i = off; i < off + N && i < mono.length; i++) sq += mono[i] * mono[i];
    rmsDb[t] = 10 * Math.log10(sq / N + 1e-12);
    fft.magnitudes(mono, off, mag);
    for (let b = 0; b < nb; b++) {
      const { k0, k1 } = bands[b];
      let p = 0;
      for (let k = k0; k < k1; k++) p += mag[k] * mag[k];
      L[b * nf + t] = Math.log1p(1000 * Math.sqrt(p / (k1 - k0)));
    }
    if ((t & 1023) === 0) onProgress(t / nf);
  }

  const flux = new Float32Array(nb * nf);
  const LAG = 2;
  const SHARP_WIN = 8;
  const quarterTone = 2 ** (1 / 24) * 1.01;
  for (let b = 0; b < nb; b++) {
    const row = b * nf;
    const useUp = b > 0 && bands[b].center / bands[b - 1].center <= quarterTone;
    const useDn = b < nb - 1 && bands[b + 1].center / bands[b].center <= quarterTone;
    const up = useUp ? (b - 1) * nf : row;
    const dn = useDn ? (b + 1) * nf : row;
    for (let t = LAG; t < nf; t++) {
      const ref = Math.max(L[row + t - LAG], L[up + t - LAG], L[dn + t - LAG]);
      const d = L[row + t] - ref;
      if (d <= 0) continue;
      // Sharpness: share of the recent rise (from the lowest level of the last
      // ~46 ms) that happened in the last two frames. An attack jumps (≈ 1);
      // beating partials and swells climb slowly (≪ 1) and are attenuated.
      let low = L[row + t];
      for (let k = Math.max(0, t - SHARP_WIN); k <= t; k++) low = Math.min(low, L[row + k]);
      const sharp = Math.min(1, (L[row + t] - L[row + t - LAG]) / (L[row + t] - low + 1e-6));
      flux[row + t] = d * sharp * sharp;
    }
  }
  onProgress(1);
  return {
    nb, nf,
    frameRate: sampleRate / H,
    // time of frame 0: attacks peak in the flux when they reach this point of
    // the analysis window (measured on synthetic clicks)
    t0: (N * RHYTHM.attackPosition) / sampleRate,
    bands: bands.map(({ lo, hi, center }) => ({ lo, hi, center })),
    // log level log1p(1000·magnitude) per band and frame: display background,
    // attack spectra and linear attack energy (expm1(level) / 1000)
    flux, level: L, levelStep: 1,
    rmsDb,
    duration: mono.length / sampleRate,
  };
}

function makeBands({ bandsPerOctave, fMin, fMax }, binHz, nBins) {
  const out = [];
  const top = Math.min(fMax, (nBins - 1) * binHz);
  let lo = fMin;
  while (lo < top) {
    let hi = lo * 2 ** (1 / bandsPerOctave);
    // a band must cover at least one FFT bin: widen the lowest ones
    const k0 = Math.max(1, Math.round(lo / binHz));
    let k1 = Math.min(nBins - 1, Math.round(hi / binHz));
    while (k1 <= k0 && hi < top) {
      hi *= 2 ** (1 / bandsPerOctave);
      k1 = Math.min(nBins - 1, Math.round(hi / binHz));
    }
    if (k1 <= k0) break;
    out.push({ lo: Math.round(lo), hi: Math.round(Math.min(hi, top)), center: Math.sqrt(lo * Math.min(hi, top)), k0, k1 });
    lo = hi;
  }
  return out;
}
