// Deterministic synthetic "tracks" used to sanity-check feature extraction and
// the ordering produced by the scoring model. They are caricatures of genres,
// not realistic music: the tests only assert coarse orderings.

export const SR = 44100;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function buffer(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

function normalizePeak(x, peak) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  const g = m > 0 ? peak / m : 0;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function addTone(x, t0, dur, freq, amp, { harmonics = 1, decay = 0, attack = 0.005, bright = 0.5 } = {}) {
  const s0 = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n && s0 + i < x.length; i++) {
    const t = i / SR;
    let env = Math.min(1, t / attack) * (decay ? Math.exp(-t / decay) : 1);
    env *= Math.min(1, (dur - t) / 0.02);
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * freq * h * t) * bright ** (h - 1);
    x[s0 + i] += amp * env * v;
  }
}

function addKick(x, t0, amp, { decay = 0.18, drive = 0, f0 = 150, f1 = 45 } = {}) {
  const s0 = Math.round(t0 * SR);
  const n = Math.round(decay * 3 * SR);
  let phase = 0;
  for (let i = 0; i < n && s0 + i < x.length; i++) {
    const t = i / SR;
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.03);
    phase += (2 * Math.PI * f) / SR;
    let v = Math.sin(phase) * Math.exp(-t / decay);
    if (drive) v = Math.tanh(v * drive);
    x[s0 + i] += amp * v;
  }
}

function addNoiseHit(x, t0, dur, amp, rand, { decay = 0.05, highpass = false } = {}) {
  const s0 = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  let prev = 0;
  for (let i = 0; i < n && s0 + i < x.length; i++) {
    const w = rand() * 2 - 1;
    const v = highpass ? w - prev : w;
    prev = w;
    x[s0 + i] += amp * v * Math.exp(-(i / SR) / decay);
  }
}

function distort(x, drive) {
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive);
  return x;
}

function hardClip(x, level) {
  for (let i = 0; i < x.length; i++) x[i] = Math.max(-level, Math.min(level, x[i]));
  return x;
}

const DUR = 16;

