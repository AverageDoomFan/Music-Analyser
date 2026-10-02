import test from "node:test";
import assert from "node:assert/strict";
import { tracks, SR } from "./synth.mjs";
import { extractFeatures } from "../src/audio/features.js";
import { DEFAULT_WEIGHTS } from "../src/config.js";
import {
  Follower, heardCoverage, isDraftCoverage, followOutcome, playbackEvent, addChunk, DRAFT_THRESHOLD,
} from "../src/live/follow.js";
import { isCounted, isDraft } from "../src/core/track.js";

const scoring = () => ({ weights: DEFAULT_WEIGHTS, aggregation: "topMean" });

function concat(parts) {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

test("heard coverage: overlaps counted once, seeks add separate parts, clipped to the track", () => {
  assert.equal(heardCoverage([], 200), 0);
  assert.equal(heardCoverage([{ pos: 0, len: 50 }], 0), 0);
  // listened 0-30, seeked to 100, listened to 130: 60 s of 200
  assert.equal(heardCoverage([{ pos: 0, len: 30 }, { pos: 100, len: 30 }], 200), 0.3);
  // seek back into a part already heard: counted once
  assert.equal(heardCoverage([{ pos: 0, len: 30 }, { pos: 100, len: 30 }, { pos: 10, len: 30 }], 200), 0.35);
  // whole track, twice (repeat): 100 %
  assert.equal(heardCoverage([{ pos: 0, len: 200 }, { pos: 0, len: 200 }], 200), 1);
  // a part running past the end is clipped
  assert.equal(heardCoverage([{ pos: 190, len: 30 }], 200), 0.05);
});

test("draft threshold: below 60 % heard is a draft", () => {
  assert.equal(DRAFT_THRESHOLD, 0.6);
  assert.equal(isDraftCoverage(0.59), true);
  assert.equal(isDraftCoverage(0.6), false);
  assert.equal(isDraftCoverage(1), false);
  assert.equal(isDraftCoverage(NaN), true);
  assert.equal(followOutcome(0.4), "draft");
  assert.equal(followOutcome(0.75), "record");
  // a draft never replaces a normal record; a more complete listen does
  const scanned = { draft: false, source: { mode: "adaptive", coverage: 0.35 } };
  assert.equal(followOutcome(0.5, scanned), "keep");
  assert.equal(followOutcome(0.8, scanned), "record");
  assert.equal(followOutcome(0.8, { draft: false, source: { mode: "full", coverage: 1 } }), "keep");
  // a draft is replaced by a longer listen, kept over a shorter one
  const draft = { draft: true, source: { mode: "follow", coverage: 0.3 } };
  assert.equal(followOutcome(0.45, draft), "draft");
  assert.equal(followOutcome(0.2, draft), "keep");
  assert.equal(followOutcome(0.7, draft), "record");
  // drafts are out of stats until validated
  assert.equal(isCounted({ finalScore: 50, draft: true }), false);
  assert.equal(isCounted({ finalScore: 50, draft: false }), true);
  assert.equal(isCounted({ finalScore: null }), false);
  assert.equal(isDraft({ draft: true }), true);
});

test("playback polls: change, pause, seek, continue", () => {
  const st = (itemId, isPlaying, s) => ({ itemId, isPlaying, progressMs: s * 1000 });
  assert.equal(playbackEvent("a", null, 10), "idle");
  assert.equal(playbackEvent(null, st("a", true, 0), null), "change");
  assert.equal(playbackEvent("a", st("b", true, 0), 10), "change");
  assert.equal(playbackEvent("a", st("a", false, 10), 10), "pause");
  assert.equal(playbackEvent("a", st("a", true, 10), null), "start");
  assert.equal(playbackEvent("a", st("a", true, 11), 10), "continue");
  assert.equal(playbackEvent("a", st("a", true, 60), 10), "seek");
  assert.equal(playbackEvent("a", st("a", true, 2), 10), "seek");
});

test("chunks: the part of a new chunk already heard is cut away", () => {
  const sr = 10;
  const mk = (trackTime, secs) => ({ trackTime, data: Float32Array.from({ length: secs * sr }, (_, i) => trackTime + i / sr) });
  let chunks = addChunk([], mk(10, 10), sr); // 10-20
  chunks = addChunk(chunks, mk(40, 10), sr); // 40-50
  chunks = addChunk(chunks, mk(15, 30), sr); // 15-45 → only 20-40 is new
  assert.deepEqual(chunks.map((c) => [c.trackTime, c.data.length / sr]), [[10, 10], [20, 20], [40, 10]]);
  // samples keep their track time
  assert.equal(chunks[1].data[0], 20);
  // fully inside what was heard: nothing added; too short pieces dropped
  assert.equal(addChunk(chunks, mk(12, 5), sr).length, 3);
  assert.equal(addChunk(chunks, mk(19, 1.5), sr).length, 3);
});

/** Fake Spotify played by "the user" + capture, polled every second of audio. */
function rig(follower, library, ahead = 0) {
  const p = { id: null, pos: 0, playing: false };
  const state = () => (p.id ? { itemId: p.id, isPlaying: p.playing, progressMs: (p.pos / SR + (p.playing ? ahead : 0)) * 1000, track: library[p.id].track } : null);
  let sincePoll = 0;
  const B = 2048;
  const run = (seconds) => {
    const n = Math.round(seconds * SR);
    for (let done = 0; done < n; done += B) {
      const block = new Float32Array(B);
      if (p.id && p.playing) {
        const a = library[p.id].audio;
        for (let i = 0; i < B; i++) block[i] = p.pos < a.length ? a[p.pos++] : 0;
        if (p.pos >= a.length) { p.id = null; p.playing = false; } // end of the track, nothing queued
      }
      follower.feed(block);
      sincePoll += B;
      if (sincePoll >= SR) { sincePoll = 0; follower.poll(state()); }
    }
  };
  return { p, run };
}

test("follow mode: seeks and pauses map the audio onto track time; < 60 % heard is a draft", async () => {
  const a = concat([tracks.ambient(), tracks.ambient(), tracks.hardstyle(), tracks.hardstyle(), tracks.ambient(), tracks.ambient()]); // 96 s
  const b = concat([tracks.hardstyle(), tracks.hardstyle(), tracks.hardstyle(), tracks.hardstyle()]); // 64 s
  const mkTrack = (id, audio) => ({ id, uri: `spotify:track:${id}`, name: id, artists: ["X"], durationMs: (audio.length / SR) * 1000 });
  const library = { A: { audio: a, track: mkTrack("A", a) }, B: { audio: b, track: mkTrack("B", b) } };
  const saved = [];
  const analysed = [];
  const follower = new Follower({
    player: { state: async () => null },
    analyze: async (mono, sr, extra) => { analysed.push({ mono: mono.slice(), segments: extra.segments }); return extractFeatures(mono, sr, extra); },
    analyzeLive: async () => { throw new Error("skip live windows in this test"); },
    save: async (track, features, info) => { saved.push({ track, features, info }); return null; },
    scoring,
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { p, run } = rig(follower, library);
    // A: 0 → 30 s, seek to 60 s, listen 15 s, seek back to 10 s (already heard), then B
    Object.assign(p, { id: "A", pos: 0, playing: true });
    run(30);
    p.pos = 60 * SR;
    run(15);
    p.pos = 10 * SR;
    run(8);
    // B: from the start, paused 5 s in the middle, to the end
    Object.assign(p, { id: "B", pos: 0, playing: true });
    run(20);
    p.playing = false;
    run(5);
    p.playing = true;
    run(50);
    follower.endTake(0);
    await follower.saving;
  } finally {
    console.warn = warn;
  }

  assert.equal(saved.length, 2);
  const [sa, sb] = saved;
  assert.equal(sa.track.id, "A");
  assert.equal(sa.info.mode, "follow");
  assert.equal(sa.info.draft, true);
  // ~30 s + ~15 s of 96 s (up to a second lost at each cut)
  assert.ok(sa.info.coverage > 0.4 && sa.info.coverage < 0.48, `A coverage ${sa.info.coverage}`);
  assert.equal(sa.info.excerpts.length, 2);
  assert.ok(sa.info.excerpts[0][0] <= 1.1); // the first poll comes after a second
  assert.ok(sa.info.excerpts[1][0] >= 60 && sa.info.excerpts[1][0] < 62, `second part at ${sa.info.excerpts[1][0]}`);
  // the recorded samples are the track's samples at their track time
  for (const seg of analysed[0].segments) {
    const at = Math.round(seg.trackTime * SR);
    for (const k of [0, 1234, seg.end - seg.start - 1]) assert.equal(analysed[0].mono[seg.start + k], a[at + k]);
  }

  assert.equal(sb.track.id, "B");
  assert.equal(sb.info.draft, false);
  assert.ok(sb.info.coverage > 0.9, `B coverage ${sb.info.coverage}`);
  // the pause does not split the track time: parts stay aligned
  for (const seg of analysed[1].segments) {
    const at = Math.round(seg.trackTime * SR);
    for (const k of [0, 777, seg.end - seg.start - 1]) assert.equal(analysed[1].mono[seg.start + k], b[at + k]);
  }
  const q = follower.status.queue;
  assert.deepEqual(q.map((x) => [x.track.id, x.state, !!x.draft]), [["A", "done", true], ["B", "done", false]]);
  assert.equal(follower.status.counts.draft, 1);
});

test("follow mode: too short a listen is not kept, skip drops the track", async () => {
  const a = concat([tracks.ambient(), tracks.ambient()]);
  const mkTrack = (id) => ({ id, uri: `spotify:track:${id}`, name: id, artists: [], durationMs: (a.length / SR) * 1000 });
  const library = { A: { audio: a, track: mkTrack("A") }, C: { audio: a, track: mkTrack("C") } };
  const saved = [];
  const follower = new Follower({
    player: { state: async () => null },
    analyze: async (mono, sr, extra) => extractFeatures(mono, sr, extra),
    save: async (track, features, info) => { saved.push(info); },
    scoring,
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { p, run } = rig(follower, library);
    Object.assign(p, { id: "A", pos: 0, playing: true });
    run(8); // < 15 s
    Object.assign(p, { id: "C", pos: 0, playing: true });
    run(20);
    follower.skip();
    run(5); // C keeps playing: still skipped
    follower.endTake(0);
    await follower.saving;
  } finally {
    console.warn = warn;
  }
  assert.equal(saved.length, 0);
  // the live windows (gauge, curves) ran on the followed audio
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(follower.status.current.live.windowCount >= 3, `windows ${follower.status.current.live.windowCount}`);
  assert.deepEqual(follower.status.queue.map((x) => [x.track.id, x.state]), [["A", "skipped"], ["C", "skipped"]]);
});

test("follow mode: Spotify's position running ahead of the sound does not shift the captured audio", async () => {
  const b = concat([tracks.hardstyle(), tracks.hardstyle(), tracks.ambient(), tracks.hardstyle()]);
  const track = { id: "B", uri: "spotify:track:B", name: "B", artists: [], durationMs: (b.length / SR) * 1000 };
  const analysed = [];
  const follower = new Follower({
    player: { state: async () => null },
    analyze: async (mono, sr, extra) => { analysed.push({ mono: mono.slice(), segments: extra.segments }); return extractFeatures(mono, sr, extra); },
    analyzeLive: async () => { throw new Error("skip live windows in this test"); },
    save: async () => null,
    audioLag: () => 0.35,
    scoring,
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { p, run } = rig(follower, { B: { audio: b, track } }, 0.35);
    Object.assign(p, { id: "B", pos: 0, playing: true });
    run(20);
    p.pos = 40 * SR; // a seek
    run(20);
    follower.endTake(0);
    await follower.saving;
  } finally {
    console.warn = warn;
  }
  const segs = analysed[0].segments;
  assert.equal(segs.length, 2); // 0.35 s ahead is not taken for a seek
  for (const seg of segs) {
    const at = Math.round(seg.trackTime * SR);
    for (const k of [0, 999, seg.end - seg.start - 1]) assert.equal(analysed[0].mono[seg.start + k], b[at + k]);
  }
});
