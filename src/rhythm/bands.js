// Band-level onset analysis for the rhythm map (pure: PCM in, arrays out).
//
// The spectrum is split into log-spaced bands (fraction of an octave). For
// each band we keep a log-compressed level and a SuperFlux-style onset
// envelope: the rise of the band's level over the maximum of itself and its
// neighbours two frames earlier. Taking the neighbours into account cancels
// vibrato / glissando (orchestras, melodic synths) while real attacks stay.

import { FFT } from "../audio/fft.js";
import { RHYTHM } from "../config.js";

/**
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {{bandsPerOctave:number, fMin:number, fMax:number}} params
 * @returns {{nb:number, nf:number, frameRate:number, t0:number, bands:{lo:number,hi:number,center:number}[],
 *            flux:Float32Array, level:Float32Array, levelStep:number, duration:number}}
 *          flux / level are band-major (band * nf + frame).
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
  const mag = new Float64Array(nBins);

  for (let t = 0; t < nf; t++) {
    fft.magnitudes(mono, t * H, mag);
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
  for (let b = 0; b < nb; b++) {
    const row = b * nf;
    const up = b > 0 ? (b - 1) * nf : row;
    const dn = b < nb - 1 ? (b + 1) * nf : row;
    for (let t = LAG; t < nf; t++) {
      const ref = Math.max(L[row + t - LAG], L[up + t - LAG], L[dn + t - LAG]);
      const d = L[row + t] - ref;
      flux[row + t] = d > 0 ? d : 0;
    }
  }

  onProgress(1);
  return {
    nb, nf,
    frameRate: sampleRate / H,
    // time of frame 0: attacks peak in the flux when they reach about the
    // first third of the analysis window (measured on synthetic clicks)
    t0: (N * RHYTHM.attackPosition) / sampleRate,
    bands: bands.map(({ lo, hi, center }) => ({ lo, hi, center })),
    // log level log1p(1000·magnitude) per band and frame: display background,
    // and linear attack energy (expm1(level) / 1000) to tell sounds from echoes
    flux, level: L, levelStep: 1,
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
    let k0 = Math.max(1, Math.round(lo / binHz));
    let k1 = Math.min(nBins - 1, Math.round(hi / binHz));
    while (k1 <= k0 && hi < top) {
      hi *= 2 ** (1 / bandsPerOctave);
      k1 = Math.min(nBins - 1, Math.round(hi / binHz));
    }
    if (k1 <= k0) break;
    out.push({ lo: Math.round(lo), hi: Math.round(Math.min(hi, top)), center: Math.round(Math.sqrt(lo * Math.min(hi, top))), k0, k1 });
    lo = hi;
  }
  return out;
}
