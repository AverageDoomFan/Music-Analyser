// Scans a list of Spotify tracks by playing them on the user's Spotify app
// (Web API playback control) and analysing the captured output in real time.
// Nothing is recorded to disk: each track's audio lives in memory until its
// final analysis, then only the features are kept.
//
// Dependencies are injected so the whole flow runs in Node tests:
//   player   { play(uri, positionMs), pause(), state() -> {itemId, isPlaying, progressMs} | null }
//   analyze  (mono, sampleRate, extra) -> Promise<features>   (final analysis, worker in the browser)
//   save     (track, features, info) -> Promise<record|void>
//   isDone   (track, options) -> boolean                         (already analysed well enough)
//   previous (track) -> record | null                           (its last capture, for the fast review)
//   scoring  () -> { weights, aggregation }
// Audio arrives through feed(monoBlock) at `sampleRate`.

import { extractFeatures, measureClipping, TIMELINE_KEYS } from "../audio/features.js";
import { scoreFeatures } from "../scoring/index.js";
import { ANALYSIS } from "../config.js";
import { LoudnessMeter } from "./meter.js";
import {
  SCAN_DEFAULTS, fullPlan, fixedPlan, probePlan, focusPlan, focusBudget, estimateTrackSeconds, coveredSeconds, reviewPlan,
} from "./plan.js";
import { t } from "../i18n/index.js";

const SILENCE_RMS = 10 ** (-70 / 20);
const SOUND_RMS = 10 ** (-58 / 20);

class Abort extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** Extra play commands when a track stays silent, and silent tracks in a row before the scan stops. */
const PLAY_RETRIES = 2;
const MAX_SILENT_TRACKS = 3;

export class Scanner {
  constructor({
    player, analyze, save, isDone = () => false, previous = () => null, scoring, onUpdate = () => {}, sampleRate = ANALYSIS.sampleRate,
    clock = () => performance.now(), analyzeLive = (mono, sr, extra) => extractFeatures(mono, sr, extra),
  }) {
    Object.assign(this, { player, analyze, save, isDone, previous, scoring, onUpdate, sampleRate, clock, analyzeLive });
    this.consumer = null;
    this.abortWait = null;
    this.levelDb = -120;
    this.samplesIn = 0;
    this.status = idleStatus();
    this.pendingPause = null;
  }

  // ------------------------------------------------------------------ audio in

  feed(block) {
    this.samplesIn += block.length;
    let sq = 0;
    for (let i = 0; i < block.length; i++) sq += block[i] * block[i];
    this.levelDb = 10 * Math.log10(sq / Math.max(1, block.length) + 1e-12);
    this.lastFeed = this.clock();
    this.consumer?.(block);
  }

  /** Resolves with fn's first non-undefined result, or null after `timeout` seconds of audio. */
  wait(fn, timeout) {
    return new Promise((resolve, reject) => {
      let seen = 0;
      const limit = timeout * this.sampleRate;
      const done = (v, err) => {
        this.consumer = null;
        this.abortWait = null;
        clearTimeout(wall);
        err ? reject(err) : resolve(v);
      };
      // safety net when no audio arrives at all (capture stopped)
      const wall = setTimeout(() => done(null, new Error(t("No more sound from the capture: was the audio sharing interrupted?"))), (timeout + 4) * 1000);
      this.consumer = (block) => {
        const r = fn(block);
        if (r !== undefined) return done(r);
        seen += block.length;
        if (seen >= limit) done(null);
      };
      this.abortWait = (reason) => done(null, new Abort(reason));
    });
  }

  waitSilence(minSeconds = 0.15, timeout = 2.5) {
    let quiet = 0;
    const need = minSeconds * this.sampleRate;
    return this.wait((b) => {
      if (rms(b, 0, b.length) < SILENCE_RMS) quiet += b.length;
      else quiet = 0;
      return quiet >= need ? true : undefined;
    }, timeout);
  }

