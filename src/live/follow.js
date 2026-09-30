// "Follow" mode of the Live tab: the user plays music on Spotify by
// themselves, the app never touches playback. It polls the playback state,
// maps the captured sound onto track time with progressMs (seeks, pauses and
// track changes cut the recording into chunks, like the scanner's excerpts),
// and analyses what was heard when the track changes or the user stops.
//
// A track heard for at least DRAFT_THRESHOLD of its duration becomes a normal
// library record; below that it is saved as a draft the user can validate or
// delete.
//
// Dependencies are injected (as for the Scanner) so the flow runs in Node:
//   player  { state() -> { itemId, isPlaying, progressMs, track } | null }
//   analyze (mono, sampleRate, extra) -> Promise<features>
//   save    (track, features, info) -> Promise<record|void>   info.draft = true for a draft
//   decide  (track, coverage) -> "record" | "draft" | "keep"  (defaults to followOutcome without an existing record)

import { Scanner } from "./scanner.js";
import { coveredSeconds } from "./plan.js";
import { LoudnessMeter } from "./meter.js";
import { measureClipping } from "../audio/features.js";
import { scoreFeatures } from "../scoring/index.js";
import { ANALYSIS } from "../config.js";
import { t } from "../i18n/index.js";

/** Share of the track to hear for a normal record (below: a draft). */
export const DRAFT_THRESHOLD = 0.6;

export const FOLLOW_DEFAULTS = Object.freeze({
  pollMs: 1000,        // playback state polling interval
  seekTolerance: 2.5,  // s: position jump between the audio clock and Spotify seen as a seek
  minSeconds: 15,      // s: below this, nothing is kept (too little to analyse)
  minChunk: 1,         // s: shorter chunks are dropped
});

// ------------------------------------------------------------------ pure helpers

/**
 * Share of the track heard, from chunks { pos, len } in seconds (overlaps,
 * e.g. after seeking back, are counted once). 0..1.
 */
export function heardCoverage(chunks, duration) {
  if (!(duration > 0)) return 0;
  const clipped = chunks
    .map((c) => ({ pos: Math.max(0, c.pos), len: Math.min(c.pos + c.len, duration) - Math.max(0, c.pos) }))
    .filter((c) => c.len > 0);
  return Math.min(1, coveredSeconds(clipped) / duration);
}

/** True when a capture with this coverage must be saved as a draft. */
export const isDraftCoverage = (coverage) => !(coverage >= DRAFT_THRESHOLD);

/**
 * What to do with a finished listen, given the record the track already has
 * (captured with the current extractor), if any:
 *   "record" save as a normal record, "draft" save as a draft, "keep" keep the existing record.
 * A draft never replaces a normal record; a normal record replaces a less complete capture.
 */
export function followOutcome(coverage, existing = null) {
  const full = !isDraftCoverage(coverage);
  if (!existing) return full ? "record" : "draft";
  const prev = existing.source?.coverage ?? (existing.source?.mode === "full" ? 1 : 0);
  if (existing.draft) return full ? "record" : coverage >= prev ? "draft" : "keep";
  return full && coverage > prev ? "record" : "keep";
}

/**
 * Reading of one playback poll:
 *   "idle"     nothing is playing (or not a track)
 *   "change"   another track than the one being followed
 *   "pause"    the followed track is paused
 *   "start"    it plays and nothing is being recorded yet
 *   "seek"     it plays, but not where the audio clock says it should be
 *   "continue" it plays where expected
 * @param {string|null} followedId  id of the track being followed
 * @param {number|null} expected    track time (s) the recorded audio has reached, null when not recording
 */
export function playbackEvent(followedId, st, expected, tolerance = FOLLOW_DEFAULTS.seekTolerance) {
  if (!st?.itemId) return "idle";
  if (st.itemId !== followedId) return "change";
  if (!st.isPlaying) return "pause";
  if (expected == null) return "start";
  return Math.abs(st.progressMs / 1000 - expected) > tolerance ? "seek" : "continue";
}

/**
 * Adds a chunk { trackTime, data } to non-overlapping chunks: the parts of the
 * new chunk already heard are cut away (the first listen is kept). Returns a
 * new array sorted by track time.
 */
