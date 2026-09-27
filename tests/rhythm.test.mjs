import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBandFlux } from "../src/rhythm/bands.js";
import { buildRhythmMap, groupBands, boundariesOf, laneLabel } from "../src/rhythm/notes.js";
import { mapNotes, kpsCurve, difficultyCurve, mapStatistics } from "../src/rhythm/difficulty.js";
import { RHYTHM_DEFAULTS } from "../src/config.js";

const SR = 44100;
function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296); }

// kick on beats, hi-hat on off-beats, a square-ish melody on a 0.375 s grid
function drumMix(D = 12) {
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
    const f = 440 * 2 ** ((notes[k++ % 8] - 69) / 12);
    const s0 = Math.round(t * SR);
    for (let i = 0; i < 0.3 * SR; i++) { const tt = i / SR; let v = 0; for (let h = 1; h <= 5; h += 2) v += Math.sin(2 * Math.PI * f * h * tt) / h; x[s0 + i] += 0.2 * v * Math.min(1, tt / 0.005) * Math.exp(-tt / 0.2); }
  }
  return { x, truth };
}

const recall = (det, truth, tol = 0.02) => truth.filter((t) => det.some((d) => Math.abs(d - t) <= tol)).length / truth.length;
const laneWith = (lanes, truth) => lanes.reduce((best, l) => (recall(l.notes, truth) > recall(best.notes, truth) ? l : best), lanes[0]);

const mix = drumMix();
const mixData = computeBandFlux(mix.x, SR, RHYTHM_DEFAULTS);
const mixMap = buildRhythmMap(mixData, RHYTHM_DEFAULTS);

test("band analysis: log-spaced bands covering the range", () => {
  assert.ok(mixData.nb > 30);
  assert.ok(mixData.bands[0].lo <= 35 && mixData.bands.at(-1).hi >= 15000);
  for (let i = 1; i < mixData.bands.length; i++) assert.ok(mixData.bands[i].lo >= mixData.bands[i - 1].lo);
  assert.equal(mixData.flux.length, mixData.nb * mixData.nf);
  assert.ok(Math.abs(mixData.duration - 12) < 0.01);
});

test("each instrument lands in its own lane, on time", () => {
  const { lanes } = mixMap;
  const kick = laneWith(lanes, mix.truth.kick);
  const hat = laneWith(lanes, mix.truth.hat);
  const mel = laneWith(lanes, mix.truth.mel);
  assert.ok(new Set([kick, hat, mel]).size === 3, "three different lanes");
  assert.ok(kick.hi <= 700, `kick lane ${kick.lo}-${kick.hi}`);
  assert.ok(hat.lo >= 2000, `hat lane ${hat.lo}-${hat.hi}`);
  assert.ok(recall(kick.notes, mix.truth.kick) >= 0.95);
  assert.ok(recall(hat.notes, mix.truth.hat) >= 0.95);
  assert.ok(recall(mel.notes, mix.truth.mel) >= 0.9);
  assert.ok(hat.notes.length <= mix.truth.hat.length + 2, `hat lane precision: ${hat.notes.length}`);
  // timing within ~10 ms
  const errs = mix.truth.kick.map((t) => Math.min(...[...kick.notes].map((d) => Math.abs(d - t))));
  assert.ok(errs.reduce((a, b) => a + b, 0) / errs.length < 0.01);
  const total = lanes.reduce((a, l) => a + l.notes.length, 0);
  const real = mix.truth.kick.length + mix.truth.hat.length + mix.truth.mel.length;
  assert.ok(total < real * 1.5, `echoes removed: ${total} notes for ${real} sounds`);
});

test("echo removal can be turned off", () => {
  const raw = buildRhythmMap(mixData, { ...RHYTHM_DEFAULTS, dedupe: 0 });
  const n = (m) => m.lanes.reduce((a, l) => a + l.notes.length, 0);
  assert.ok(n(raw) > n(mixMap));
});

