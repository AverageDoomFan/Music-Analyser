// Streaming loudness meter (ITU-R BS.1770 style, mono mix + 3 dB like the
// extractor): momentary (400 ms), short-term (3 s), gated integrated loudness,
// loudness range and sample peak, updated as audio blocks arrive.

import { biquad } from "../audio/features.js";

const toLufs = (ms) => -0.691 + 10 * Math.log10(ms + 1e-12) + 3.01;

export class LoudnessMeter {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.f1 = biquad("highshelf", 1681.974450955533, 3.999843853973347, 0.7071752369554196, sampleRate);
    this.f2 = biquad("highpass", 38.13547087602444, 0, 0.5003270373238773, sampleRate);
    this.hop = Math.round(0.1 * sampleRate);
    this.reset();
  }

  reset() {
    this.s = [0, 0, 0, 0, 0, 0, 0, 0];
    this.acc = 0;
    this.cnt = 0;
    this.chunks = [];      // 100 ms K-weighted mean squares of the current segment
    this.blocks = [];      // 400 ms blocks (75 % overlap) of every segment
    this.shortTerm = [];   // 3 s values every second, every segment
    this.peak = 0;
    this.blockPeak = 0;
  }

  /** Starts a new excerpt: filters and block chaining restart, gated history is kept. */
  cut() {
    this.s.fill(0);
    this.acc = 0;
    this.cnt = 0;
    this.chunks = [];
  }

  push(x) {
    const { f1, f2, s } = this;
    let [x1, x2, y1, y2, u1, u2, z1, z2] = s;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (a > this.blockPeak) this.blockPeak = a;
      const y = f1.b0 * v + f1.b1 * x1 + f1.b2 * x2 - f1.a1 * y1 - f1.a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      const z = f2.b0 * y + f2.b1 * u1 + f2.b2 * u2 - f2.a1 * z1 - f2.a2 * z2;
      u2 = u1; u1 = y; z2 = z1; z1 = z;
      this.acc += z * z;
      if (++this.cnt === this.hop) {
        const c = this.chunks;
        c.push(this.acc / this.hop);
        this.acc = 0;
        this.cnt = 0;
        const n = c.length;
        if (n >= 4) this.blocks.push((c[n - 1] + c[n - 2] + c[n - 3] + c[n - 4]) / 4);
        if (n >= 30 && n % 10 === 0) {
          let sum = 0;
          for (let j = n - 30; j < n; j++) sum += c[j];
          this.shortTerm.push(sum / 30);
        }
      }
    }
    s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2; s[4] = u1; s[5] = u2; s[6] = z1; s[7] = z2;
  }

  /** Current values in LUFS / LU / dBFS (null when not enough audio yet). */
  read() {
    const c = this.chunks;
    const avg = (from) => {
      if (c.length < from) return null;
      let s = 0;
      for (let j = c.length - from; j < c.length; j++) s += c[j];
      return toLufs(s / from);
    };
    const peakDb = 20 * Math.log10(this.blockPeak + 1e-12);
    this.blockPeak = 0;
    return {
      momentary: avg(4),
      shortTerm: avg(30),
      integrated: this.integrated(),
      range: this.range(),
      peakDb,
      truePeakDb: 20 * Math.log10(this.peak + 1e-12),
      seconds: this.blocks.length * 0.1,
    };
  }

  integrated() {
    const abs = this.blocks.filter((z) => toLufs(z) > -70);
    if (!abs.length) return null;
    const rel = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const g = abs.filter((z) => toLufs(z) > rel);
    return g.length ? toLufs(g.reduce((a, b) => a + b, 0) / g.length) : null;
  }

  range() {
    const abs = this.shortTerm.filter((z) => toLufs(z) > -70);
    if (abs.length < 3) return 0;
    const rel = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 20;
    const v = abs.filter((z) => toLufs(z) > rel).map(toLufs).sort((a, b) => a - b);
    if (v.length < 3) return 0;
    const q = (p) => {
      const pos = (v.length - 1) * p;
      const lo = Math.floor(pos);
      return v[lo] + (v[Math.ceil(pos)] - v[lo]) * (pos - lo);
    };
    return q(0.95) - q(0.1);
  }

  /** Same shape as the extractor's track loudness, for window analysis. */
  reference() {
    const integrated = this.integrated() ?? -70;
    const st = this.shortTerm.map(toLufs);
    return { integrated, range: this.range(), shortTermMax: st.length ? Math.max(...st) : integrated };
  }
}
