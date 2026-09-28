// The browser test bench must pass on the current algorithm: every variable
// moves from min to max, keys are found, tempo within an octave.
import test from "node:test";
import assert from "node:assert/strict";
import { suiteTracks, evaluate, MEASURES } from "../src/testlab/suite.js";
import { extractFeatures, measureClipping } from "../src/audio/features.js";
import { scoreFeatures } from "../src/scoring/index.js";
import { DEFAULT_WEIGHTS } from "../src/config.js";

test("test bench: min / mid / max of every variable", () => {
  const map = new Map();
  for (const t of suiteTracks(12)) {
    if (t.level === "sweep") continue;
    const x = t.render();
    const f = extractFeatures(x.slice(), 44100, measureClipping([x]));
    const auto = scoreFeatures(f, DEFAULT_WEIGHTS, "topMean");
    map.set(t.id, { id: t.id, features: f, auto, finalScore: auto.score, valence: auto.music.mood.valence });
  }
  const res = evaluate(map).filter((r) => !r.sweep);
  const failed = res.filter((r) => r.ok !== true).map((r) => `${r.label}: ${r.rows.map((x) => `${x.level}=${x.measured}`).join(", ")}`);
  assert.deepEqual(failed, []);

  // perceptual targets, as rated by ear on these tracks (algorithm 2.1)
  const v = (id, m) => MEASURES[m].get(map.get(id));
  const off = [];
  const want = (id, m, lo, hi) => { const x = v(id, m); if (!(x >= lo && x <= hi)) off.push(`${id} ${m} = ${x} (want ${lo}–${hi})`); };
  want("brightness-mid", "sub:brightness", 22, 40);
  want("brightness-max", "sub:brightness", 70, 90);
  want("pressure-max", "sub:pressure", 60, 72);
  want("harshness-max", "sub:harshness", 85, 95);
  want("noise-mid", "sub:noise", 30, 50);
  want("noise-max", "sub:noise", 90, 100);
  want("density-min", "sub:density", 0, 15);
  want("density-max", "sub:density", 45, 60);
  want("complexity-min", "sub:complexity", 0, 12);
  want("dynamics-mid", "dynamics", 30, 50);
  want("dynamics-max", "dynamics", 62, 78);
  want("mood-min", "valence", 0, 15);
  want("mood-mid", "valence", 30, 45);
  want("mood-max", "valence", 75, 100);
  want("intensity-min", "score", 0, 5);
  want("intensity-max", "score", 99, 100);
  assert.deepEqual(off, []);
});