  /** Waits for sound; resolves with the part of the block from the first loud 10 ms. */
  waitSound(timeout = 6) {
    const step = Math.round(this.sampleRate / 100);
    return this.wait((b) => {
      for (let i = 0; i + step <= b.length; i += step) if (rms(b, i, i + step) > SOUND_RMS) return b.subarray(i);
      return undefined;
    }, timeout);
  }

  // ------------------------------------------------------------------ controls

  pause() {
    if (!this.status.running || this.status.paused) return;
    this.status.paused = true;
    this.pendingPause = new Promise((r) => { this.resumeFn = r; });
    this.abortWait?.("pause");
    this.player.pause().catch(() => {});
    this.emit();
  }

  resume() {
    if (!this.status.paused) return;
    this.status.paused = false;
    this.pendingPause = null;
    this.resumeFn?.();
    this.emit();
  }

  skip() {
    this.skipRequested = true;
    this.abortWait?.("skip");
    if (this.status.paused) this.resume();
  }

  /**
   * Analyses `track` right now (even if it was already analysed): it moves
   * just after the current track, which is interrupted and goes back in the
   * queue right after it. A track missing from the queue is added.
   * @returns {boolean} false when no scan is running or the track is not playable
   */
  jumpTo(track) {
    const s = this.status;
    if (!s.running || !track.uri?.startsWith("spotify:track:") || !track.durationMs) return false;
    let idx = s.queue.findIndex((q) => q.track.id === track.id);
    if (idx >= 0 && s.queue[idx].state === "current") return true;
    if (idx < 0) idx = s.queue.push({ track, state: "pending", score: null, message: "" }) - 1;
    const q = s.queue[idx];
    s.queue.splice(idx, 1);
    const cur = s.queue.findIndex((x) => x.state === "current");
    // between two tracks: right after the last one handled
    const anchor = cur >= 0 ? cur : (s.index ?? -1) - (idx <= (s.index ?? -1) ? 1 : 0);
    Object.assign(q, { state: "pending", message: "", score: null });
    s.queue.splice(anchor + 1, 0, q);
    this.jumpTarget = q;
    if (cur >= 0) {
      this.jumpRequested = true;
      this.skipRequested = true;
      this.abortWait?.("jump");
    }
    if (s.paused) this.resume();
    this.updateEta();
    this.emit();
    return true;
  }

  stop() {
    this.stopRequested = true;
    this.abortWait?.("stop");
    if (this.status.paused) this.resume();
  }

  emit() {
    this.onUpdate(this.status);
  }

  // ------------------------------------------------------------------ scan

  /**
   * @param {object[]} tracks  Spotify tracks { id, uri, name, artists, durationMs, ... }
   * @param {object} options   SCAN_DEFAULTS overrides + { rescan }
   */
  async run(tracks, options = {}) {
    const opts = { ...SCAN_DEFAULTS, ...options };
    this.stopRequested = false;
    const queue = tracks.map((t) => ({ track: t, state: "pending", score: null, message: "" }));
    this.status = { ...idleStatus(), running: true, options: opts, queue, startedAt: Date.now() };
    for (const q of queue) {
      if (!q.track.uri?.startsWith("spotify:track:") || !q.track.durationMs) {
        q.state = "skipped";
        q.message = t("not playable through the API");
      } else if (!opts.rescan && this.isDone(q.track, opts)) {
        q.state = "cached";
      }
    }
    this.updateEta();
    this.emit();
    let silentRun = 0;
    try {
      for (let i = 0; i < queue.length && !this.stopRequested; i++) {
        // a track asked for with jumpTo() comes first
        if (this.jumpTarget) {
          if (this.jumpTarget.state === "pending") i = queue.indexOf(this.jumpTarget);
          this.jumpTarget = null;
        }
        const q = queue[i];
        if (q.state !== "pending") continue;
        this.status.index = i;
        this.skipRequested = false;
        this.jumpRequested = false;
        q.state = "current";
        // a jump interrupts the current track: it goes back just after the requested one
        const requeue = () => {
          q.state = "pending";
          q.message = "";
          queue.splice(queue.indexOf(q), 1);
          queue.splice(queue.indexOf(this.jumpTarget) + 1, 0, q);
        };
        try {
          const res = await this.scanTrack(q.track, opts);
          if (res) {
            silentRun = 0;
            q.state = "done";
            q.score = res.score;
            q.coverage = res.coverage;
          } else if (this.jumpRequested && !this.stopRequested) {
            requeue();
          } else {
            q.state = this.stopRequested ? "pending" : "skipped";
            q.message = this.stopRequested ? "" : t("skipped");
          }
        } catch (err) {
          if (err instanceof Abort && this.jumpRequested && !this.stopRequested) {
            requeue();
          } else if (err instanceof Abort) {
            q.state = err.reason === "stop" ? "pending" : "skipped";
          } else {
            q.state = "error";
            q.message = err.message || String(err);
            // no device / no rights: the next tracks would fail the same way.
            // No sound: often one track Spotify refuses; stop only when it keeps happening.
            silentRun = err.noSound ? silentRun + 1 : 0;
            if (err.fatal || silentRun >= MAX_SILENT_TRACKS) {
              this.status.error = q.message;
              break;
            }
          }
        }
        this.status.current = null;
        this.updateEta();
        this.emit();
      }
    } finally {
      await this.player.pause().catch(() => {});
      this.status.running = false;
      this.status.paused = false;
      this.status.current = null;
      this.status.phase = this.stopRequested ? t("Scan stopped") : t("Scan finished");
      this.emit();
    }
    return this.status;
  }

