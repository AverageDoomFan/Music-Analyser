import test from "node:test";
import assert from "node:assert/strict";
import { generateSet, curveAt, tempoCost, transitionParts, splitTracks, CURVE_PRESETS } from "../src/playlist/set.js";

function pool(n = 40, seed = 3) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const score = Math.round(rnd() * 100);
    return {
      id: `t${i}`, name: `T${i}`, artist: `a${i % 7}`, duration: 180 + Math.round(rnd() * 60),
      score, start: score - 5, end: score + 5, valence: Math.round(rnd() * 100),
      bpm: 90 + Math.round(rnd() * 60), key: Math.floor(rnd() * 24), fp: [rnd(), rnd(), rnd()],
    };
  });
}

test("curve interpolation and tempo cost", () => {
  assert.equal(curveAt([[0, 0], [1, 100]], 0.25), 25);
  assert.equal(curveAt([[0, 10], [0.5, 90], [1, 10]], 0.5), 90);
  assert.equal(tempoCost({ bpm: 128 }, { bpm: 128 }), 0);
  assert.equal(tempoCost({ bpm: 128 }, { bpm: 64 }), 0);      // half time
  assert.ok(tempoCost({ bpm: 120 }, { bpm: 140 }) === 1);
  const p = transitionParts({ score: 50, end: 50, key: 0 }, { score: 50, start: 50, key: 21 });
  assert.equal(p.seam, 0);
  assert.ok(p.key < 0.2); // relative minor
});

test("generated set follows the target curve", () => {
  const items = pool(40);
  for (const preset of CURVE_PRESETS) {
    const res = generateSet(items, { points: preset.points });
    assert.equal(res.steps.length, 40);
    // best possible fit using every track: sorted scores against sorted targets
    const targets = res.steps.map((st) => st.target).sort((a, b) => a - b);
    const scores = items.map((t) => t.score).sort((a, b) => a - b);
    const best = Math.sqrt(targets.reduce((a, t, i) => a + (t - scores[i]) ** 2, 0) / targets.length);
    assert.ok(res.stats.curveError <= best + 5, `${preset.key}: error ${res.stats.curveError} vs best ${best.toFixed(1)}`);
  }
  // rising curve: first quarter calmer than last quarter
  const up = generateSet(items, { points: [[0, 10], [1, 95]] }).steps;
  const avg = (a) => a.reduce((x, s) => x + s.score, 0) / a.length;
  assert.ok(avg(up.slice(0, 10)) + 40 < avg(up.slice(-10)));
});

test("duration target, first / last, locked tracks, artists", () => {
  const items = pool(60, 9);
  const res = generateSet(items, { points: CURVE_PRESETS[0].points, duration: 3600, first: "t5", last: "t9", locked: ["t20"], noSameArtist: true });
  assert.equal(res.steps[0].id, "t5");
  assert.equal(res.steps.at(-1).id, "t9");
  assert.ok(res.steps.some((s) => s.id === "t20"));
  assert.ok(Math.abs(res.stats.duration - 3600) < 420, `duration ${res.stats.duration}`);
  const same = res.steps.filter((s, i) => i && s.artist === res.steps[i - 1].artist).length;
  assert.ok(same <= 1, `same artist twice: ${same}`);
  assert.equal(new Set(res.steps.map((s) => s.id)).size, res.steps.length);
});

test("split by intensity and mood", () => {
  const items = pool(20);
  const parts = splitTracks(items, "stage", 4);
  assert.equal(parts.length, 4);
  assert.equal(parts.reduce((a, p) => a + p.ids.length, 0), 20);
  assert.ok(parts[0].range[1] <= parts[3].range[0]);
  const byMood = splitTracks(items, "mood", 2);
  assert.ok(byMood[0].range[1] <= byMood[1].range[0]);
});
