import test from "node:test";
import assert from "node:assert/strict";
import { tracks, SR } from "./synth.mjs";
import { extractFeatures, measureClipping } from "../src/audio/features.js";
import { scoreFeatures } from "../src/scoring/index.js";
import { DEFAULT_WEIGHTS } from "../src/config.js";
import { Scanner } from "../src/live/scanner.js";
import { LoudnessMeter } from "../src/live/meter.js";
import { StreamResampler } from "../src/live/resample.js";
import { probePlan, focusPlan, fixedPlan, coveredSeconds, estimateTrackSeconds, reviewPlan } from "../src/live/plan.js";

const scoring = () => ({ weights: DEFAULT_WEIGHTS, aggregation: "topMean" });

// calm, intense, calm (5 synthetic parts)
function song() {
  const parts = [tracks.ambient(), tracks.ambient(), tracks.hardstyle(), tracks.hardstyle(), tracks.ambient()];
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  const bounds = [];
  for (const p of parts) { bounds.push(o / SR); out.set(p, o); o += p.length; }
  return { audio: out, bounds };
}

/** Score of the same audio imported as a file. */
const fileScore = (audio) => scoreFeatures(extractFeatures(audio.slice(), SR, measureClipping([audio])), DEFAULT_WEIGHTS, "topMean").score;

/** Fake Spotify + capture: audio flows (faster than real time) from the fake player. */
function rig(audio, trackId = "abc", ahead = 0) {
  const player = {
    playing: false, pos: 0, delay: 0, calls: [],
    async play(uri, ms) { this.calls.push(["play", ms]); this.playing = true; this.pos = Math.round((ms / 1000) * SR); this.delay = Math.round(0.3 * SR); },
    async pause() { this.calls.push(["pause"]); this.playing = false; },
    async state() { return { itemId: trackId, isPlaying: this.playing, progressMs: (this.pos / SR + (this.playing ? ahead : 0)) * 1000 }; },
  };
  let stop = false;
  const start = (scanner) => {
    const B = 2048;
    const tick = () => {
      if (stop) return;
      const block = new Float32Array(B);
      if (player.playing) {
        for (let i = 0; i < B; i++) {
          if (player.delay > 0) { player.delay--; continue; }
          block[i] = player.pos < audio.length ? audio[player.pos] : 0;
          player.pos++;
        }
      }
      scanner.feed(block);
      setImmediate(tick);
    };
    tick();
  };
  return { player, start, end: () => { stop = true; } };
}

async function scan(audio, options, previous = null, { ahead = 0, onLag = null } = {}) {
  const r = rig(audio, "abc", ahead);
  const saved = [];
  const updates = [];
  const scanner = new Scanner({
    player: r.player,
    analyze: async (mono, sr, extra) => extractFeatures(mono, sr, extra),
    save: async (track, features, info) => { saved.push({ track, features, info }); },
    previous: () => previous,
    onLag,
    scoring,
    onUpdate: (s) => updates.push(s.current?.live?.windowCount ?? 0),
    clock: () => performance.now(),
  });
  r.start(scanner);
  const track = { id: "abc", uri: "spotify:track:abc", name: "Test", artists: ["X"], durationMs: (audio.length / SR) * 1000 };
  const status = await scanner.run([track], options);
  r.end();
  return { status, saved, updates, player: r.player };
}

test("plans: probes never leave gaps longer than maxGap, focus sits on the loudest probe", () => {
  const p = probePlan(240, { maxGap: 20, probeLength: 3 });
  assert.equal(p.length, 12);
  for (let i = 1; i < p.length; i++) assert.ok(p[i].pos - p[i - 1].pos <= 20.01);
  const scored = p.map((x, i) => ({ ...x, score: i === 7 ? 90 : 30 }));
  const f = focusPlan(scored, 240, 30, { focusLength: 18, overhead: 1 });
  assert.equal(f.length, 1);
  assert.ok(f[0].pos <= p[7].pos && f[0].pos + f[0].len >= p[7].pos + 3);
  assert.equal(fixedPlan(20, { count: 4, length: 6 })[0].kind, "full");
  assert.equal(coveredSeconds([{ pos: 0, len: 10 }, { pos: 5, len: 10 }, { pos: 30, len: 2 }]), 17);
  assert.ok(estimateTrackSeconds(240, { mode: "adaptive", budget: 75 }) < 100);
});

