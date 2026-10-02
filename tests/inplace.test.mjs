import { test } from "node:test";
import assert from "node:assert/strict";
import { planMoves, applyMoves, progressionOrder } from "../src/playlist/inplace.js";
import { algoTrend } from "../src/core/track.js";
import { ALGORITHM_VERSION } from "../src/config.js";

function shuffled(n, seed) {
  const a = [...Array(n).keys()];
  let s = seed;
  for (let i = n - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test("in-place moves reach the target order, whatever the start", () => {
  for (const n of [0, 1, 2, 7, 50, 300]) {
    for (const seed of [1, 2, 3]) {
      const order = shuffled(n, seed);
      const list = [...Array(n).keys()].map((i) => `t${i}`);
      const moves = planMoves(order);
      assert.deepEqual(applyMoves(list, moves), order.map((i) => list[i]));
      assert.ok(moves.length <= Math.max(0, n - 1));
      for (const m of moves) assert.ok(m.before < m.start && m.length >= 1);
    }
  }
});

test("an ordered playlist needs no move; blocks move in one call", () => {
  assert.deepEqual(planMoves([0, 1, 2, 3]), []);
  // the last three already in sequence: one move of a block of 3
  assert.deepEqual(planMoves([3, 4, 5, 0, 1, 2]), [{ start: 3, before: 0, length: 3 }]);
});

test("progression order: analysed tracks sorted, duplicates side by side, the rest at the end", () => {
  const tracks = [{ id: "a" }, { id: "x" }, { id: "b" }, { id: "a" }, { id: "y" }, { id: "c" }];
  const recs = { a: { id: "ra" }, b: { id: "rb" }, c: { id: "rc" } };
  const scores = { ra: 50, rb: 20, rc: 80 };
  const res = progressionOrder(tracks, (id) => recs[id] ?? null,
    (ids) => ids.filter((id) => id !== "rc").sort((p, q) => scores[p] - scores[q])); // rc not orderable
  assert.deepEqual(res.order, [2, 0, 3, 1, 4, 5]);
  assert.equal(res.sorted, 3);
  assert.equal(res.rest, 3);
});

test("score trend: against the last score of an older algorithm only", () => {
  const r = {
    finalScore: 64,
    history: [
      { score: 40, algorithmVersion: "2.3" },
      { score: 55, algorithmVersion: "2.3.1" },
      { score: 60, algorithmVersion: ALGORITHM_VERSION },
      { score: 64, algorithmVersion: ALGORITHM_VERSION },
    ],
  };
  assert.deepEqual(algoTrend(r), { delta: 9, from: "2.3.1", before: 55 });
  assert.equal(algoTrend({ finalScore: 50, history: [{ score: 50, algorithmVersion: ALGORITHM_VERSION }] }), null);
  assert.equal(algoTrend({ finalScore: null, history: [{ score: 50, algorithmVersion: "1.0" }] }), null);
});
