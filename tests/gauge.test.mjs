import { test } from "node:test";
import assert from "node:assert/strict";
import { gaugeState, stepGauge } from "../src/ui/live-draw.js";
import { SCORE_MAX } from "../src/config.js";

const run = (st, target, frames, o = {}) => {
  let peak = -Infinity;
  for (let i = 0; i < frames; i++) {
    stepGauge(st, target, { now: (st.last ?? 0) + 1000 / 60, ...o });
    peak = Math.max(peak, st.pos);
  }
  return peak;
};

test("gauge needle overshoots like a speed dial, then settles", () => {
  const st = gaugeState();
  run(st, 20, 2);
  const peak = run(st, 60, 240);
  assert.ok(peak > 62, `overshoot (peak ${peak})`);
  assert.ok(Math.abs(st.pos - 60) < 1.5, `settles (${st.pos})`);
  assert.ok(Math.abs(st.readout - 60) < 0.5);
  assert.equal(Math.hypot(...st.shake), 0); // calm: no shake
  assert.equal(st.sparks.length, 0);
});

test("gauge shakes and sparks past 100, stays within its stops", () => {
  const st = gaugeState();
  run(st, 118, 300, { level: 1 });
  assert.ok(Math.hypot(...st.shake) > 0);
  assert.ok(st.sparks.length > 0);
  assert.ok(st.pos <= SCORE_MAX + 3);
});

test("gauge honours reduced motion and resets without a target", () => {
  const st = gaugeState();
  run(st, 118, 120, { level: 1, reduced: true });
  assert.deepEqual(st.shake, [0, 0]);
  assert.equal(st.sparks.length, 0);
  assert.equal(st.pos, st.readout);
  stepGauge(st, null, { now: st.last + 16 });
  assert.equal(st.pos, null);
});
