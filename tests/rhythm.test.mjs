import { test } from "node:test";
import assert from "node:assert/strict";
import * as fx from "./rhythm-fixtures.mjs";
import { computeBandFlux } from "../src/rhythm/bands.js";
import { buildRhythmMap, detectAttacks, mergeLanes, splitLane, laneLabel } from "../src/rhythm/notes.js";
import { mapNotes, kpsCurve, difficultyCurve, mapStatistics } from "../src/rhythm/difficulty.js";
import { RHYTHM_DEFAULTS } from "../src/config.js";

const SR = fx.SR;
const recall = (det, truth, tol = 0.025) => truth.filter((t) => [...det].some((d) => Math.abs(d - t) <= tol)).length / truth.length;
const best = (lanes, truth) => lanes.reduce((b, l) => (recall(l.notes, truth) > recall(b.notes, truth) ? l : b), lanes[0]);
const analyse = (x, params = RHYTHM_DEFAULTS) => {
  const data = computeBandFlux(x, SR, params);
  return { data, map: buildRhythmMap(data, params) };
};

const mix = fx.drumMix();
const mixRun = analyse(mix.x);

test("band analysis: quarter-tone bands, flux, per-frame level", () => {
  const d = mixRun.data;
  assert.ok(d.nb > 120, `${d.nb} bands`); // quarter tones above ~500 Hz, FFT-bin-wide bands below
  assert.equal(d.flux.length, d.nb * d.nf);
  assert.equal(d.rmsDb.length, d.nf);
  assert.ok(Math.abs(d.duration - 12) < 0.01);
});

test("drums + melody: each instrument gets its own lane, on time, without extras", () => {
  const { lanes } = mixRun.map;
  const kick = best(lanes, mix.truth.kick), hat = best(lanes, mix.truth.hat);
  assert.notEqual(kick, hat);
  assert.ok(recall(kick.notes, mix.truth.kick) >= 0.95);
  assert.ok(recall(hat.notes, mix.truth.hat) >= 0.95);
  assert.ok(kick.notes.length <= mix.truth.kick.length + 2, `kick lane ${kick.notes.length}`);
  assert.ok(hat.notes.length <= mix.truth.hat.length + 2, `hat lane ${hat.notes.length}`);
  const all = lanes.flatMap((l) => [...l.notes]);
  assert.ok(recall(all, mix.truth.mel) >= 0.95, "melody found");
  const errs = mix.truth.kick.map((t) => Math.min(...[...kick.notes].map((d) => Math.abs(d - t))));
  assert.ok(errs.reduce((a, b) => a + b, 0) / errs.length < 0.01, "timing within 10 ms");
  assert.ok(laneLabel(kick).range.includes("Hz"));
});

test("piano: every note of a stepwise melody and its chords is found", () => {
  const p = fx.piano();
  const { map } = analyse(p.x);
  const all = map.lanes.flatMap((l) => [...l.notes]);
  assert.ok(recall(all, p.truth.right) >= 0.9, `right hand ${recall(all, p.truth.right)}`);
  assert.ok(recall(all, p.truth.left) >= 0.9, `left hand ${recall(all, p.truth.left)}`);
  // the right hand has a lane of its own
  const rh = best(map.lanes, p.truth.right);
  assert.ok(recall(rh.notes, p.truth.right) >= 0.9);
  assert.ok(rh.notes.length <= p.truth.right.length * 1.25, `right-hand lane ${rh.notes.length}`);
});

test("melodic extratone: fast pulses found, nothing during silences", () => {
  const e = fx.extratone();
  const { map } = analyse(e.x);
  const all = map.lanes.flatMap((l) => [...l.notes]);
  assert.ok(recall(all, e.truth) >= 0.95, `recall ${recall(all, e.truth)}`);
  const fast = e.truth.filter((t) => t >= 6);
  assert.ok(recall(all, fast) >= 0.95, "25 pulses/s section");
  const inSilence = all.filter((t) => e.silent.some(([a, b]) => t > a && t < b));
  assert.equal(inSilence.length, 0, `notes in silence: ${inSilence.map((t) => t.toFixed(2))}`);
  assert.ok(new Set(all.map((t) => Math.round(t * 100))).size <= e.truth.length * 1.1);
});

test("legato strings with vibrato: one note per change", () => {
  const l = fx.legato();
  const { map } = analyse(l.x);
  const all = map.lanes.flatMap((x) => [...x.notes]);
  assert.ok(recall(all, l.truth, 0.03) >= 0.9);
  assert.ok(all.length <= l.truth.length * 1.5, `${all.length} notes for ${l.truth.length} changes`);
});

test("silence gate: pure noise far below the music gives no attack", () => {
  const x = new Float32Array(SR * 4);
  let s = 3;
  for (let i = 0; i < x.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    x[i] = i < SR ? 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR) * (i % 11025 < 2000 ? 1 : 0.2) : 0.0003 * ((s / 4294967296) * 2 - 1);
  }
  const d = computeBandFlux(x, SR, RHYTHM_DEFAULTS);
  const late = detectAttacks(d, RHYTHM_DEFAULTS).filter((a) => d.t0 + a.frame / d.frameRate > 1.3);
  assert.equal(late.length, 0);
});

test("instrument count: automatic or forced; manual merge and split", () => {
  const forced = buildRhythmMap(mixRun.data, { ...RHYTHM_DEFAULTS, instruments: 2 });
  assert.ok(forced.lanes.length <= 2);
  const map = mixRun.map;
  assert.ok(map.lanes.length >= 3, `auto: ${map.lanes.length} instruments`);
  const merged = mergeLanes(map, 1, 0, map.attacks.pool);
  assert.equal(merged.lanes.length, map.lanes.length - 1);
  assert.ok(merged.edited);
  // split the merged lane back (the one holding the most notes)
  const biggest = merged.lanes.reduce((bi, l, i, arr) => (l.notes.length > arr[bi].notes.length ? i : bi), 0);
  const split = splitLane(merged, biggest);
  assert.ok(split && split.lanes.length === merged.lanes.length + 1);
  for (let i = 1; i < map.lanes.length; i++) assert.ok(map.lanes[i].centroid >= map.lanes[i - 1].centroid, "sorted low → high");
});

test("kps and difficulty curves", () => {
  const a = [], b = [];
  for (let t = 0; t < 10; t += 0.25) a.push(t);
  for (let t = 10; t < 20; t += 0.0625) (Math.round(t * 16) % 2 ? b : a).push(t);
  const lanes = [{ notes: Float64Array.from(a) }, { notes: Float64Array.from(b) }];
  const notes = mapNotes(lanes, null);
  assert.equal(notes.length, a.length + b.length);
  const kps = kpsCurve(notes, 20);
  const at = (c, t) => c.values[c.times.findIndex((x) => x >= t)];
  assert.ok(Math.abs(at(kps, 5) - 4) <= 1);
  assert.ok(Math.abs(at(kps, 15) - 16) <= 1);
  const diff = difficultyCurve(notes, 20, 2);
  assert.ok(at(diff, 15) > at(diff, 5) * 2);
  assert.ok(diff.overall > 0 && diff.peak >= diff.overall);
  assert.equal(mapStatistics(lanes, [true, false], 20).notes, a.length);
});