test("loudness meter matches the extractor's integrated loudness", () => {
  const x = tracks.hardstyle();
  const m = new LoudnessMeter(SR);
  for (let i = 0; i < x.length; i += 1000) m.push(x.subarray(i, i + 1000));
  const f = extractFeatures(x.slice(), SR);
  assert.ok(Math.abs(m.integrated() - f.sourceLoudnessLufs) < 0.3, `${m.integrated()} vs ${f.sourceLoudnessLufs}`);
});

test("resampler 48 kHz → 44.1 kHz keeps frequency and level", () => {
  const rs = new StreamResampler(48000, 44100);
  const n = 48000;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
  const parts = [];
  for (let i = 0; i < n; i += 777) parts.push(rs.push(x.subarray(i, i + 777)));
  const y = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { y.set(p, o); o += p.length; }
  assert.ok(Math.abs(y.length - 44100) < 40);
  let zc = 0, pk = 0;
  for (let i = 100; i < y.length - 100; i++) {
    if ((y[i] >= 0) !== (y[i - 1] >= 0)) zc++;
    pk = Math.max(pk, Math.abs(y[i]));
  }
  const freq = zc / 2 / ((y.length - 200) / 44100);
  assert.ok(Math.abs(freq - 1000) < 3, `freq ${freq}`);
  assert.ok(Math.abs(pk - 0.5) < 0.01, `peak ${pk}`);
});

test("full scan: live curve grows, final analysis equals the file analysis", async () => {
  const { audio } = song();
  const { status, saved, updates } = await scan(audio, { mode: "full" });
  assert.equal(status.queue[0].state, "done", status.queue[0].message);
  assert.equal(saved.length, 1);
  const f = saved[0].features;
  const total = audio.length / SR;
  assert.ok(Math.abs(f.duration - total) < 0.5, `${f.duration}`);
  assert.ok(f.analyzedSeconds > total - 2, `analysed ${f.analyzedSeconds}`);
  assert.ok(saved[0].info.coverage > 0.97);
  assert.ok(Math.max(...updates) >= 20, "live windows");
  const ref = fileScore(audio);
  assert.ok(Math.abs(status.queue[0].score - ref) < 3, `${status.queue[0].score} vs ${ref}`);
});

test("adaptive scan finds the intense part and scores close to the full analysis", async () => {
  const { audio, bounds } = song();
  const { status, saved } = await scan(audio, { mode: "adaptive", budget: 40, maxGap: 20, probeLength: 3, focusLength: 12 });
  assert.equal(status.queue[0].state, "done", status.queue[0].message);
  const info = saved[0].info;
  const focus = info.excerpts.filter(([t, len]) => len > 5);
  assert.ok(focus.length >= 1);
  const [t, len] = focus[0];
  assert.ok(t + len / 2 > bounds[2] && t + len / 2 < bounds[4], `focus at ${t}`);
  assert.ok(info.coverage < 0.6);
  // timeline times are track times
  const times = saved[0].features.timeline.times;
  assert.ok(times.some((x) => x > bounds[2] && x < bounds[4]));
  const ref = fileScore(audio);
  assert.ok(Math.abs(status.queue[0].score - ref) < 10, `${status.queue[0].score} vs ${ref}`);
});

test("fixed excerpts and skip of already analysed tracks", async () => {
  const { audio } = song();
  const { status, saved, player } = await scan(audio, { mode: "fixed", count: 3, length: 8 });
  assert.equal(status.queue[0].state, "done", status.queue[0].message);
  assert.equal(saved[0].info.excerpts.length, 3);
  assert.equal(player.calls.filter((c) => c[0] === "play").length, 3);
});

