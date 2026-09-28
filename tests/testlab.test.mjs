// The browser test bench must pass on the current algorithm: every variable
// moves from min to max, keys are found, tempo within an octave.
import test from "node:test";
import assert from "node:assert/strict";
import { suiteTracks, evaluate } from "../src/testlab/suite.js";
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
});