export function addChunk(chunks, chunk, sampleRate, minSeconds = FOLLOW_DEFAULTS.minChunk) {
  const a = chunk.trackTime;
  const b = a + chunk.data.length / sampleRate;
  const sorted = [...chunks].sort((x, y) => x.trackTime - y.trackTime);
  const free = [];
  let cursor = a;
  for (const c of sorted) {
    const cs = c.trackTime, ce = c.trackTime + c.data.length / sampleRate;
    if (ce <= cursor || cs >= b) continue;
    if (cs > cursor) free.push([cursor, cs]);
    cursor = Math.max(cursor, ce);
  }
  if (cursor < b) free.push([cursor, b]);
  const pieces = free
    .map(([x, y]) => {
      const i0 = Math.round((x - a) * sampleRate), i1 = Math.min(chunk.data.length, Math.round((y - a) * sampleRate));
      return { trackTime: a + i0 / sampleRate, data: chunk.data.subarray(i0, i1) };
    })
    .filter((p) => p.data.length >= minSeconds * sampleRate);
  return [...sorted, ...pieces].sort((x, y) => x.trackTime - y.trackTime);
}

// ------------------------------------------------------------------ follower

export class Follower extends Scanner {
  constructor({ decide, follow = {}, ...opts }) {
    super({ save: async () => null, ...opts });
    this.cfg = { ...FOLLOW_DEFAULTS, ...follow };
    this.decide = decide ?? ((track, coverage) => followOutcome(coverage));
    this.take = null;
    this.skipId = null;
    this.sinceLastPoll = 0;
    this.saving = Promise.resolve();
    this.status = followStatus();
    this.consumer = (block) => this.onAudio(block);
  }

  // ------------------------------------------------------------------ controls

  /** Pauses the listening (Spotify is not touched). */
  pause() {
    if (!this.status.running || this.status.paused) return;
    this.closeSegment(0);
    this.status.paused = true;
    this.status.phase = t("Listening paused");
    this.pendingPause = new Promise((r) => { this.resumeFn = r; });
    this.emit();
  }

  resume() {
    super.resume();
    this.wake?.();
  }

  /** Drops the current track (nothing saved) and waits for the next one. */
  skip() {
    const take = this.take;
    if (take) {
      this.take = null;
      this.skipId = take.track.id;
      take.q.state = "skipped";
      take.q.message = t("skipped");
      this.status.phase = t("Skipped: waiting for the next track");
      this.updateCounts();
      this.emit();
    }
    if (this.status.paused) this.resume();
  }

  stop() {
    super.stop();
    this.wake?.();
  }

  /** Follow mode never controls playback. */
  jumpTo() { return false; }

  // ------------------------------------------------------------------ run

  async run() {
    this.stopRequested = false;
    this.status = { ...followStatus(), running: true, phase: t("Waiting for Spotify to play…"), startedAt: Date.now() };
    this.emit();
    let failures = 0;
    try {
      while (!this.stopRequested) {
        if (this.pendingPause) await this.pendingPause;
        if (this.stopRequested) break;
        let st = null;
        try {
          st = await this.player.state();
          failures = 0;
        } catch (err) {
          if ([401, 403].includes(err.status) || ++failures >= 10) throw err;
        }
        if (this.stopRequested) break;
        if (!this.status.paused) this.poll(st);
        await new Promise((r) => {
          this.wake = r;
          setTimeout(r, this.cfg.pollMs);
        });
        this.wake = null;
      }
    } catch (err) {
      this.status.error = err.message || String(err);
    } finally {
      this.endTake(0);
      await this.saving;
      this.status.running = false;
      this.status.paused = false;
      this.status.phase = t("Follow mode stopped");
      this.emit();
    }
    return this.status;
  }

