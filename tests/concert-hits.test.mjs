// Concert mode, extractor 1.9: kicks and snares stored at the analysis, and
// the show driven by them (beat phase, events, envelopes, effect safety).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFeatures, unpackHits, HIT_STEP } from "../src/audio/features.js";
import {
  prepareShow, beatClock, sampleShow, ShowDirector, synthSpectrum, hitEnv, hitIndex, visualParams, concertDrive, concertPalette, laserAmount,
} from "../src/ui/concert-logic.js";

const SR = 44100;

/** 30 s of a kick every 0.5 s (from 0.5 s) and a noise snare every second (from 0.75 s). */
function drums() {
  const x = new Float32Array(SR * 30);
  const kicks = [], snares = [];
  for (let t = 0.5; t < 29.5; t += 0.5) {
    kicks.push(t);
    const s0 = Math.round(t * SR);
    for (let i = 0; i < SR * 0.25; i++) {
      const tt = i / SR, f = 50 + 80 * Math.exp(-tt / 0.03);
      x[s0 + i] += 0.8 * Math.min(1, tt / 0.002) * Math.exp(-tt / 0.12) * Math.sin(2 * Math.PI * f * tt);
    }
  }
  let r = 1;
  for (let t = 0.75; t < 29.5; t += 1) {
    snares.push(t);
    const s0 = Math.round(t * SR);
    for (let i = 0; i < SR * 0.15; i++) {
      r = (r * 16807) % 2147483647;
      const tt = i / SR;
      x[s0 + i] += 0.4 * Math.min(1, tt / 0.001) * Math.exp(-tt / 0.05) * ((r / 2147483647) * 2 - 1);
    }
  }
  return { x, kicks, snares };
}

const nearest = (arr, t) => arr.reduce((b, v) => (Math.abs(v - t) < Math.abs(b - t) ? v : b), Infinity);

test("extractor: kicks and snares stored where they are, compact", () => {
  const { x, kicks, snares } = drums();
  const f = extractFeatures(x, SR, {});
  const k = unpackHits(f.hits, "kick"), s = unpackHits(f.hits, "snap");
  assert.equal(f.hits.step, HIT_STEP);
  assert.equal(k.time.length, kicks.length, "one hit per kick, no tails");
  for (const t of kicks) assert.ok(Math.abs(nearest(k.time, t) - t) <= 0.02, `kick at ${t}`);
  assert.equal(s.time.length, snares.length, "one hit per snare, no tails");
  for (const t of snares) assert.ok(Math.abs(nearest(s.time, t) - t) <= 0.02, `snare at ${t}`);
  for (const a of k.amp) assert.ok(a >= 0 && a <= 1);
  assert.ok(JSON.stringify(f.hits).length < 1000, "a few bytes per hit");
  assert.equal(unpackHits(null, "kick"), null);
  assert.equal(unpackHits({ kick: [] }, "kick"), null);
});

/** A 60 s show at 120 BPM whose kicks land 0.13 s after the analysis grid would put them. */
function record(withHits = true) {
  const times = Array.from({ length: 19 }, (_, i) => 3 + i * 3);
  const intensity = times.map((t) => (t < 30 ? 30 : 85));
  const fill = (v) => times.map(() => v);
  const kickT = [];
  for (let t = 0.13; t < 60; t += 0.5) kickT.push(t);
  const snapT = kickT.map((t) => t + 0.25);
  const pack = (ts) => ts.map((t, i) => Math.round(t / HIT_STEP) - (i ? Math.round(ts[i - 1] / HIT_STEP) : 0));
  return {
    id: "h1", duration: 60,
    features: {
      bpm: 120, bpmConfidence: 0.9, duration: 60,
      timeline: { times, series: { bpm: fill(120), bpmConfidence: fill(0.9), onsetRate: fill(4) } },
      hits: withHits ? { step: HIT_STEP, kick: pack(kickT), kickAmp: "9".repeat(kickT.length), snap: pack(snapT), snapAmp: "6".repeat(snapT.length) } : undefined,
    },
    auto: { curves: { times, intensity, subscores: {} }, music: { tempo: { bpm: 120 }, sections: [{ start: 0, end: 30, label: "Intro" }, { start: 30, end: 60, label: "Peak" }] } },
  };
}

