import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanListens, splitByHour, heatmapBins, monthlySummary, listenMonths, listeningTotals, recentByDay,
  monthKey, dayKey, weekday, stageIndex, weightedIntensity, previousMonth,
} from "../src/stats/listening.js";
import { libraryProfile, profileRecords } from "../src/stats/library.js";
import {
  normalizeName, parseSrc, duelTrack, parseDiagnostic, matchTracks, pearson, duelStats, pairDetails, sideStats,
} from "../src/stats/duel.js";
import { Follower } from "../src/live/follow.js";
import { STAGES } from "../src/config.js";

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const listen = (start, heard, score, extra = {}) => ({ at: start, endedAt: start + heard * 1000, heardSeconds: heard, score, name: extra.name ?? "X - Y", recordId: extra.recordId ?? "spotify:x", ...extra });

// ------------------------------------------------------------------ listening log

test("listening: keys, weekdays, stage index", () => {
  assert.equal(monthKey(at(2026, 9, 7)), "2026-09");
  assert.equal(dayKey(at(2026, 9, 7)), "2026-09-07");
  assert.equal(weekday(new Date(at(2026, 9, 7))), 0); // Monday
  assert.equal(weekday(new Date(at(2026, 9, 13))), 6); // Sunday
  assert.equal(previousMonth("2026-01"), "2025-12");
  assert.equal(stageIndex(0), 0);
  assert.equal(stageIndex(55), STAGES.findIndex((s) => s.min === 50));
  assert.equal(stageIndex(130), STAGES.length - 1);
});

test("listening: clean drops malformed entries and repairs endedAt, sorted by time", () => {
  const list = cleanListens([
    null, { at: "x" }, { at: at(2026, 9, 2), heardSeconds: 0 },
    { at: at(2026, 9, 3), heardSeconds: 60, score: "?" },
    { at: at(2026, 9, 1), heardSeconds: 100, endedAt: at(2026, 8, 1), score: 50 },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].endedAt, at(2026, 9, 1) + 100e3);
  assert.equal(list[1].score, null);
});

test("listening: a listen across an hour boundary is shared between both hours", () => {
  const parts = splitByHour(listen(at(2026, 9, 7, 21, 58), 240, 70));
  assert.equal(parts.length, 2);
  assert.ok(Math.abs(parts[0].seconds - 120) < 1e-6 && Math.abs(parts[1].seconds - 120) < 1e-6);
  // paused in the middle: heard seconds are shared along the whole span
  const paused = splitByHour({ at: at(2026, 9, 7, 21, 50), endedAt: at(2026, 9, 7, 22, 10), heardSeconds: 200, score: 1 });
  assert.equal(paused.reduce((a, p) => a + p.seconds, 0), 200);
  assert.ok(Math.abs(paused[0].seconds - 100) < 1e-6);
});

test("listening: heatmap weights intensity by listening time", () => {
  const h = heatmapBins(cleanListens([
    listen(at(2026, 9, 7, 22, 0), 180, 100), // Monday 22 h
    listen(at(2026, 9, 7, 22, 10), 60, 20),
    listen(at(2026, 9, 12, 9, 0), 120, null), // Saturday 9 h, no score
  ]));
  const mon22 = h.cells[0][22];
  assert.equal(mon22.seconds, 240);
  assert.equal(mon22.count, 2);
  assert.equal(mon22.avg, 80);
  assert.equal(h.cells[5][9].seconds, 120);
  assert.equal(h.cells[5][9].avg, null);
  assert.equal(h.max, 240);
  assert.equal(h.byHour[22], 240);
  assert.equal(h.byDay[0], 240);
  assert.equal(h.cells[3][3].seconds, 0);
});