test("melodic extratone: fast pitched pulses are found, mostly in one lane", () => {
  const D = 6, x = new Float32Array(SR * D), truth = [], rate = 25;
  const pitches = [110, 130.8, 146.8, 164.8, 196, 164.8];
  for (let t = 0.1; t < D - 0.1; t += 1 / rate) {
    truth.push(t);
    const f = pitches[Math.floor(t / 0.5) % pitches.length] * 2;
    const s0 = Math.round(t * SR);
    for (let i = 0; i < SR / rate; i++) { const tt = i / SR; x[s0 + i] += Math.tanh(6 * Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt / 0.012)); }
  }
  const map = buildRhythmMap(computeBandFlux(x, SR, RHYTHM_DEFAULTS), RHYTHM_DEFAULTS);
  const all = map.lanes.flatMap((l) => [...l.notes]);
  assert.ok(recall(all, truth) >= 0.95, `recall ${recall(all, truth)}`);
  const main = map.lanes.reduce((a, l) => (l.notes.length > a.notes.length ? l : a));
  assert.ok(main.notes.length >= 0.6 * truth.length, `main lane ${main.notes.length}/${truth.length}`);
  assert.ok(all.length <= 1.4 * truth.length, `${all.length} notes for ${truth.length} pulses`);
});

test("legato strings with vibrato: note changes are found without flooding", () => {
  const D = 8, x = new Float32Array(SR * D), truth = [];
  const mel = [67, 69, 71, 72, 74, 72, 71, 69, 67, 71, 74, 79, 76, 72, 71, 67];
  const dur = 0.45;
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR, k = Math.floor(t / dur);
    if (k >= mel.length) break;
    const f = 440 * 2 ** ((mel[k] - 69 + 0.25 * Math.sin(2 * Math.PI * 5.5 * t)) / 12); // ±¼ tone vibrato
    ph += (2 * Math.PI * f) / SR;
    const env = 0.6 + 0.4 * Math.min(1, (t - k * dur) / 0.06);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(h * ph) / h;
    x[i] = 0.25 * env * v + 0.08 * Math.sin(2 * Math.PI * 196 * t);
  }
  for (let k = 1; k < mel.length; k++) truth.push(k * dur);
  const map = buildRhythmMap(computeBandFlux(x, SR, RHYTHM_DEFAULTS), RHYTHM_DEFAULTS);
  const all = map.lanes.flatMap((l) => [...l.notes]);
  assert.ok(recall(all, truth, 0.03) >= 0.9, `recall ${recall(all, truth, 0.03)}`);
  assert.ok(all.length <= 4 * truth.length, `${all.length} notes for ${truth.length} changes`);
});

test("grouping parameters: lane count, manual boundaries", () => {
  const two = groupBands(mixData, { ...RHYTHM_DEFAULTS, lanes: 2 });
  assert.ok(two.length <= 2);
  assert.equal(two[0].b0, 0);
  assert.equal(two.at(-1).b1, mixData.nb - 1);
  for (let i = 1; i < two.length; i++) assert.equal(two[i].b0, two[i - 1].b1 + 1, "contiguous");
  const manual = groupBands(mixData, { ...RHYTHM_DEFAULTS, boundaries: [0, 10, 20] });
  assert.deepEqual(boundariesOf(manual), [0, 10, 20]);
  assert.ok(laneLabel(manual[0]).range.includes("Hz"));
});

test("kps and difficulty curves", () => {
  // 4 notes/s then 16 notes/s on two lanes
  const lanes = [{ notes: new Float64Array([]) }, { notes: new Float64Array([]) }];
  const a = [], b = [];
  for (let t = 0; t < 10; t += 0.25) a.push(t);
  for (let t = 10; t < 20; t += 0.0625) (Math.round(t * 16) % 2 ? b : a).push(t);
  lanes[0].notes = Float64Array.from(a);
  lanes[1].notes = Float64Array.from(b);
  const notes = mapNotes(lanes, null);
  assert.equal(notes.length, a.length + b.length);
  const kps = kpsCurve(notes, 20);
  const at = (c, t) => c.values[c.times.findIndex((x) => x >= t)];
  assert.ok(Math.abs(at(kps, 5) - 4) <= 1);
  assert.ok(Math.abs(at(kps, 15) - 16) <= 1);
  const diff = difficultyCurve(notes, 20, 2);
  assert.ok(at(diff, 15) > at(diff, 5) * 2, `${at(diff, 5)} → ${at(diff, 15)}`);
  assert.ok(diff.overall > 0 && diff.peak >= diff.overall);
  const onlyFirst = mapStatistics(lanes, [true, false], 20);
  assert.equal(onlyFirst.notes, a.length);
});