  updateEta() {
    const s = this.status;
    const opts = { ...s.options, overhead: s.latency.count ? Math.max(0.6, s.latency.sum / s.latency.count + 0.4) : s.options?.overhead };
    const left = s.queue.filter((q) => q.state === "pending" || q.state === "current");
    s.etaSeconds = left.reduce((a, q) => a + estimateTrackSeconds(q.track.durationMs / 1000, opts), 0);
    s.counts = countStates(s.queue);
  }

  async scanTrack(track, opts) {
    const duration = track.durationMs / 1000;
    const cur = {
      track, duration, startedAt: Date.now(),
      plan: [], segments: [], meter: new LoudnessMeter(this.sampleRate), loudness: null,
      live: emptyLive(), probes: [], finalizing: false, position: 0,
    };
    this.status.current = cur;
    const heard = [];

    const listen = async (seg) => {
      const got = await this.recordSegment(track, seg, cur);
      if (got) heard.push(got);
      return got;
    };

    // fast review: only the drops of the previous capture; none known → adaptive scan
    const prev = opts.mode === "review" ? this.previous(track) : null;
    const drops = prev ? reviewPlan(prev, duration, { ...opts, overhead: this.overhead(opts) }) : [];
    const mode = opts.mode === "review" && !drops.length ? "adaptive" : opts.mode;
    if (mode === "review") {
      cur.plan = drops.map((d) => ({ ...d, state: "planned" }));
      // the probes stay the previous ones: the next review finds the same drops
      cur.probes = (prev.source?.probes ?? []).map(([pos, score]) => ({ pos, score }));
      this.emit();
      for (const d of cur.plan) {
        await listen(d);
        if (this.skipRequested) return null;
      }
    } else if (mode === "adaptive") {
      const probes = probePlan(duration, opts);
      cur.plan = probes.map((p) => ({ ...p, state: "planned" }));
      this.emit();
      for (const p of cur.plan) {
        await listen(p);
        if (this.skipRequested) return null;
      }
      // score the probes together (shared loudness normalisation)
      const got = heard.filter((h) => h.kind === "probe");
      const scored = scoreSegments(got, this.sampleRate, duration, this.scoring());
      got.forEach((h, i) => { h.score = scored[i]; });
      cur.probes = got.map((h) => ({ pos: h.trackTime, len: h.data.length / this.sampleRate, score: h.score }));
      const focus = focusPlan(cur.probes, duration, focusBudget(probes, { ...opts, overhead: this.overhead(opts) }), { ...opts, overhead: this.overhead(opts) });
      cur.plan.push(...focus.map((f) => ({ ...f, state: "planned" })));
      this.emit();
      for (const f of cur.plan.filter((s) => s.kind === "focus")) {
        await listen(f);
        if (this.skipRequested) return null;
      }
    } else {
      cur.plan = (opts.mode === "full" ? fullPlan(duration) : fixedPlan(duration, opts)).map((p) => ({ ...p, state: "planned" }));
      this.emit();
      for (let k = 0; k < cur.plan.length; k++) {
        await listen(cur.plan[k]);
        if (this.skipRequested) return null;
      }
    }
    await this.player.pause().catch(() => {});
    if (!heard.length) throw new Error(t("Nothing was captured for this track."));

    // final analysis: same extractor as for files, on the excerpts kept in memory
    cur.finalizing = true;
    this.status.phase = t("Final analysis…");
    this.emit();
    const keep = selectForFinal(heard, this.sampleRate);
    keep.sort((a, b) => a.trackTime - b.trackTime);
    const total = keep.reduce((a, h) => a + h.data.length, 0);
    const mono = new Float32Array(total);
    const segments = [];
    let off = 0;
    for (const h of keep) {
      mono.set(h.data, off);
      segments.push({ start: off, end: off + h.data.length, trackTime: h.trackTime });
      off += h.data.length;
    }
    const clip = measureClipping([mono]);
    const features = await this.analyze(mono, this.sampleRate, { ...clip, segments, duration });
    if (features.sourceLoudnessLufs <= -69) throw new Error(t("Captured audio is silent."));
    const covered = coveredSeconds(keep.map((h) => ({ pos: h.trackTime, len: h.data.length / this.sampleRate })));
    const coverage = Math.min(1, covered / duration);
    const info = {
      mode, coverage, excerpts: keep.map((h) => [round2(h.trackTime), round2(h.data.length / this.sampleRate)]),
      probes: cur.probes.map((p) => [round2(p.pos), round2(p.score)]),
    };
    const record = await this.save(track, features, info);
    const { weights, aggregation } = this.scoring();
    const finalScoring = scoreFeatures(features, weights, aggregation);
    const score = record?.finalScore ?? finalScoring.score;
    // the stage now shows the final curves (same analysis as a file)
    cur.live.scoring = finalScoring;
    cur.final = { score, features, coverage };
    this.emit();
    return { score, coverage, features };
  }

