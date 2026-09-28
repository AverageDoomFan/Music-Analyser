// Test tracks shaped for the algorithm. A parametric groove (kick, snare,
// hats, bass, chords, arpeggio, noise, saturation…) where each test moves
// ONE parameter from min to max, the others staying neutral. Pure functions:
// they run in a Web Worker in the browser and in Node for the test suite.

export const SR = 44100;

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Neutral values: a mid-tempo, mid-bright, clean groove in C major. */
export const NEUTRAL = Object.freeze({
  bpm: 120,          // number or function of time (s) → BPM
  kick: 0.55, kickDrive: 1, sub: 0.25,
  snare: 0.3, hats: 0.12, hatDiv: 2,
  chords: 0.22, bass: 0.25, arp: 0, lead: 0,
  key: 0, mode: "major",
  bright: 0.45,      // harmonic roll-off of the tonal parts (0..0.9)
  cutoff: 0,         // Hz, low-pass on the whole mix (0 = none); number or function of time
  noise: 0,          // continuous white-noise level (number or function)
  drive: 1,          // saturation of the mix (tanh gain)
  clip: 0,           // hard clip at (1 - clip) of the peak
  irregular: 0,      // 0..1: random skips / shifts of hits and timbre changes
  swell: 0,          // 0..1: loudness contrast between 8-bar halves (dynamics)
  seed: 1,
});

const val = (v, t) => (typeof v === "function" ? v(t) : v);

/**
 * @param {object} params  overrides of NEUTRAL
 * @param {number} seconds
 * @returns {Float32Array} mono, peak-normalised to 0.9
 */
export function renderTrack(params = {}, seconds = 20) {
  const p = { ...NEUTRAL, ...params };
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const rand = rng(p.seed);

  // beat grid (tempo may vary with time)
  const beats = [];
  for (let t = 0; t < seconds; ) {
    beats.push(t);
    t += 60 / Math.max(20, val(p.bpm, t));
  }
  const sub16 = [];
  for (let i = 0; i < beats.length; i++) {
    const b0 = beats[i], b1 = beats[i + 1] ?? b0 + 60 / val(p.bpm, b0);
    for (let k = 0; k < 4; k++) sub16.push({ t: b0 + ((b1 - b0) * k) / 4, beat: i, k });
  }
  const jitter = () => (p.irregular ? (rand() - 0.5) * 0.08 * p.irregular : 0);
  const skip = () => p.irregular && rand() < 0.35 * p.irregular;

  // drums
  for (const s of sub16) {
    const bar = Math.floor(s.beat / 4), inBar = s.beat % 4;
    if (s.k === 0 && p.kick > 0 && !skip()) kick(x, s.t + jitter(), p.kick, p.kickDrive, p.sub);
    if (p.irregular > 0.5 && s.k === 3 && rand() < 0.3 * p.irregular) kick(x, s.t, p.kick * 0.8, p.kickDrive, p.sub);
    if (s.k === 0 && (inBar === 1 || inBar === 3) && p.snare > 0 && !skip()) noiseHit(x, s.t + jitter(), 0.18, p.snare, rand, 0.07, false);
    if (p.hats > 0 && s.k % (4 / p.hatDiv) === 0 && !skip()) noiseHit(x, s.t + jitter(), 0.05, p.hats, rand, 0.012, true);
    void bar;
  }
  // harmony: I–vi–IV–V (major) or i–iv–V–i (minor, harmonic V for a clear key)
  const prog = p.mode === "minor" ? [[0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7]] : [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]];
  const root = 60 + p.key;
  for (let b = 0; b < beats.length; b += 4) {
    const t0 = beats[b], t1 = beats[b + 4] ?? seconds;
    let ch = prog[(b / 4) % 4];
    const tone = p.irregular > 0 && rand() < p.irregular * 0.7 ? 0.2 + rand() * 0.7 : p.bright; // timbre changes
    if (p.chords > 0) for (const iv of ch) addTone(x, t0, t1 - t0, midi(root + iv), p.chords, { harmonics: 8, bright: tone, attack: 0.02, release: 0.1 });
    if (p.bass > 0) addTone(x, t0, t1 - t0, midi(root - 24 + ch[0]), p.bass, { harmonics: 4, bright: tone * 0.8, attack: 0.01, release: 0.05 });
    if (p.arp > 0) {
      for (let k = b * 4; k < Math.min(sub16.length, (b + 4) * 4); k++) {
        if (skip()) continue;
        const note = root + 12 + ch[k % 3] + (p.irregular ? Math.floor(rand() * 3) * 12 * (rand() < p.irregular * 0.5) : 0);
        addTone(x, sub16[k].t + jitter(), 0.12, midi(note), p.arp, { harmonics: 6, bright: tone, attack: 0.003, decay: 0.08 });
      }
    }
    if (p.lead > 0) addTone(x, t0, (t1 - t0) * 0.9, midi(root + 12 + ch[2]), p.lead, { harmonics: 10, bright: Math.min(0.9, tone + 0.2), attack: 0.05, release: 0.1 });
  }
  // continuous noise
  if (p.noise) for (let i = 0; i < n; i++) x[i] += val(p.noise, i / SR) * (rand() * 2 - 1);
  // dynamics: alternate loud / quiet 8-beat halves
  if (p.swell > 0) {
    const period = (60 / val(p.bpm, 0)) * 16;
    for (let i = 0; i < n; i++) {
      const phase = ((i / SR) % period) / period;
      x[i] *= phase < 0.5 ? 1 : 10 ** ((-24 * p.swell) / 20);
    }
  }
  // tone: low-pass on the mix (two one-pole stages)
  if (p.cutoff) {
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const fc = val(p.cutoff, i / SR);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
      y1 += a * (x[i] - y1);
      y2 += a * (y1 - y2);
      x[i] = y2;
    }
  }
  if (p.drive > 1) {
    let pk = 0;
    for (const v of x) pk = Math.max(pk, Math.abs(v));
    const g = pk > 0 ? 1 / pk : 1;
    for (let i = 0; i < n; i++) x[i] = Math.tanh(x[i] * g * p.drive);
  }
  normalize(x, 0.9);
  if (p.clip > 0) {
    const lv = 0.9 * (1 - p.clip);
    for (let i = 0; i < n; i++) x[i] = Math.max(-lv, Math.min(lv, x[i]));
    normalize(x, 0.9);
  }
  return x;
}