test("listening: monthly summary (Wrapped)", () => {
  const all = cleanListens([
    listen(at(2026, 8, 30, 20), 600, 40, { recordId: "a", name: "A - calm" }), // previous month
    listen(at(2026, 9, 2, 22), 200, 60, { recordId: "b", name: "B - mid", genre: "Rock" }),
    listen(at(2026, 9, 2, 22, 5), 200, 60, { recordId: "b", name: "B - mid", genre: "Rock" }),
    listen(at(2026, 9, 3, 8), 300, 110, { recordId: "c", name: "C - hard", genre: "Electronic" }),
    listen(at(2026, 9, 3, 8, 6), 60, 20, { recordId: "d", name: "D - soft", genre: "Rock" }),
  ]);
  assert.deepEqual(listenMonths(all), ["2026-09", "2026-08"]);
  const s = monthlySummary(all, "2026-09");
  assert.equal(s.listens, 4);
  assert.equal(s.uniqueTracks, 3);
  assert.equal(s.activeDays, 2);
  assert.ok(Math.abs(s.minutes - 760 / 60) < 1e-9);
  assert.ok(Math.abs(s.avg - (400 * 60 + 300 * 110 + 60 * 20) / 760) < 1e-9);
  assert.equal(s.hardest.name, "C - hard");
  assert.equal(s.hardestDay.day, "2026-09-03");
  assert.equal(s.peakHour.hour, 22);
  assert.equal(s.topTracks[0].recordId, "b");
  assert.equal(s.topTracks[0].plays, 2);
  assert.deepEqual(s.genres.map((g) => g.genre), ["Rock", "Electronic"]);
  assert.ok(Math.abs(s.over100 - 300 / 760) < 1e-9);
  assert.equal(s.stages.reduce((a, b) => a + b, 0), 760);
  assert.equal(s.days.length, 30);
  assert.equal(s.days[1].day, "2026-09-02");
  assert.ok(Math.abs(s.previous.minutes - 10) < 1e-9);
  assert.equal(s.previous.avg, 40);
  // empty month
  const e = monthlySummary(all, "2026-07");
  assert.equal(e.listens, 0);
  assert.equal(e.avg, null);
  assert.equal(e.hardest, null);
  assert.equal(e.peakHour, null);
});

test("listening: totals, streak and recent listens by day", () => {
  const all = cleanListens([
    listen(at(2026, 9, 1), 60, 50), listen(at(2026, 9, 2), 60, 50), listen(at(2026, 9, 3), 60, 50),
    listen(at(2026, 9, 10), 120, 80, { recordId: "z" }),
  ]);
  const tot = listeningTotals(all);
  assert.equal(tot.streak, 3);
  assert.equal(tot.activeDays, 4);
  assert.equal(tot.uniqueTracks, 2);
  assert.equal(tot.minutes, 5);
  assert.equal(weightedIntensity(all), (180 * 50 + 120 * 80) / 300);
  const groups = recentByDay(all, 3);
  assert.deepEqual(groups.map((g) => g.day), ["2026-09-10", "2026-09-03", "2026-09-02"]);
});