  /** Handles one playback state (called by run(); synchronous, for tests too). */
  poll(st) {
    const take = this.take;
    const open = take?.open;
    const expected = open ? open.trackTime + open.filled / this.sampleRate : null;
    // the audio received since the previous poll may belong to what came after
    // a seek / pause / track change: it is dropped when the recording is cut
    const uncertain = this.sinceLastPoll;
    this.sinceLastPoll = 0;
    if (this.skipId && st?.itemId !== this.skipId) this.skipId = null;
    const ev = this.skipId && st?.itemId === this.skipId ? "idle" : playbackEvent(take?.track.id ?? null, st, expected, this.cfg.seekTolerance);
    switch (ev) {
      case "idle":
        this.closeSegment(uncertain);
        if (!this.skipId) this.status.phase = t("Waiting for Spotify to play…");
        break;
      case "change":
        this.endTake(uncertain);
        if (st.track?.durationMs && st.track.id === st.itemId) this.beginTake(st.track, st);
        else this.status.phase = t("Not a track (podcast?): waiting…");
        break;
      case "pause":
        this.closeSegment(uncertain);
        this.status.phase = t("Paused in Spotify");
        break;
      case "seek":
        this.closeSegment(uncertain);
        this.openSegment(st.progressMs / 1000);
        break;
      case "start":
        this.openSegment(st.progressMs / 1000);
        break;
      default:
        break;
    }
    if (ev === "seek" || ev === "start" || ev === "continue") this.status.phase = t("Listening");
    this.emit();
    return ev;
  }

  // ------------------------------------------------------------------ audio

  onAudio(block) {
    this.sinceLastPoll += block.length;
    const take = this.take;
    const o = take?.open;
    if (!o || this.status.paused) return;
    const cur = take.cur;
    const n = Math.min(block.length, o.data.length - o.filled);
    if (n <= 0) return;
    const part = block.subarray(0, n);
    o.data.set(part, o.filled);
    o.filled += n;
    cur.meter.push(part);
    cur.position = o.trackTime + o.filled / this.sampleRate;
    o.seg.filled = o.filled / this.sampleRate;
    o.seg.len = o.seg.filled;
    const winN = Math.round(ANALYSIS.windowSeconds * this.sampleRate);
    const hopN = Math.round(ANALYSIS.windowHopSeconds * this.sampleRate);
    while (o.filled >= o.nextWin) {
      this.liveWindow(cur, o, o.nextWin - winN, o.nextWin).catch((err) => console.warn(err));
      o.nextWin += hopN;
    }
    if (cur.position - o.lastEmit > 0.25 || cur.position < o.lastEmit) {
      o.lastEmit = cur.position;
      const l = cur.meter.read();
      cur.loudness = { ...cur.loudness, ...Object.fromEntries(Object.entries(l).filter(([, v]) => v != null)) };
      this.emit();
    }
  }

  beginTake(track, st) {
    const duration = track.durationMs / 1000;
    const cur = {
      track, duration, startedAt: Date.now(), follow: true,
      plan: [], segments: [], meter: new LoudnessMeter(this.sampleRate), loudness: null,
      live: { times: [], series: {}, scoring: null, current: null, last: null, windowCount: 0 },
      probes: [], finalizing: false, position: Math.min(duration, (st.progressMs ?? 0) / 1000),
    };
    const q = { track, state: "current", score: null, message: "" };
    this.status.queue.push(q);
    this.status.index = this.status.queue.length - 1;
    this.status.current = cur;
    this.take = { track, cur, q, chunks: [], open: null };
    this.updateCounts();
    if (st.isPlaying) this.openSegment(st.progressMs / 1000);
    else this.status.phase = t("Paused in Spotify");
  }

  openSegment(pos) {
    const take = this.take;
    if (!take) return;
    const duration = take.cur.duration;
    const from = Math.max(0, Math.min(duration, pos));
    if (duration - from < 0.5) return; // at the very end: the next track is coming
    const seg = { pos: from, len: 0, kind: "full", state: "recording", filled: 0, recordedFrom: from };
    take.cur.plan.push(seg);
    take.cur.meter.cut();
    take.cur.position = from;
    take.open = {
      trackTime: from, filled: 0, seg, lastEmit: 0,
      nextWin: Math.round(ANALYSIS.windowSeconds * this.sampleRate),
      data: new Float32Array(Math.ceil((duration - from + 2) * this.sampleRate)),
    };
  }

