import test from "node:test";
import assert from "node:assert/strict";
import { tracks, SR } from "./synth.mjs";
import { extractFeatures } from "../src/audio/features.js";
import { detectKey, keyName, camelot, keyDistance, relative } from "../src/audio/music.js";

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

/** Chords (MIDI notes) of 2 s each, piano-like tones. */
function progression(chords, reps = 3) {
  const x = new Float32Array(Math.round(chords.length * reps * 2 * SR));
  let t0 = 0;
  for (let r = 0; r < reps; r++) {
    for (const ch of chords) {
      for (const n of ch) {
        const f = midi(n);
        const s0 = Math.round(t0 * SR);
        for (let i = 0; i < 2 * SR; i++) {
          const t = i / SR;
          const env = Math.min(1, t / 0.01) * Math.exp(-t / 1.2);
          let v = 0;
          for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * t) * 0.5 ** (h - 1);
          x[s0 + i] += 0.08 * env * v;
        }
      }
      t0 += 2;
    }
  }
  return x;
}

test("Camelot wheel and key distances", () => {
  assert.equal(camelot(0), "8B");        // C
  assert.equal(camelot(21), "8A");       // Am
  assert.equal(camelot(7), "9B");        // G
  assert.equal(keyName(13), "C#m");
  assert.equal(keyName(1), "Db");
  assert.equal(relative(0), 21);
  assert.equal(keyDistance(0, 0), 0);
  assert.equal(keyDistance(0, 21), 1);   // relative minor
  assert.equal(keyDistance(0, 7), 1);    // C → G
  assert.equal(keyDistance(0, 6), 6);    // C → F#: clash
});

test("key of a C major and an A minor progression", () => {
  const cMajor = progression([[48, 60, 64, 67], [53, 60, 65, 69], [55, 59, 62, 67], [48, 60, 64, 67]]);
  const fC = extractFeatures(cMajor, SR);
  assert.equal(keyName(fC.keyIndex), "C", `got ${keyName(fC.keyIndex)}`);
  const aMinor = progression([[45, 57, 60, 64], [50, 57, 62, 65], [52, 56, 59, 64], [45, 57, 60, 64]]);
  const fA = extractFeatures(aMinor, SR);
  assert.equal(keyName(fA.keyIndex), "Am", `got ${keyName(fA.keyIndex)}`);
  assert.ok(fA.keyConfidence > 0.1);
  assert.equal(fA.chroma.length, 12);
  // same key, transposed up a fifth → G
  const g = progression([[55, 67, 71, 74], [60, 67, 72, 76], [62, 66, 69, 74], [55, 67, 71, 74]]);
  assert.equal(keyName(extractFeatures(g, SR).keyIndex), "G");
});

test("structure: calm / intense / calm sections", () => {
  const parts = [tracks.ambient(), tracks.ambient(), tracks.hardstyle(), tracks.hardstyle(), tracks.ambient(), tracks.ambient()];
  const x = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  const b = [];
  for (const p of parts) { b.push(o / SR); x.set(p, o); o += p.length; }
  const f = extractFeatures(x, SR);
  assert.ok(Array.isArray(f.sections) && f.sections.length >= 3, JSON.stringify(f.sections));
  const peaks = f.sections.filter((s) => s.label === "Pic");
  assert.ok(peaks.length >= 1);
  for (const p of peaks) assert.ok(p.start >= b[2] - 3 && p.end <= b[4] + 3, JSON.stringify(f.sections));
  // a boundary near the start and the end of the intense part
  const bounds = f.sections.map((s) => s.start);
  assert.ok(bounds.some((t) => Math.abs(t - b[2]) < 3), `bounds ${bounds}`);
  assert.ok(bounds.some((t) => Math.abs(t - b[4]) < 3), `bounds ${bounds}`);
  assert.equal(f.sections[0].label, "Intro");
});

test("timbre fingerprint: similar sounds are closer", () => {
  const v = (f) => [...f.mfccMean, ...f.mfccStd];
  const dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
  const metal = v(extractFeatures(tracks.metal(), SR));
  const hard = v(extractFeatures(tracks.hardstyle(), SR));
  const amb = v(extractFeatures(tracks.ambient(), SR));
  const piano = v(extractFeatures(tracks.piano(), SR));
  assert.ok(dist(amb, piano) < dist(amb, metal), "ambient closer to piano than to metal");
  assert.ok(dist(metal, hard) < dist(metal, piano), "metal closer to hardstyle than to piano");
});

test("tempo stability and alternative octave", () => {
  const f = extractFeatures(tracks.hardstyle(), SR);
  assert.ok(f.bpmStability > 0.5, `stability ${f.bpmStability}`);
  assert.ok(f.bpmAlt === f.bpm * 2 || Math.abs(f.bpmAlt - f.bpm / 2) < 0.1);
});
