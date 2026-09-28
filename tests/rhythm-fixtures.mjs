// Synthetic material for the rhythm-map tests (deterministic).
export const SR = 44100;

function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296); }
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function pianoNote(x, t, note, amp) {
  const f = midi(note);
  const s0 = Math.round(t * SR);
  const tau = 1.6 * (261 / f) ** 0.5; // lower notes ring longer
  const n = Math.min(x.length - s0, Math.round(3 * tau * SR));
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    let v = 0;
    for (let h = 1; h <= 8; h++) {
      const fh = f * h * Math.sqrt(1 + 0.0004 * h * h); // slight inharmonicity
      if (fh > 15000) break;
      v += Math.sin(2 * Math.PI * fh * tt) * Math.exp(-tt / (tau / h ** 0.7)) / h;
    }
    x[s0 + i] += amp * v * Math.min(1, tt / 0.002);
  }
}

/** Piano: right-hand stepwise melody (8ths, often one semitone/tone apart) + left-hand chords. */
export function piano(D = 10) {
  const x = new Float32Array(SR * D);
  const truth = { right: [], left: [] };
  const scale = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 61, 62];
  let k = 0;
  for (let t = 0.2; t < D - 1; t += 0.2) {
    truth.right.push(t);
    pianoNote(x, t, scale[k++ % scale.length] + 12, 0.18);
  }
  const chords = [[36, 43, 48], [41, 48, 53], [43, 50, 55], [36, 43, 52]];
  k = 0;
  for (let t = 0.2; t < D - 1; t += 0.8) {
    truth.left.push(t);
    for (const n of chords[k++ % chords.length]) pianoNote(x, t, n, 0.16);
  }
  // keep it below full scale (a clipped export would add distortion attacks)
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < x.length; i++) x[i] *= 0.8 / peak;
  return { x, truth, all: [...new Set([...truth.right, ...truth.left].map((v) => Math.round(v * 1000)))].map((v) => v / 1000).sort((a, b) => a - b) };
}

/** Kick on beats, hi-hat on off-beats, square-ish melody on a 0.375 s grid. */
export function drumMix(D = 12) {
  const x = new Float32Array(SR * D);
  const rnd = rng(1);
  const truth = { kick: [], hat: [], mel: [] };
  for (let t = 0.25; t < D - 0.5; t += 0.5) {
    truth.kick.push(t);
    const s0 = Math.round(t * SR);
    let ph = 0;
    for (let i = 0; i < 0.25 * SR; i++) { const tt = i / SR; ph += (2 * Math.PI * (45 + 100 * Math.exp(-tt / 0.03))) / SR; x[s0 + i] += 0.8 * Math.sin(ph) * Math.exp(-tt / 0.12); }
  }
  for (let t = 0.5; t < D - 0.5; t += 0.5) {
    truth.hat.push(t);
    const s0 = Math.round(t * SR);
    let pv = 0;
    for (let i = 0; i < 0.06 * SR; i++) { const w = rnd() * 2 - 1; x[s0 + i] += 0.25 * (w - pv) * Math.exp(-(i / SR) / 0.015); pv = w; }
  }
  const notes = [69, 72, 76, 74, 71, 79, 77, 72];
  let k = 0;
  for (let t = 0.37; t < D - 0.5; t += 0.375) {
    truth.mel.push(t);
    const f = midi(notes[k++ % 8]);
    const s0 = Math.round(t * SR);
    for (let i = 0; i < 0.3 * SR; i++) { const tt = i / SR; let v = 0; for (let h = 1; h <= 5; h += 2) v += Math.sin(2 * Math.PI * f * h * tt) / h; x[s0 + i] += 0.2 * v * Math.min(1, tt / 0.005) * Math.exp(-tt / 0.2); }
  }
  return { x, truth };
}

/**
 * Melodic extratone with a silent break and a faster section:
 * 0–4 s pulses at 16/s, 4–6 s silence (faint noise), 6–10 s pulses at 25/s, then silence.
 */
export function extratone() {
  const D = 12, x = new Float32Array(SR * D), truth = [];
  const rnd = rng(9);
  const pitches = [110, 130.8, 146.8, 164.8, 196, 164.8];
  const pulse = (t, rate) => {
    truth.push(t);
    const f = pitches[Math.floor(t / 0.5) % pitches.length] * 2;
    const s0 = Math.round(t * SR);
    for (let i = 0; i < SR / rate; i++) { const tt = i / SR; x[s0 + i] += Math.tanh(6 * Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt / 0.012)); }
  };
  for (let t = 0.1; t < 4; t += 1 / 16) pulse(t, 16);
  for (let t = 6; t < 10; t += 1 / 25) pulse(t, 25);
  for (let i = 0; i < x.length; i++) x[i] += 0.0005 * (rnd() * 2 - 1); // dither / noise floor
  return { x, truth, silent: [[4.1, 5.9], [10.2, 12]] };
}

/** Legato strings with a ±¼-tone vibrato over a quiet pad. */
export function legato() {
  const D = 8, x = new Float32Array(SR * D), truth = [];
  const mel = [67, 69, 71, 72, 74, 72, 71, 69, 67, 71, 74, 79, 76, 72, 71, 67];
  const dur = 0.45;
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR, k = Math.floor(t / dur);
    if (k >= mel.length) break;
    const f = 440 * 2 ** ((mel[k] - 69 + 0.25 * Math.sin(2 * Math.PI * 5.5 * t)) / 12);
    ph += (2 * Math.PI * f) / SR;
    const env = 0.6 + 0.4 * Math.min(1, (t - k * dur) / 0.06);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(h * ph) / h;
    x[i] = 0.25 * env * v + 0.08 * Math.sin(2 * Math.PI * 196 * t);
  }
  for (let k = 1; k < mel.length; k++) truth.push(k * dur);
  return { x, truth };
}
