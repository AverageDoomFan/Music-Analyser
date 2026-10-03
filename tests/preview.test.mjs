import { test } from "node:test";
import assert from "node:assert/strict";
import { previewWindow, PREVIEW_SECONDS } from "../src/playlist/preview.js";

const curve = (intensity, hop = 3) => ({ times: intensity.map((_, i) => 3 + i * hop), intensity });

test("drop preview: 8 s from just before the biggest drop", () => {
  // calm, drop at ~30 s to 70, calm, bigger drop at ~75 s to 90
  const intensity = [20, 20, 20, 20, 20, 20, 20, 20, 70, 70, 70, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 90, 90, 90, 40, 40, 40];
  const r = { duration: 95, auto: { curves: curve(intensity) } };
  const w = previewWindow(r);
  assert.equal(w.drop, true);
  assert.equal(w.len, PREVIEW_SECONDS);
  assert.ok(w.start > 65 && w.start < 76, `start ${w.start}`);
});

test("drop preview: no drop → the most intense passage; no curve → 40 %; never past the end", () => {
  const flat = [50, 52, 55, 60, 58, 54, 50];
  const w = previewWindow({ duration: 30, auto: { curves: curve(flat) } });
  assert.equal(w.drop, false);
  assert.equal(w.start, 12 - 4); // window centred on t = 12 s
  assert.deepEqual(previewWindow({ duration: 100 }), { start: 40, len: 8, drop: null });
  assert.deepEqual(previewWindow({ duration: 5 }), { start: 0, len: 5, drop: null });
  // a drop right at the end: the excerpt is pulled back to fit
  const late = [20, 20, 20, 20, 20, 20, 20, 20, 20, 85];
  const e = previewWindow({ duration: 31, auto: { curves: curve(late) } });
  assert.equal(e.start + e.len, 30.5);
});
