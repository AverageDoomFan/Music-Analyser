import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateKey, shiftDay, hashString, seededRandom, dailyQuery, DAILY_WORDS, MAX_OFFSET, eligible, pickDaily,
  dailyPoints, verdictOf, dailyStreak, bestStreak, scanProgress, shareLine,
} from "../src/games/daily.js";
import { dialValueAt } from "../src/games/dial.js";

test("daily: date keys and day arithmetic", () => {
  assert.equal(dateKey(new Date(2026, 8, 30, 23, 59)), "2026-09-30");
  assert.equal(dateKey(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDay("2024-03-01", -1), "2024-02-29");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDay("2026-03-29", 1), "2026-03-30"); // DST change in Europe
});

test("daily: seeded random is deterministic and spread", () => {
  assert.equal(hashString("2026-09-30"), hashString("2026-09-30"));
  assert.notEqual(hashString("2026-09-30"), hashString("2026-10-01"));
  const a = seededRandom(42), b = seededRandom(42);
  const xs = Array.from({ length: 200 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(mean > 0.4 && mean < 0.6, `mean ${mean}`);
});

test("daily: the query of a day is the same for everyone, and changes with the day", () => {
  const q = dailyQuery("2026-09-30");
  assert.deepEqual(q, dailyQuery("2026-09-30"));
  assert.ok(DAILY_WORDS.includes(q.q));
  assert.ok(q.offset >= 0 && q.offset < MAX_OFFSET);
  const week = new Set(Array.from({ length: 14 }, (_, i) => JSON.stringify(dailyQuery(shiftDay("2026-09-30", i)))));
  assert.ok(week.size >= 12, "days differ");
  assert.notDeepEqual(dailyQuery("2026-09-30", 1), q, "fallback differs");
});

test("daily: the pick ignores result order and unplayable tracks", () => {
  const mk = (id, extra = {}) => ({ id, uri: `spotify:track:${id}`, durationMs: 200_000, isLocal: false, ...extra });
  const results = [mk("c"), mk("a"), mk("b"), mk("z", { durationMs: 30_000 }), mk("y", { isLocal: true }), mk("x", { uri: "spotify:episode:x" })];
  assert.equal(eligible(results[3]), false);
  const p = pickDaily(results, "2026-09-30");
  assert.ok(["a", "b", "c"].includes(p.id));
  assert.equal(pickDaily([...results].reverse(), "2026-09-30").id, p.id);
  assert.equal(pickDaily([results[3]], "2026-09-30"), null);
  assert.equal(pickDaily([], "2026-09-30"), null);
  const days = new Set(Array.from({ length: 20 }, (_, i) => pickDaily(results, shiftDay("2026-09-30", i)).id));
  assert.ok(days.size > 1, "not always the same one");
});

test("daily: points and verdicts", () => {
  assert.equal(dailyPoints(60, 60), 100);
  assert.equal(dailyPoints(60, 55.4), 82);
  assert.equal(dailyPoints(10, 90), 0);
  assert.equal(verdictOf(50, 52), "bullseye");
  assert.equal(verdictOf(50, 45), "spot");
  assert.equal(verdictOf(50, 62), "close");
  assert.equal(verdictOf(50, 80), "far");
});

test("daily: streaks", () => {
  const r = (...days) => Object.fromEntries(days.map((d) => [d, { points: 50 }]));
  assert.equal(dailyStreak({}, "2026-09-30"), 0);
  assert.equal(dailyStreak(r("2026-09-28", "2026-09-29", "2026-09-30"), "2026-09-30"), 3);
  assert.equal(dailyStreak(r("2026-09-28", "2026-09-29"), "2026-09-30"), 2, "alive until midnight");
  assert.equal(dailyStreak(r("2026-09-27", "2026-09-28"), "2026-09-30"), 0, "broken");
  assert.equal(dailyStreak(r("2026-02-28", "2026-03-01"), "2026-03-01"), 2);
  assert.equal(bestStreak(r("2026-09-01", "2026-09-02", "2026-09-03", "2026-09-10", "2026-09-11")), 3);
  assert.equal(bestStreak({}), 0);
});

test("daily: scan progress and share line", () => {
  assert.equal(scanProgress(null), 0);
  assert.equal(scanProgress({ final: { score: 1 } }), 1);
  const cur = { plan: [{ len: 10, state: "done" }, { len: 10, state: "recording", filled: 5 }, { len: 20, state: "planned" }] };
  assert.ok(Math.abs(scanProgress(cur) - (15 / 40) * 0.92) < 1e-9);
  const probes = { plan: [{ kind: "probe", len: 4, state: "done" }, { kind: "probe", len: 4, state: "planned" }] };
  assert.ok(scanProgress(probes) < 0.3);
  const s = shareLine("2026-09-30", { guess: 60, score: 63, points: 88 }, 4);
  assert.match(s, /2026-09-30/);
  assert.match(s, /88 pts/);
  assert.match(s, /🔥4/);
});

test("dial: the point under the pointer maps to a value", () => {
  const w = 200, h = 200, cx = 100, cy = 108, r = 80, max = 125;
  const at = (v) => {
    const a = Math.PI * 0.75 + Math.PI * 1.5 * (v / max);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  for (const v of [0, 20, 62, 100, 125]) assert.equal(dialValueAt(...at(v), w, h, max), v);
  assert.equal(dialValueAt(cx, cy, w, h, max), null);
  assert.equal(dialValueAt(cx - 5, cy + 90, w, h, max), 0, "bottom gap, left: 0");
  assert.equal(dialValueAt(cx + 5, cy + 90, w, h, max), max, "bottom gap, right: max");
});
