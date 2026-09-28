// Beat level: the tempo must not land an octave off because of hi-hats
// (8th-note hats at 60 BPM, backbeat at 175), and fast kicks keep their BPM.
import test from "node:test";
import assert from "node:assert/strict";
import { extractFeatures, measureClipping } from "../src/audio/features.js";
import { SR } from "./synth.mjs";

function rng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

/** Drum loop: kicks and snares on 16th-note steps of a bar, hats per beat. */
function drums(bpm, { K, S, H = 2, seconds = 16 }) {
  const x = new Float32Array(seconds * SR);
  const rand = rng(7);
  const hit = (t0, len, f) => { const s0 = Math.round(t0 * SR); for (let i = 0; i < len * SR && s0 + i < x.length; i++) x[s0 + i] += f(i / SR); };
  const b = 60 / bpm;
  for (let t0 = 0; t0 < seconds; t0 += 4 * b) {
    for (const k of K) hit(t0 + (k * b) / 4, 0.3, (t) => Math.sin(2 * Math.PI * (50 * t + 3.3 * (1 - Math.exp(-t / 0.03)))) * Math.exp(-t / 0.15));
    for (const k of S) hit(t0 + (k * b) / 4, 0.2, (t) => (0.35 * (rand() * 2 - 1) + 0.25 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t / 0.06));
    let prev = 0;
    for (let h = 0; h < 4 * H; h++) hit(t0 + (h * b) / H, 0.05, (t) => { const w = rand() * 2 - 1; const v = 0.15 * (w - prev) * Math.exp(-t / 0.012); prev = w; return v; });
  }
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < x.length; i++) x[i] *= 0.9 / m;
  return x;
}

const bpmOf = (x) => extractFeatures(x.slice(), SR, measureClipping([x])).bpm;

test("tempo: the beat level, not an octave off", () => {
  const cases = [
    ["slow four-on-the-floor", 70, { K: [0, 4, 8, 12], S: [4, 12] }],
    ["rock, kick on 1 and 3", 120, { K: [0, 8], S: [4, 12] }],
    ["house", 125, { K: [0, 4, 8, 12], S: [4, 12] }],
    ["hardstyle", 150, { K: [0, 4, 8, 12], S: [4, 12] }],
    ["drum and bass", 174, { K: [0, 10], S: [4, 12] }],
    ["hardcore", 200, { K: [0, 4, 8, 12], S: [4, 12] }],
    ["speedcore", 280, { K: [0, 4, 8, 12], S: [], H: 1 }],
  ];
  const wrong = [];
  for (const [name, bpm, p] of cases) {
    const got = bpmOf(drums(bpm, p));
    if (!(Math.abs(got / bpm - 1) < 0.04)) wrong.push(`${name}: ${bpm} → ${got}`);
  }
  assert.deepEqual(wrong, []);
});