  overhead(opts) {
    const l = this.status.latency;
    return l.count ? Math.max(0.6, l.sum / l.count + 0.4) : opts.overhead;
  }

  /** Plays one excerpt and records it. Returns { kind, trackTime, data } or null (skipped / too short). */
  async recordSegment(track, seg, cur) {
    if (this.pendingPause) await this.pendingPause;
    if (this.skipRequested || this.stopRequested) throw new Abort(this.stopRequested ? "stop" : "skip");
    seg.state = "seeking";
    this.status.phase = seg.kind === "probe" ? t("Probing") : seg.kind === "focus" ? t("Focused listening") : seg.kind === "full" ? t("Listening") : t("Excerpt");
    this.emit();

    // 1. silence (so the start of the excerpt can be found in the audio)
    await this.player.pause().catch(() => {});
    await this.waitSilence();
    // 2. play from the excerpt position, wait for the sound
    const t0 = this.clock();
    const start = async () => {
      try {
        await this.player.play(track.uri, Math.round(seg.pos * 1000));
      } catch (err) {
        err.fatal = [401, 403, 404].includes(err.status);
        throw err;
      }
    };
    await start();
    let first = await this.waitSound(6);
    let trackTime = seg.pos;
    // the Spotify client sometimes drops a load ("can't play this right now"):
    // give it a moment and ask again before giving up on the track
    for (let retry = 0; !first && retry < PLAY_RETRIES; retry++) {
      const st = await this.player.state().catch(() => null);
      if (st?.isPlaying) break;
      await this.wait(() => undefined, 2 * (retry + 1));
      await start();
      first = await this.waitSound(6);
    }
    if (!first) {
      // silent passage (or long intro): align with the player's own position
      const st = await this.player.state().catch(() => null);
      if (!st?.isPlaying) {
        const e = new Error(t("No sound captured: Spotify did not play this track (check that Spotify plays on this PC and that system audio sharing, or the VB-Cable input, is on)."));
        e.noSound = true;
        throw e;
      }
      trackTime = st.progressMs / 1000;
      first = new Float32Array(0);
    }
    const lat = (this.clock() - t0) / 1000;
    if (lat < 5) { this.status.latency.sum += lat; this.status.latency.count++; this.status.latency.last = lat; }
    // the play command worked, but is it our track? (checked while recording)
    const check = this.player.state().then((st) => {
      if (st && st.itemId && track.id && st.itemId !== track.id && !track.id.startsWith("local:")) {
        this.abortWait?.("mismatch");
      }
    }).catch(() => {});

    // 3. record
    const need = Math.round(Math.min(seg.len, cur.duration - trackTime - 0.2) * this.sampleRate);
    const out = { kind: seg.kind, trackTime, data: new Float32Array(Math.max(0, need)), filled: 0 };
    seg.state = "recording";
    seg.recordedFrom = trackTime;
    cur.meter.cut();
    this.emit();
    const winN = Math.round(ANALYSIS.windowSeconds * this.sampleRate);
    const hopN = Math.round(ANALYSIS.windowHopSeconds * this.sampleRate);
    let nextWin = winN;
    let lastEmit = 0;
    const take = (block) => {
      const n = Math.min(block.length, need - out.filled);
      if (n > 0) {
        const part = block.subarray(0, n);
        out.data.set(part, out.filled);
        out.filled += n;
        cur.meter.push(part);
        cur.position = trackTime + out.filled / this.sampleRate;
        seg.filled = out.filled / this.sampleRate;
        while (out.filled >= nextWin) {
          this.liveWindow(cur, out, nextWin - winN, nextWin).catch((err) => console.warn(err));
          nextWin += hopN;
        }
        if (cur.position - lastEmit > 0.25) {
          lastEmit = cur.position;
          const l = cur.meter.read();
          // momentary / short-term restart with each excerpt: keep the last values meanwhile
          cur.loudness = { ...cur.loudness, ...Object.fromEntries(Object.entries(l).filter(([, v]) => v != null)) };
          this.emit();
        }
      }
      return out.filled >= need ? true : undefined;
    };
    let aborted = null;
    try {
      if (first.length) take(first);
      if (out.filled < need) {
        const r = await this.wait(take, seg.len + 8);
        if (r === null) throw new Error(t("Playback stopped before the end of the excerpt."));
      }
    } catch (err) {
      if (!(err instanceof Abort)) throw err;
      aborted = err;
    }
    await check;
    seg.state = "done";

    if (aborted?.reason === "mismatch") {
      const e = new Error(t("Spotify is not playing the requested track (playback changed in Spotify?)."));
      throw e;
    }
    const got = { kind: out.kind, trackTime, data: out.data.subarray(0, out.filled) };
    // short excerpts (probes) get their live window once complete
    if (out.filled >= this.sampleRate * 2 && out.filled < winN) this.liveWindow(cur, out, 0, out.filled).catch((err) => console.warn(err));
    if (aborted?.reason === "pause") {
      // keep what we have, listen to the rest after the pause
      const rest = seg.len - out.filled / this.sampleRate;
      if (rest > 2) cur.plan.splice(cur.plan.indexOf(seg) + 1, 0, { pos: trackTime + out.filled / this.sampleRate, len: rest, kind: seg.kind, state: "planned" });
      seg.len = out.filled / this.sampleRate;
    } else if (aborted) {
      throw aborted;
    }
    this.emit();
    return got.data.length >= this.sampleRate * 1.5 ? got : null;
  }

