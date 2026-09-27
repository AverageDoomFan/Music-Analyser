// Minimal in-place radix-2 FFT with precomputed tables, plus a helper that
// returns the magnitude spectrum of a windowed real frame.

export class FFT {
  constructor(size) {
    if ((size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    // Hann window
    this.window = new Float64Array(size);
    for (let i = 0; i < size; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    let wsum = 0;
    for (let i = 0; i < size; i++) wsum += this.window[i];
    // Scale so a full-scale sine gives a peak magnitude of ~1.
    this.norm = 2 / wsum;
  }

  transform() {
    const { size, re, im, cos, sin } = this;
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let i = 0; i < size; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  /** Writes size/2+1 magnitudes of `signal[offset .. offset+size)` into `out`. */
  magnitudes(signal, offset, out) {
    const { size, re, im, rev, window, norm } = this;
    const n = signal.length;
    for (let i = 0; i < size; i++) {
      const idx = offset + i;
      const v = idx < n ? signal[idx] : 0;
      const r = rev[i];
      re[r] = v * window[i];
      im[r] = 0;
    }
    this.transform();
    for (let k = 0; k <= size / 2; k++) out[k] = Math.hypot(re[k], im[k]) * norm;
    return out;
  }
}