test("▶ on a queued track: it is analysed now, the interrupted one right after", async () => {
  const audio = { a: tracks.ambient(), b: tracks.hardstyle(), c: tracks.ambient() };
  const player = {
    item: null, playing: false, pos: 0, delay: 0, played: [],
    async play(uri, ms) { this.item = uri.split(":").pop(); this.played.push(this.item); this.playing = true; this.pos = Math.round((ms / 1000) * SR); this.delay = Math.round(0.3 * SR); },
    async pause() { this.playing = false; },
    async state() { return { itemId: this.item, isPlaying: this.playing, progressMs: (this.pos / SR + (this.playing ? ahead : 0)) * 1000 }; },
  };
  const saved = [];
  let jumped = false;
  const list = ["a", "b", "c"].map((id) => ({ id, uri: `spotify:track:${id}`, name: id, artists: ["X"], durationMs: (audio[id].length / SR) * 1000 }));
  const scanner = new Scanner({
    player,
    analyze: async (mono, sr, extra) => extractFeatures(mono, sr, extra),
    save: async (track) => { saved.push(track.id); },
    scoring,
    onUpdate: (s) => {
      // as soon as "a" is being listened to, ask for "c"
      if (!jumped && s.current?.track.id === "a" && s.current.plan.some((g) => g.state === "recording")) {
        jumped = true;
        assert.equal(scanner.jumpTo(list[2]), true);
      }
    },
    clock: () => performance.now(),
  });
  let stop = false;
  const tick = () => {
    if (stop) return;
    const block = new Float32Array(2048);
    const x = audio[player.item];
    if (player.playing && x) {
      for (let i = 0; i < block.length; i++) {
        if (player.delay > 0) { player.delay--; continue; }
        block[i] = player.pos < x.length ? x[player.pos] : 0;
        player.pos++;
      }
    }
    scanner.feed(block);
    setImmediate(tick);
  };
  tick();
  const status = await scanner.run(list, { mode: "fixed", count: 1, length: 6 });
  stop = true;
  assert.ok(jumped);
  assert.deepEqual(saved, ["c", "a", "b"]);
  assert.deepEqual(status.queue.map((q) => q.track.id), ["c", "a", "b"]);
  assert.ok(status.queue.every((q) => q.state === "done"));
  assert.equal(scanner.jumpTo(list[0]), false, "no scan running");
});

/** Scanner on a fake player where `refuse(id, n)` says whether the n-th play of track id is dropped. */
async function scanRefusing(list, audio, refuse) {
  const player = {
    item: null, playing: false, pos: 0, delay: 0, plays: {},
    async play(uri, ms) {
      const id = uri.split(":").pop();
      this.plays[id] = (this.plays[id] ?? 0) + 1;
      this.item = id;
      this.playing = !refuse(id, this.plays[id]);
      this.pos = Math.round((ms / 1000) * SR);
      this.delay = Math.round(0.3 * SR);
    },
    async pause() { this.playing = false; },
    async state() { return { itemId: this.item, isPlaying: this.playing, progressMs: (this.pos / SR + (this.playing ? ahead : 0)) * 1000 }; },
  };
  const scanner = new Scanner({ player, analyze: async (m, sr, x) => extractFeatures(m, sr, x), save: async () => {}, scoring, clock: () => performance.now() });
  let stop = false;
  const tick = () => {
    if (stop) return;
    const block = new Float32Array(2048);
    const x = audio[player.item];
    if (player.playing && x) {
      for (let i = 0; i < block.length; i++) {
        if (player.delay > 0) { player.delay--; continue; }
        block[i] = player.pos < x.length ? x[player.pos] : 0;
        player.pos++;
      }
    }
    scanner.feed(block);
    setImmediate(tick);
  };
  tick();
  const tracksList = list.map((id) => ({ id, uri: `spotify:track:${id}`, name: id, artists: ["X"], durationMs: (audio[id].length / SR) * 1000 }));
  const status = await scanner.run(tracksList, { mode: "fixed", count: 1, length: 4 });
  stop = true;
  return { status, player };
}

test("a dropped play command is sent again instead of stopping the scan", async () => {
  const audio = { a: tracks.hardstyle() };
  const { status, player } = await scanRefusing(["a"], audio, (id, n) => n === 1);
  assert.equal(status.queue[0].state, "done", status.queue[0].message);
  assert.equal(player.plays.a, 2);
  assert.equal(status.error ?? null, null);
});