  /** Live analysis of one window of the excerpt being recorded (provisional). */
  async liveWindow(cur, out, a, b) {
    const live = cur.live;
    const copy = out.data.slice(a, b);
    // mean level of the window (the gauge compares the latest level with it)
    const levelDb = 20 * Math.log10(rms(copy, 0, copy.length) + 1e-9);
    const ref = cur.meter.reference();
    const extra = ref.integrated > -70 && cur.meter.blocks.length > 30
      ? { referenceLoudness: ref, gainDb: Math.max(-30, Math.min(50, ANALYSIS.referenceLufs - ref.integrated)) }
      : {};
    // off the main thread in the browser (the copy is transferred)
    const f = await this.analyzeLive(copy, this.sampleRate, extra);
    if (this.status.current !== cur || cur.final) return; // track finished meanwhile
    const t = out.trackTime + (a + b) / 2 / this.sampleRate;
    const s = f.timeline.series;
    // insert in time order (excerpts are not heard in order in adaptive mode)
    let at = live.times.length;
    while (at > 0 && live.times[at - 1] > t) at--;
    live.times.splice(at, 0, round2(t));
    for (const k of TIMELINE_KEYS) (live.series[k] ??= []).splice(at, 0, s[k]?.[0] ?? 0);
    live.last = f;
    live.lastTime = t;
    const { weights, aggregation } = this.scoring();
    const heardSeconds = cur.plan.reduce((acc, g) => acc + (g.filled ?? 0), 0);
    const feats = {
      ...f, duration: cur.duration, analyzedSeconds: heardSeconds,
      loudnessRange: ref.range, clippingRatio: 0,
      timeline: { windowSeconds: ANALYSIS.windowSeconds, hopSeconds: ANALYSIS.windowHopSeconds, times: live.times, series: live.series },
    };
    const sc = scoreFeatures(feats, weights, aggregation);
    live.scoring = sc;
    const i = sc.curves.times.indexOf(round2(t));
    live.current = {
      time: t,
      intensity: sc.curves.intensity[i],
      subscores: Object.fromEntries(Object.entries(sc.curves.subscores).map(([d, v]) => [d, v[i]])),
      features: f,
      levelDb,
    };
    live.windowCount++;
    this.emit();
  }
}