export const tracks = {
  ambient() {
    const x = buffer(DUR);
    const chords = [[57, 64, 69, 72], [53, 60, 65, 69], [55, 62, 67, 71]];
    chords.forEach((c, i) => c.forEach((n) => addTone(x, i * 5.3, 7, midi(n), 0.1, { attack: 2.5, harmonics: 2, bright: 0.2 })));
    return normalizePeak(x, 0.12);
  },
  piano() {
    const x = buffer(DUR);
    const notes = [60, 64, 67, 72, 71, 67, 64, 62, 60, 65, 69, 72, 71, 67, 62, 59, 60, 64, 67, 72];
    notes.forEach((n, i) => addTone(x, i * 0.75, 2.5, midi(n), 0.3, { harmonics: 6, decay: 0.8, bright: 0.45 }));
    return normalizePeak(x, 0.5);
  },
  orchestralEpic() {
    const x = buffer(DUR);
    const rand = rng(3);
    const chord = [38, 45, 50, 53, 57, 62, 65, 69, 74, 77];
    for (let b = 0; b < 4; b++) chord.forEach((n) => addTone(x, b * 4, 4.2, midi(n) * (1 + (rand() - 0.5) * 0.004), 0.12, { attack: 0.4, harmonics: 8, bright: 0.6 }));
    for (let t = 0; t < DUR; t += 60 / 70) addKick(x, t, 0.8, { decay: 0.35, f0: 120, f1: 70 });
    return normalizePeak(x, 0.95);
  },
  pop() {
    const x = buffer(DUR);
    const rand = rng(5);
    const beat = 60 / 110;
    for (let t = 0, i = 0; t < DUR; t += beat / 2, i++) {
      if (i % 2 === 0) addKick(x, t, 0.9);
      if (i % 4 === 2) addNoiseHit(x, t, 0.2, 0.4, rand, { decay: 0.08 });
      addNoiseHit(x, t, 0.05, 0.12, rand, { decay: 0.015, highpass: true });
    }
    for (let bar = 0; bar < DUR / (beat * 4); bar++) {
      const root = [45, 41, 48, 43][bar % 4];
      addTone(x, bar * beat * 4, beat * 4, midi(root), 0.3, { harmonics: 3, bright: 0.5 });
      [12, 16, 19].forEach((d) => addTone(x, bar * beat * 4, beat * 4, midi(root + d + 12), 0.08, { harmonics: 4, bright: 0.5 }));
    }
    distort(x, 1.5);
    return normalizePeak(x, 0.95);
  },
  rapSlow() {
    const x = buffer(DUR);
    const rand = rng(7);
    const beat = 60 / 75;
    for (let t = 0, i = 0; t < DUR; t += beat, i++) {
      addKick(x, t, 1.0, { decay: 0.45, f0: 90, f1: 40 });
      if (i % 2 === 1) addNoiseHit(x, t, 0.25, 0.35, rand, { decay: 0.1 });
    }
    for (let t = 0; t < DUR; t += beat / 4) addNoiseHit(x, t, 0.03, 0.06, rand, { decay: 0.01, highpass: true });
    for (let t = 0.1; t < DUR; t += 0.28) addTone(x, t, 0.2, 180 + rand() * 60, 0.12, { harmonics: 10, bright: 0.7, decay: 0.12 });
    return normalizePeak(x, 0.95);
  },
  metal() {
    const x = buffer(DUR);
    const rand = rng(11);
    const beat = 60 / 180;
    const gtr = buffer(DUR);
    for (let bar = 0; bar < DUR / (beat * 4); bar++) {
      const root = [40, 40, 43, 38][bar % 4];
      [0, 7, 12].forEach((d) => addTone(gtr, bar * beat * 4, beat * 4, midi(root + d), 0.5, { harmonics: 3, bright: 0.6 }));
    }
    distort(gtr, 12);
    for (let i = 0; i < x.length; i++) x[i] = 0.35 * gtr[i];
    for (let t = 0, i = 0; t < DUR; t += beat / 4, i++) {
      addKick(x, t, 0.6, { decay: 0.06, f0: 200, f1: 60 });
      if (i % 8 === 4) addNoiseHit(x, t, 0.2, 0.5, rand, { decay: 0.08 });
      if (i % 2 === 0) addNoiseHit(x, t, 0.08, 0.15, rand, { decay: 0.04, highpass: true });
    }
    distort(x, 2);
    return normalizePeak(x, 0.98);
  },
  hardstyle() {
    const x = buffer(DUR);
    const rand = rng(13);
    const beat = 60 / 150;
    for (let t = 0; t < DUR; t += beat) addKick(x, t, 1, { decay: 0.2, drive: 8, f0: 200, f1: 55 });
    for (let t = beat / 2; t < DUR; t += beat) addNoiseHit(x, t, 0.1, 0.25, rand, { decay: 0.03, highpass: true });
    for (let bar = 0; bar < DUR / (beat * 4); bar++) addTone(x, bar * beat * 4, beat * 4, midi(69 + (bar % 2) * 3), 0.12, { harmonics: 12, bright: 0.85 });
    distort(x, 2.5);
    return normalizePeak(x, 0.99);
  },
  speedcore() {
    const x = buffer(DUR);
    const rand = rng(17);
    const beat = 60 / 300;
    for (let t = 0; t < DUR; t += beat) addKick(x, t, 1, { decay: 0.1, drive: 20, f0: 250, f1: 60 });
    for (let t = 0; t < DUR; t += beat / 2) addNoiseHit(x, t, 0.1, 0.5, rand, { decay: 0.05 });
    for (let i = 0; i < x.length; i++) x[i] += 0.2 * (rand() * 2 - 1);
    distort(x, 5);
    hardClip(x, 0.9);
    return normalizePeak(x, 1.0);
  },
  extratone() {
    const x = buffer(DUR);
    const rand = rng(19);
    const beat = 60 / 1300;
    for (let t = 0; t < DUR; t += beat) addKick(x, t, 1, { decay: 0.05, drive: 40, f0: 300, f1: 80 });
    for (let i = 0; i < x.length; i++) x[i] += 0.5 * (rand() * 2 - 1);
    distort(x, 10);
    hardClip(x, 0.85);
    return normalizePeak(x, 1.0);
  },
  harshNoise() {
    const x = buffer(DUR);
    const rand = rng(23);
    let lp = 0;
    for (let i = 0; i < x.length; i++) {
      const w = rand() * 2 - 1;
      lp = 0.7 * lp + 0.3 * w;
      x[i] = w * 0.8 + lp * 0.8 * Math.sin(i / 3000);
    }
    distort(x, 8);
    hardClip(x, 0.9);
    return normalizePeak(x, 1.0);
  },
};

/** Expected coarse order, calmest first. */
export const EXPECTED_ORDER = ["ambient", "piano", "rapSlow", "pop", "orchestralEpic", "hardstyle", "metal", "speedcore", "harshNoise", "extratone"];

export function toWav(samples, sampleRate = SR) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}
