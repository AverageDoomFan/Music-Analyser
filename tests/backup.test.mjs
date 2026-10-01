import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExport, parseExport, mergeDuels, mergeReports } from "../src/storage/backup.js";
import { DEFAULT_WEIGHTS } from "../src/config.js";

const recs = [{ id: "x", name: "Track X" }, { id: "y", name: "Track Y" }];
const duel = (at, winner = "a") => ({ a: "x", b: "y", winner, at, source: "game", scores: [40, 55], algorithm: "2.4.1" });
const report = (id, at, comment = "") => ({ id, at, name: id, comment, expected: 30, features: { bpm: 120 } });

test("duels and reports travel in the database export", () => {
  const text = JSON.stringify(buildExport(recs, { weights: DEFAULT_WEIGHTS }, { duels: [duel(1), duel(2, "tie")], reports: [report("x", "2026-10-01T10:00:00Z")] }));
  const back = parseExport(text);
  assert.equal(back.duels.length, 2);
  assert.equal(back.duels[0].aName, "Track X");
  assert.deepEqual(back.duels[0].scores, [40, 55]);
  assert.equal(back.reports.length, 1);
  assert.equal(back.reports[0].features.bpm, 120);
});

test("older exports without duels or reports still import", () => {
  const old = JSON.stringify({ app: "music-energy-analyzer", schemaVersion: 1, tracks: recs });
  const back = parseExport(old);
  assert.deepEqual([back.duels, back.reports], [[], []]);
});

test("invalid duels are dropped on import", () => {
  const text = JSON.stringify({ ...buildExport(recs, {}), duels: [duel(1), { a: "x", b: "y", winner: "maybe" }, { a: 3 }] });
  assert.equal(parseExport(text).duels.length, 1);
});

test("merging duels keeps every answer once", () => {
  const merged = mergeDuels([duel(1), duel(3)], [duel(1), duel(2, "b")]);
  assert.deepEqual(merged.map((d) => d.at), [1, 2, 3]);
});

test("merging reports keeps the latest report per track", () => {
  const merged = mergeReports([report("x", "2026-09-01T00:00:00Z", "old"), report("y", "2026-09-02T00:00:00Z")], [report("x", "2026-09-30T00:00:00Z", "new")]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.id === "x").comment, "new");
});
