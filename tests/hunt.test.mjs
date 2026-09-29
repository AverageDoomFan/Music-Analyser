import { test } from "node:test";
import assert from "node:assert/strict";
import { huntTarget, huntPoints, bestTry } from "../src/games/hunt.js";

test("hunt: targets span 5..110, points and best try", () => {
  assert.equal(huntTarget(() => 0), 5);
  assert.equal(huntTarget(() => 0.999999), 110);
  assert.equal(huntPoints(60, 60), 100);
  assert.equal(huntPoints(60, 55), 80);
  assert.equal(huntPoints(60, 90), 0);
  const tries = [{ score: 40 }, { score: 72 }, { score: 66 }];
  assert.equal(bestTry(60, tries), tries[2]);
  assert.equal(bestTry(60, []), null);
});
