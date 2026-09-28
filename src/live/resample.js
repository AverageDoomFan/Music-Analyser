// Streaming band-limited resampler (windowed sinc), used when the capture
// runs at the device rate (usually 48 kHz) instead of the analysis rate.

const HALF = 16; // taps on each side

export class StreamResampler {
  constructor(fromRate, toRate) {
    this.ratio = fromRate / toRate;          // input samples per output sample
    this.cutoff = Math.min(1, toRate / fromRate) * 0.95;
    this.buf = new Float32Array(0);          // pending input (with HALF samples of history)
    this.pos = HALF;                          // next output position, in input samples, inside buf
    this.passthrough = fromRate === toRate;
  }

  /** @returns {Float32Array} resampled block (may be empty) */
  push(input) {
    if (this.passthrough) return input;
    const buf = new Float32Array(this.buf.length + input.length);
    buf.set(this.buf);
    buf.set(input, this.buf.length);
    const out = [];
    const fc = this.cutoff;
    let pos = this.pos;
    while (pos + HALF < buf.length) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      let s = 0, wsum = 0;
      for (let k = -HALF + 1; k <= HALF; k++) {
        const t = k - frac;
        const x = Math.PI * t * fc;
        const sinc = t === 0 ? 1 : Math.sin(x) / x;
        const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / HALF) + 0.08 * Math.cos((2 * Math.PI * t) / HALF);
        const c = sinc * w;
        s += buf[i0 + k] * c;
        wsum += c;
      }
      out.push(s / wsum);
      pos += this.ratio;
    }
    // keep history for the next block
    const keepFrom = Math.max(0, Math.floor(pos) - HALF);
    this.buf = buf.slice(keepFrom);
    this.pos = pos - keepFrom;
    return Float32Array.from(out);
  }
}