/** Concatenates sections [{seconds, params}] with 60 ms crossfades. */
export function renderSong(sections, base = {}) {
  const parts = sections.map((s, i) => renderTrack({ ...base, seed: (base.seed ?? 1) + i, ...s.params }, s.seconds));
  // keep the sections' relative levels: undo each part's normalisation with its gain
  const fade = Math.round(0.06 * SR);
  const total = parts.reduce((a, q) => a + q.length, 0) - fade * (parts.length - 1);
  const out = new Float32Array(total);
  let off = 0;
  parts.forEach((q, i) => {
    const g = sections[i].gain ?? 1;
    for (let k = 0; k < q.length; k++) {
      const w = i > 0 && k < fade ? k / fade : 1;
      const w2 = i < parts.length - 1 && k >= q.length - fade ? (q.length - k) / fade : 1;
      out[off + k] += q[k] * g * Math.min(w, w2);
    }
    off += q.length - fade;
  });
  normalize(out, 0.9);
  return out;
}

function normalize(x, peak) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
}

function addTone(x, t0, dur, freq, amp, { harmonics = 1, bright = 0.5, attack = 0.01, decay = 0, release = 0.05 } = {}) {
  const s0 = Math.max(0, Math.round(t0 * SR));
  const len = Math.round(dur * SR);
  const hs = [];
  for (let h = 1; h <= harmonics && freq * h < SR / 2 - 500; h++) hs.push([2 * Math.PI * freq * h / SR, bright ** (h - 1)]);
  for (let i = 0; i < len && s0 + i < x.length; i++) {
    const t = i / SR;
    let env = Math.min(1, t / attack) * Math.min(1, (dur - t) / release);
    if (decay) env *= Math.exp(-t / decay);
    let v = 0;
    for (const [w, a] of hs) v += Math.sin(w * i) * a;
    x[s0 + i] += amp * env * v;
  }
}

function kick(x, t0, amp, drive, sub) {
  const s0 = Math.max(0, Math.round(t0 * SR));
  const n = Math.round(0.45 * SR);
  let ph = 0;
  for (let i = 0; i < n && s0 + i < x.length; i++) {
    const t = i / SR;
    const f = 48 + 110 * Math.exp(-t / 0.03);
    ph += (2 * Math.PI * f) / SR;
    let v = Math.sin(ph) * Math.exp(-t / (0.12 + sub * 0.4));
    if (drive > 1) v = Math.tanh(v * drive);
    x[s0 + i] += amp * v;
  }
}

function noiseHit(x, t0, dur, amp, rand, decay, highpass) {
  const s0 = Math.max(0, Math.round(t0 * SR));
  const n = Math.round(dur * SR);
  let prev = 0;
  for (let i = 0; i < n && s0 + i < x.length; i++) {
    const w = rand() * 2 - 1;
    const v = highpass ? w - prev : w;
    prev = w;
    x[s0 + i] += amp * v * Math.exp(-(i / SR) / decay);
  }
}

/** 16-bit PCM WAV bytes. */
export function toWav(samples, sampleRate = SR) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return buf;
}