  /** Ends the chunk being recorded, without its last `drop` samples. */
  closeSegment(drop) {
    const take = this.take;
    const o = take?.open;
    if (!o) return;
    take.open = null;
    const keep = Math.max(0, o.filled - drop);
    o.seg.state = "done";
    o.seg.filled = o.seg.len = keep / this.sampleRate;
    if (keep < this.cfg.minChunk * this.sampleRate) {
      take.cur.plan.splice(take.cur.plan.indexOf(o.seg), 1);
      return;
    }
    // a copy: the buffer was sized for the rest of the track
    take.chunks = addChunk(take.chunks, { trackTime: o.trackTime, data: o.data.slice(0, keep) }, this.sampleRate, this.cfg.minChunk);
  }

  /** Stops following the current track and queues its analysis. */
  endTake(drop) {
    this.closeSegment(drop);
    const take = this.take;
    if (!take) return;
    this.take = null;
    this.saving = this.saving.then(() => this.finalize(take)).catch((err) => console.warn(err));
  }

  async finalize(take) {
    const { track, cur, q, chunks } = take;
    const sr = this.sampleRate;
    const duration = cur.duration;
    const heardSeconds = chunks.reduce((a, c) => a + c.data.length, 0) / sr;
    const coverage = heardCoverage(chunks.map((c) => ({ pos: c.trackTime, len: c.data.length / sr })), duration);
    q.coverage = coverage;
    const pct = Math.round(coverage * 100);
    try {
      if (heardSeconds < this.cfg.minSeconds) {
        q.state = "skipped";
        q.message = t("heard {s} s only: not kept", { s: Math.round(heardSeconds) });
        return;
      }
      const outcome = await this.decide(track, coverage);
      if (outcome === "keep") {
        q.state = "skipped";
        q.message = t("{n} % heard: the previous analysis is kept", { n: pct });
        return;
      }
      q.message = t("Final analysis…");
      cur.finalizing = true;
      this.emit();
      const total = chunks.reduce((a, c) => a + c.data.length, 0);
      const mono = new Float32Array(total);
      const segments = [];
      let off = 0;
      for (const c of chunks) {
        mono.set(c.data, off);
        segments.push({ start: off, end: off + c.data.length, trackTime: c.trackTime });
        off += c.data.length;
      }
      const clip = measureClipping([mono]);
      const features = await this.analyze(mono, sr, { ...clip, segments, duration });
      if (features.sourceLoudnessLufs <= -69) throw new Error(t("Captured audio is silent."));
      const draft = outcome === "draft";
      const info = {
        mode: "follow", coverage, draft, probes: [],
        excerpts: chunks.map((c) => [round2(c.trackTime), round2(c.data.length / sr)]),
      };
      const record = await this.save(track, features, info);
      const { weights, aggregation } = this.scoring();
      const finalScoring = scoreFeatures(features, weights, aggregation);
      const score = record?.finalScore ?? finalScoring.score;
      Object.assign(q, { state: "done", score, draft, message: draft ? t("draft · {n} % heard", { n: pct }) : "" });
      if (this.status.current === cur) {
        cur.live.scoring = finalScoring;
        cur.final = { score, features, coverage };
      }
    } catch (err) {
      q.state = "error";
      q.message = err.message || String(err);
    } finally {
      cur.finalizing = false;
      this.updateCounts();
      this.emit();
    }
  }

  updateCounts() {
    const c = { pending: 0, current: 0, done: 0, cached: 0, skipped: 0, error: 0, draft: 0 };
    for (const q of this.status.queue) {
      c[q.state] = (c[q.state] ?? 0) + 1;
      if (q.draft) c.draft++;
    }
    this.status.counts = c;
  }
}

function followStatus() {
  return {
    running: false, paused: false, phase: "", queue: [], index: -1, current: null, follow: true,
    etaSeconds: 0, counts: {}, error: null, options: { mode: "follow" },
    latency: { sum: 0, count: 0, last: null },
  };
}

function round2(x) { return Math.round(x * 100) / 100; }
