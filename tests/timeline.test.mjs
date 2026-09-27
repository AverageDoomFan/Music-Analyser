import { test } from "node:test";
import assert from "node:assert/strict";
import { tracks, SR } from "./synth.mjs";
import { extractFeatures, measureClipping } from "../src/audio/features.js";
import { scoreFeatures } from "../src/scoring/model.js";
import { aggregate, aggregateAll } from "../src/scoring/aggregate.js";
import { createRecord, applyFeatures, rescore } from "../src/core/track.js";
import { buildProgression } from "../src/playlist/progression.js";
import { DEFAULT_WEIGHTS, AGGREGATIONS } from "../src/config.js";

test("aggregations of a known curve", () => {
  const v = [10, 10, 10, 10, 90, 90, 90, 10];
  const t = v.map((_, i) => 3 + i * 3);
  assert.equal(aggregate(v, "mean", t), 40);
  assert.equal(aggregate(v, "median", t), 10);
  assert.equal(aggregate(v, "topMean", t), 90); // top 25 % = 2 windows
  assert.equal(aggregate(v, "peak", t), 90);    // 3 consecutive windows at 90
  assert.ok(aggregate(v, "perceptual", t) > 40 && aggregate(v, "perceptual", t) < 90);
  const t10 = v.map((_, i) => 5 + i * 10); // 75 s track: first / last 20 s = 3 windows
  assert.equal(aggregate(v, "start", t10), 10);
  assert.ok(Math.abs(aggregate(v, "end", t10) - (90 + 90 + 10) / 3) < 1e-9);
  assert.equal(aggregate(v, "variability", t), 80);
  // a single spike is smoothed away by the sustained peak
  assert.ok(aggregate([10, 10, 95, 10, 10, 10], "peak") < 50);
});

// calm -> extreme -> calm: 30 s ambient, 30 s speedcore, 30 s ambient
function dynamicTrack() {
  const a = tracks.ambient(), b = tracks.speedcore();
  const seg = 30 * SR;
  const x = new Float32Array(seg * 3);
  for (let i = 0; i < seg; i++) x[i] = a[i % a.length];
  for (let i = 0; i < seg; i++) x[seg + i] = b[i % b.length];
  for (let i = 0; i < seg; i++) x[2 * seg + i] = a[i % a.length];
  return x;
}

const dyn = dynamicTrack();
const dynFeatures = extractFeatures(dyn, SR, measureClipping([dyn]));

test("features include a timeline that follows the music", () => {
  const tl = dynFeatures.timeline;
  assert.ok(tl.times.length >= 25, `${tl.times.length} windows`);
  assert.equal(tl.series.onsetRate.length, tl.times.length);
  const at = (t) => tl.times.reduce((best, x, i) => (Math.abs(x - t) < Math.abs(tl.times[best] - t) ? i : best), 0);
  assert.ok(tl.series.loudnessRel[at(45)] > tl.series.loudnessRel[at(5)] + 6, "the loud middle is louder than the intro");
  assert.ok(tl.series.flatnessMedian[at(45)] > tl.series.flatnessMedian[at(5)] * 10);
});

test("the intensity curve and its aggregations", () => {
  const r = scoreFeatures(dynFeatures);
  const s = r.stats;
  assert.equal(r.curves.intensity.length, dynFeatures.timeline.times.length);
  assert.ok(s.peak > 80, `peak ${s.peak}`);
  assert.ok(s.start < 30 && s.end < 30, `start ${s.start} end ${s.end}`);
  assert.ok(s.peak >= s.topMean - 1 && s.topMean > s.mean && s.mean > s.median, JSON.stringify(s));
  assert.ok(s.variability > 50);
  for (const a of AGGREGATIONS) {
    const x = scoreFeatures(dynFeatures, DEFAULT_WEIGHTS, a.key);
    assert.equal(x.score, s[a.key]);
    assert.equal(x.aggregation, a.key);
  }
});

test("stationary tracks score the same whatever the aggregation", () => {
  const x = tracks.metal();
  const f = extractFeatures(x, SR, measureClipping([x]));
  const scores = AGGREGATIONS.map((a) => scoreFeatures(f, DEFAULT_WEIGHTS, a.key).score);
  assert.ok(Math.max(...scores) - Math.min(...scores) < 6, scores.join(" "));
});

test("changing the aggregation rescores from cached features", () => {
  const rec = createRecord({ id: "dyn", name: "dyn.wav", size: 1 });
  applyFeatures(rec, dynFeatures, { weights: DEFAULT_WEIGHTS, aggregation: "mean" });
  const mean = rec.finalScore;
  assert.ok(rescore(rec, { weights: DEFAULT_WEIGHTS, aggregation: "peak" }));
  assert.ok(rec.finalScore > mean + 20);
  assert.equal(rescore(rec, { weights: DEFAULT_WEIGHTS, aggregation: "peak" }), false);
});

test("progression prefers smooth seams between endings and openings", () => {
  const sub = { energy: 50, tempo: 50, density: 50, brightness: 50, harshness: 50, pressure: 50, complexity: 50, noise: 0 };
  const items = [
    { id: "a", name: "a", score: 50, start: 50, end: 80, subscores: sub },  // ends loud
    { id: "b", name: "b", score: 52, start: 20, end: 52, subscores: sub },  // opens quiet
    { id: "c", name: "c", score: 53, start: 80, end: 53, subscores: sub },  // opens loud
  ];
  const order = buildProgression(items, { tolerance: 6 }).steps.map((s) => s.id);
  assert.equal(order.indexOf("c"), order.indexOf("a") + 1, order.join(""));
});

test("aggregateAll exposes every statistic", () => {
  const all = aggregateAll([1, 2, 3], [3, 6, 9]);
  for (const k of ["mean", "median", "peak", "topMean", "perceptual", "start", "end", "variability"]) assert.ok(k in all);
});
