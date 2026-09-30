import test from "node:test";
import assert from "node:assert/strict";
import { fastPulseBlocks } from "../src/audio/fast-pulse.js";

const SR = 44100;

function kickTrain(rate, seconds = 8) {
  const x = new Float32Array(seconds * SR);
  const L = Math.round(0.05 * SR);
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const kick = new Float32Array(L);
  let ph = 0;
  for (let i = 0; i < L; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (50 + 120 * Math.exp(-t / 0.008))) / SR;
    kick[i] = Math.sin(ph) * Math.exp(-t / 0.03) + 0.5 * noise() * Math.exp(-t / 0.002);
  }
  for (let p = 0; p < seconds - 0.06; p += 1 / rate) {
    const o = Math.round(p * SR);
    for (let i = 0; i < L; i++) x[o + i] += kick[i];
  }
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.tanh(3 * x[i]);
  return x;
}

function powerChord(f0, seconds = 8) {
  const x = new Float32Array(seconds * SR);
  const saw = (t, f) => 2 * ((t * f) % 1) - 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = 0.3 * Math.tanh(12 * (saw(t, f0) + saw(t, f0 * 1.4983) + 0.5 * saw(t, f0 * 2)));
  }
  return x;
}

const detected = (x) => fastPulseBlocks(x, 0, x.length, SR).filter((b) => b.rate > 0);

test("an extratone kick train (16 hits/s, 960 BPM) is detected at its rate", () => {
  const hits = detected(kickTrain(16));
  assert.ok(hits.length >= 3);
  for (const b of hits) assert.ok(Math.abs(b.rate - 16) < 0.5, `rate ${b.rate}`);
});

test("a kick on every beat is found at its own rate", () => {
  const hits = detected(kickTrain(4));
  assert.ok(hits.length >= 3);
  for (const b of hits) assert.ok(Math.abs(b.rate - 4) < 0.2, `rate ${b.rate}`);
});

test("sustained distorted power chords give no attack rate", () => {
  for (const f0 of [82.4, 61.7, 49]) assert.equal(detected(powerChord(f0)).length, 0, `chord at ${f0} Hz`);
});