test("a track Spotify never plays is an error, the scan goes on; three in a row stop it", async () => {
  const audio = { a: tracks.ambient(), b: tracks.hardstyle(), c: tracks.ambient(), d: tracks.ambient(), e: tracks.hardstyle() };
  const one = await scanRefusing(["a", "b"], audio, (id) => id === "a");
  assert.deepEqual(one.status.queue.map((q) => q.state), ["error", "done"]);
  assert.equal(one.player.plays.a, 3);
  const many = await scanRefusing(["a", "c", "d", "e"], audio, (id) => id !== "e");
  assert.deepEqual(many.status.queue.map((q) => q.state), ["error", "error", "error", "pending"]);
  assert.ok(many.status.error);
});

test("fast review plan: the previous scan's drops, from its probes or else its curve", () => {
  const probes = [[10, 30], [50, 82], [90, 40], [130, 80]];
  const plan = reviewPlan({ source: { probes } }, 180);
  const same = focusPlan(probes.map(([pos, score]) => ({ pos, len: 3, score })), 180, 75 - probePlan(180).length * 4.2);
  assert.deepEqual(plan, same);
  assert.ok(plan.length >= 1 && plan.every((d) => d.kind === "focus"));
  assert.equal(plan[0].pos, 45); // 5 s before the best probe
  // no probes (whole-track or follow capture): the intensity curve's peaks
  const times = Array.from({ length: 59 }, (_, i) => 3 + i * 3);
  const curve = { auto: { curves: { times, intensity: times.map((x) => (x > 100 && x < 130 ? 90 : 20)) } }, source: { probes: [] } };
  const fromCurve = reviewPlan(curve, 180);
  assert.ok(fromCurve.length >= 1);
  assert.ok(fromCurve[0].pos >= 90 && fromCurve[0].pos < 130, `drop at ${fromCurve[0].pos}`);
  assert.deepEqual(reviewPlan(null, 180), []);
  assert.deepEqual(reviewPlan({ source: {} }, 180), []);
});

test("fast review: listens only to the known drops; a track never scanned gets the adaptive scan", async () => {
  const { audio, bounds } = song();
  const opts = { budget: 40, maxGap: 20, probeLength: 3, focusLength: 12 };
  const first = await scan(audio, { ...opts, mode: "review" });
  assert.equal(first.saved[0].info.mode, "adaptive");
  const probes = first.saved[0].info.probes;
  assert.ok(probes.length >= 4);
  const prev = { source: { probes } };
  const { status, saved, player } = await scan(audio, { ...opts, mode: "review" }, prev);
  assert.equal(status.queue[0].state, "done", status.queue[0].message);
  const info = saved[0].info;
  assert.equal(info.mode, "review");
  assert.deepEqual(info.probes, probes);
  const plays = player.calls.filter((c) => c[0] === "play").length;
  assert.ok(plays >= 1 && plays < probes.length, `${plays} plays`);
  assert.ok(info.excerpts.every(([t, len]) => len > 5), "no probe listened to");
  const [t, len] = info.excerpts[0];
  assert.ok(t + len / 2 > bounds[2] && t + len / 2 < bounds[4], `drop at ${t}`);
  const ref = fileScore(audio);
  assert.ok(Math.abs(status.queue[0].score - ref) < 12, `${status.queue[0].score} vs ${ref}`);
});

test("Spotify sound delay: each excerpt measures how far progressMs runs ahead of the sound", async () => {
  const { audio } = song();
  for (const ahead of [0, 0.35]) {
    const lags = [];
    const { status } = await scan(audio, { mode: "fixed", count: 3, length: 6 }, null, { ahead, onLag: (x) => lags.push(x) });
    assert.ok(lags.length >= 2, `measures: ${lags.length}`);
    for (const x of lags) assert.ok(Math.abs(x - ahead) < 0.12, `ahead ${ahead}: measured ${x}`);
    assert.ok(Math.abs(status.latency.lag - ahead) < 0.12);
  }
});