test("beat clock: the stored kicks set the phase, the drop still sets the bar", () => {
  const s = prepareShow(record());
  assert.ok(s.phaseFix, "phase measured");
  for (const t of [5.13, 20.63, 41.13]) {
    const c = beatClock(s, t);
    const off = Math.min(c.phase, 1 - c.phase);
    assert.ok(off < 0.02, `a kick at ${t} is on a beat (phase ${c.phase.toFixed(3)})`);
  }
  assert.equal(s.drops[0].time, 30);
  assert.equal(beatClock(s, 30.13).inBar, 0, "the kick nearest the drop is a downbeat");
  // without hits: the old clock, beats at the analysis grid
  const old = prepareShow(record(false));
  assert.equal(old.phaseFix, null);
  assert.equal(old.kicks, null);
});

test("director: one kick event per stored kick, snares too; a seek fires nothing", () => {
  const s = prepareShow(record());
  const d = new ShowDirector(s);
  let kicks = 0, snaps = 0;
  for (let t = 0; t <= 60; t += 1 / 60) {
    for (const e of d.advance(t)) {
      if (e.type === "kick") { kicks++; assert.ok(e.amp > 0.9); }
      if (e.type === "snap") snaps++;
    }
  }
  assert.equal(kicks, s.kicks.time.length);
  assert.equal(snaps, s.snaps.time.length);
  const j = new ShowDirector(s);
  j.advance(10);
  assert.ok(!j.advance(20).some((e) => e.type === "kick"));
  assert.equal(hitIndex(s.kicks, 0), -1);
  assert.equal(s.kicks.time[hitIndex(s.kicks, 0.2)], s.kicks.time[0]);
});

test("sampleShow: time since the last kick, local rates; the synth pulses on the stored kicks", () => {
  const s = prepareShow(record());
  const on = sampleShow(s, 40.14, {}), off = sampleShow(s, 40.5, {});
  assert.ok(on.kickKnown && on.kickSince < 0.02 && off.kickSince > 0.3);
  assert.ok(Math.abs(on.kickRate - 2) <= 0.5, `${on.kickRate} kicks/s`);
  assert.ok(hitEnv(on, "kick", 7) > hitEnv(off, "kick", 7) * 3);
  const N = 256, a = new Float32Array(N), b = new Float32Array(N);
  const clk = { phase: 0.5, inBar: 0 }; // the clock says off-beat: the stored kick wins
  synthSpectrum(a, { ...on, bands: [1, 1, 0.5, 0.3, 0.2] }, clk, 1);
  synthSpectrum(b, { ...off, bands: [1, 1, 0.5, 0.3, 0.2] }, clk, 1);
  const low = (x) => x.slice(5, 40).reduce((p, q) => p + q, 0);
  assert.ok(low(a) > low(b) * 1.2);
  // no hits: the beat clock stands in
  const old = sampleShow(prepareShow(record(false)), 40.14, {});
  assert.equal(hitEnv(old, "kick", 7), null);
});

test("effects: the kick pump calms down when kicks come fast; lasers follow the heat and the part", () => {
  const base = { time: 10, dt: 1 / 60, travel: 0, kick: 1, bass: 0, loud: 0.5, idle: 0, flash: 0, drive: concertDrive(90), palette: concertPalette(90) };
  const slow = visualParams({}, { ...base, pump: 1, kickRate: 2 });
  const fast = visualParams({}, { ...base, pump: 1, kickRate: 12 });
  assert.ok(slow.pump > 0 && fast.pump < slow.pump / 3, `${slow.pump} vs ${fast.pump}`);
  assert.equal(visualParams({}, { ...base, pump: 1, kickRate: 2, reduced: true }).pump, 0, "no pump with reduced motion");
  assert.equal(visualParams({}, { ...base, pump: 1, kickRate: 2, idle: 1 }).pump, 0, "none when paused");
  const peak = laserAmount(0.95, { section: { label: "Peak" }, tension: 0, sinceDrop: 3 });
  const brk = laserAmount(0.95, { section: { label: "Break" }, tension: 0, sinceDrop: null });
  assert.ok(peak > 0.9 && brk < 0.3);
  assert.equal(laserAmount(0.3, { section: { label: "Peak" } }), 0, "calm: no lasers");
  const f = visualParams({}, { ...base, laser: 0.8, laserCount: 5, beats: 12.5, laserHit: 0.4 });
  assert.deepEqual(f.laser, [0.8, 5, 12.5, 0.4]);
});