test("follow mode reports each listen long enough to the listening log", async () => {
  const SR = 8000;
  const tone = (s) => Float32Array.from({ length: s * SR }, (_, i) => 0.3 * Math.sin(i * 0.2) * (i % 400 < 40 ? 1 : 0.3));
  const audio = tone(40);
  const mk = (id) => ({ id, uri: `spotify:track:${id}`, name: id, artists: ["X"], durationMs: 40000 });
  const listens = [];
  const follower = new Follower({
    player: { state: async () => null },
    sampleRate: SR,
    analyze: async () => ({ sourceLoudnessLufs: -10, duration: 40 }),
    analyzeLive: async () => { throw new Error("no live windows"); },
    save: async () => ({ finalScore: 77 }),
    scoring: () => ({ weights: { energy: 1 }, aggregation: "topMean" }),
    onListen: (l) => listens.push(l),
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const p = { id: "A", pos: 0, playing: true };
    const lib = { A: mk("A"), B: mk("B") };
    const state = () => ({ itemId: p.id, isPlaying: p.playing, progressMs: (p.pos / SR) * 1000, track: lib[p.id] });
    const run = (seconds) => {
      for (let s = 0; s < seconds; s++) {
        follower.feed(audio.subarray(p.pos, p.pos + SR));
        p.pos += SR;
        follower.poll(state());
      }
    };
    follower.poll(state());
    run(30); // A: 30 s heard
    Object.assign(p, { id: "B", pos: 0 });
    follower.poll(state());
    run(5); // B: too short
    follower.endTake(0);
    await follower.saving;
  } finally {
    console.warn = warn;
  }
  assert.equal(listens.length, 1);
  const l = listens[0];
  assert.equal(l.track.id, "A");
  assert.ok(l.heardSeconds >= 27 && l.heardSeconds <= 30, `heard ${l.heardSeconds}`);
  assert.ok(l.coverage > 0.6 && l.coverage <= 0.75);
  assert.equal(l.score, 77);
  assert.equal(l.draft, false);
  assert.ok(l.endedAt >= l.at);
});

// ------------------------------------------------------------------ library profile

test("library profile: counted records only, stages, BPM, modes, genres, sub-scores, top / bottom", () => {
  const rec = (id, score, extra = {}) => ({
    id, name: id, finalScore: score, source: { kind: "local" },
    auto: { subscores: { energy: score, tempo: 50 }, music: { tempo: { bpm: extra.bpm ?? 128 }, key: extra.key ?? { index: 0, name: "C" } } },
    ...extra,
  });
  const records = [
    rec("a", 12), rec("b", 55, { bpm: 90, key: { index: 21, name: "Am" } }), rec("c", 105, { bpm: 300 }),
    rec("draft", 90, { draft: true }), rec("test", 99, { source: { kind: "test" } }), { id: "pending", finalScore: null },
  ];
  assert.equal(profileRecords(records).length, 3);
  const p = libraryProfile(records, { genreOf: (r) => (r.id === "c" ? "Electronic" : "Rock") });
  assert.equal(p.count, 3);
  assert.ok(Math.abs(p.avg - (12 + 55 + 105) / 3) < 1e-9);
  assert.equal(p.median, 55);
  assert.ok(Math.abs(p.over100 - 1 / 3) < 1e-9);
  assert.equal(p.stages.reduce((a, b) => a + b, 0), 3);
  assert.equal(p.stages.at(-1), 1);
  assert.equal(p.bpmKnown, 3);
  assert.equal(p.bpm.at(-1), 1); // ≥ 250
  assert.deepEqual(p.modes, { major: 2, minor: 1 });
  assert.deepEqual(p.genres, [{ genre: "Rock", n: 2 }, { genre: "Electronic", n: 1 }]);
  assert.equal(p.subscores.tempo, 50);
  assert.equal(p.top[0].id, "c");
  assert.equal(p.bottom[0].id, "a");
});

// ------------------------------------------------------------------ duel

test("duel: name normalisation for matching", () => {
  assert.equal(normalizeName("Daft Punk - One More Time"), "daft punk - one more time");
  assert.equal(normalizeName("Beyoncé, JAY-Z - Crazy In Love (feat. Jay-Z) - 2011 Remaster"), "beyonce - crazy in love");
  assert.equal(normalizeName("03 - Daft Punk - One More Time.mp3"), "daft punk - one more time");
  assert.equal(normalizeName("Artist feat. Other - Title"), normalizeName("Artist - Title"));
  // a remix stays a different track
  assert.notEqual(normalizeName("A - Song (Remix)"), normalizeName("A - Song"));
});

test("duel: src parsing and diagnostic validation", () => {
  assert.deepEqual(parseSrc("spotify:follow:62"), { kind: "spotify", mode: "follow", coverage: 0.62 });
  assert.deepEqual(parseSrc("local"), { kind: "local", mode: null, coverage: 1 });
  assert.equal(duelTrack({ n: "x" }), null);
  assert.throws(() => parseDiagnostic("{not json"));
  assert.throws(() => parseDiagnostic({ app: "music-energy-analyzer", tracks: [] }));
  const p = parseDiagnostic(JSON.stringify({
    app: "mea-diagnostic", algorithm: "2.3.1", tracks: [
      { n: "A - B", s: 50, a: 48, src: "local", sub: { energy: 40 }, f: { bpm: 120 } },
      { n: "Demo · x", s: 90, src: "test:full:100" },
      { n: "C - D", s: 70, src: "spotify:follow:40", sid: "id1", d: 1 },
    ],
  }));
  assert.equal(p.algorithm, "2.3.1");
  assert.equal(p.tracks.length, 1);
  assert.equal(p.tracks[0].auto, 48);
});

test("duel: matching by Spotify id first, then by name; one-sided tracks", () => {
  const T = (n, s, sid = null) => duelTrack({ n, s, sid, src: sid ? "spotify:full:100" : "local" });
  const A = [T("X - One", 50, "s1"), T("Y - Two", 60), T("Z - Three", 70, "s3"), T("Only - Mine", 10)];
  const B = [T("X - One (Radio Edit)", 55, "s1"), T("Y - Two", 58, "s2"), T("Z - Three", 90, "s9"), T("Only - Theirs", 20)];
  const m = matchTracks(A, B);
  assert.equal(m.pairs.length, 3);
  assert.deepEqual(m.pairs.map((p) => p.by), ["spotify", "name", "name"]);
  assert.deepEqual(m.onlyA.map((x) => x.name), ["Only - Mine"]);
  assert.deepEqual(m.onlyB.map((x) => x.name), ["Only - Theirs"]);
});

test("duel: correlation, gaps, who listens harder, details of a pair", () => {
  assert.equal(pearson([1, 2], [1, 2]), null);
  assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3], [3, 2, 1]) + 1) < 1e-12);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);

  const T = (n, s, extra = {}) => duelTrack({ n, s, a: extra.a ?? s, src: extra.src ?? "local", sub: extra.sub ?? {}, f: extra.f ?? {}, u: extra.u });
  const A = { algorithm: "2.3.1", tracks: [T("a - 1", 20), T("a - 2", 50, { sub: { energy: 40, harshness: 30 }, f: { plr: 12, bpm: 140 } }), T("a - 3", 80), T("a - 4", 30)] };
  const B = { algorithm: "2.3.1", tracks: [T("a - 1", 24), T("a - 2", 70, { a: 52, u: { m: 70 }, src: "spotify:follow:45", sub: { energy: 42, harshness: 55 }, f: { plr: 7, bpm: 141 } }), T("a - 3", 82), T("b - 9", 120), T("b - 8", 110)] };
  const d = duelStats(A, B);
  assert.equal(d.n, 3);
  assert.equal(d.common[0].name, "a - 2"); // biggest gap first
  assert.equal(d.common[0].gap, 20);
  assert.ok(Math.abs(d.meanAbsGap - (4 + 20 + 2) / 3) < 1e-9);
  assert.ok(d.r > 0.9);
  assert.equal(d.onlyA.length, 1);
  assert.equal(d.onlyB[0].name, "b - 9");
  assert.equal(d.harder, "b");
  assert.equal(d.sides.b.over100, 2 / 5);
  assert.equal(d.agreement, "close");
  assert.equal(d.sameAlgorithm, true);
  assert.deepEqual(sideStats([]), { count: 0, avg: null, median: null, over100: 0 });

  const det = pairDetails(d.common[0].pair);
  assert.equal(det.gap, 20);
  assert.equal(det.autoGap, 2);
  const harsh = det.subs.find((s) => s.key === "harshness");
  assert.equal(harsh.diff, 25);
  assert.ok(harsh.big);
  assert.ok(!det.subs.find((s) => s.key === "energy").big);
  const plr = det.features.find((f) => f.key === "plr");
  assert.equal(plr.diff, -5);
  assert.ok(plr.big);
  assert.ok(!det.features.find((f) => f.key === "bpm").big);
  assert.deepEqual(det.causes, ["manual", "partial", "source", "adjusted"]);
  assert.ok(pairDetails(d.common[0].pair, { sameAlgorithm: false }).causes.includes("algorithm"));
});