// ---------------------------------------------------------------------------

function idleStatus() {
  return {
    running: false, paused: false, phase: "", queue: [], index: -1, current: null,
    etaSeconds: 0, counts: {}, error: null, options: SCAN_DEFAULTS,
    latency: { sum: 0, count: 0, last: null },
  };
}

function emptyLive() {
  return { times: [], series: {}, scoring: null, current: null, last: null, windowCount: 0 };
}

function countStates(queue) {
  const c = { pending: 0, current: 0, done: 0, cached: 0, skipped: 0, error: 0 };
  for (const q of queue) c[q.state] = (c[q.state] ?? 0) + 1;
  return c;
}

function rms(b, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += b[i] * b[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Probes overlapping a longer excerpt are dropped (the longer one covers them). */
function selectForFinal(heard, sampleRate) {
  const long = heard.filter((h) => h.kind !== "probe");
  const end = (h) => h.trackTime + h.data.length / sampleRate;
  return heard.filter((h) => h.kind !== "probe" || !long.some((l) => h.trackTime < end(l) && l.trackTime < end(h)));
}

/** Intensity of each excerpt, analysed together so they share one loudness normalisation. */
export function scoreSegments(heard, sampleRate, duration, { weights, aggregation }) {
  if (!heard.length) return [];
  const total = heard.reduce((a, h) => a + h.data.length, 0);
  const mono = new Float32Array(total);
  const segments = [];
  let off = 0;
  for (const h of heard) {
    mono.set(h.data, off);
    segments.push({ start: off, end: off + h.data.length, trackTime: h.trackTime });
    off += h.data.length;
  }
  const f = extractFeatures(mono, sampleRate, { segments, duration });
  const sc = scoreFeatures(f, weights, aggregation);
  // one window per excerpt (excerpts shorter than a window); map back by time
  return heard.map((h) => {
    const end = h.trackTime + h.data.length / sampleRate;
    const idx = sc.curves.times.map((t, i) => [t, i]).filter(([t]) => t >= h.trackTime - 0.01 && t <= end + 0.01).map(([, i]) => i);
    if (!idx.length) return null;
    return idx.reduce((a, i) => a + sc.curves.intensity[i], 0) / idx.length;
  });
}

function round2(x) { return Math.round(x * 100) / 100; }
