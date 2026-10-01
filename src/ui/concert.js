// Concert mode: a full-screen show for an analysed track, played through the
// library player. The stored analysis drives it at the playback position:
// per-window intensity and sub-scores (the detail curve), band energies,
// attack rates, the folded tempo (a beat clock), the sections and the drops,
// known in advance (the show builds tension before a drop and releases it on
// the beat). A local file plays on the Web Audio engine: its output is tapped
// for the real spectrum, waveform and kicks (no latency, it is the source).
// A Spotify track has no audio in the page: the spectrum and the waveform are
// synthesized from the band energies and the beat clock.
// Kicks and snares come from the hits stored at the analysis (extractor 1.9+),
// exact and with no detection delay, for both kinds; older analyses fall back
// on the kicks heard (local files) or the beat clock (Spotify).
// Sync: the show runs on a smoothed clock (the audio clock moves in steps)
// that follows what is heard (the output latency of a local file; Spotify's
// position, checked against the app, best round trip kept), plus a visual
// delay the user can tune ([ ] or - +), remembered per kind of playback.
// WebGL2 (concert-gl.js), Canvas2D fallback (concert-2d.js, or ?concert2d).

import { stageFor, DIMENSIONS } from "../config.js";
import { t } from "../i18n/index.js";
import { state } from "../app/store.js";
import { engine } from "../audio/engine.js";
import * as api from "../spotify/api.js";
import { player } from "./player.js";
import { DIM_COLORS, intensityRgb } from "./live-draw.js";
import {
  OnsetDetector, FlashLimiter, concertPalette, concertDrive, visualParams, approach, clamp, GAUGE_TOP,
  prepareShow, sampleShow, beatClock, ShowDirector, synthSpectrum, synthWave, hueRotate, sectionHue, clockText,
  laserAmount,
} from "./concert-logic.js";
import { createGLRenderer, DATA_WIDTH, BURST_SLOTS } from "./concert-gl.js";
import { create2DRenderer } from "./concert-2d.js";

const FFT = 2048;
const MAX_DPR = 1.5;
const MAX_PIXELS = 2.2e6; // ~1080p: hiDPI and 4K screens render a little softer, not slower
const IDLE_UI_MS = 2500;
const SEEK_STEP = 5;
const SYNC_EVERY_MS = 4000;
const SYNC_FIRST_MS = [700, 1500, 2500, 4000]; // Spotify: checks soon after a start (it starts late)
const SYNC_KEEP = 6;                           // round trips kept (the fastest one is trusted)
const DELAY_STEP = 20;                         // ms per press
const DELAY_KEY = "mea.concert.delay.";        // + "spotify" / "file": visual delay (ms)
const SCALE_KEY = "mea.concert.scale";
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const reducedMq = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false };
const SECTION_COLORS = { Intro: "#60a5fa", "Build-up": "#fbbf24", Peak: "#ef4444", Break: "#a78bfa", Section: "#94a3b8", Outro: "#34d399" };

let el = null;             // overlay element and its parts
let renderer = null;
let raf = 0;
let open = false;
let S = null;              // the running show: { id, record, show, kind, director, ... }

// audio tap (local files)
let tap = null, detector = null, freq = null, time = null, bandMap = null;

// visual state (reused every frame)
const spectrum = new Float32Array(DATA_WIDTH);
const wave = new Float32Array(DATA_WIDTH);
const synthSpec = new Float32Array(DATA_WIDTH);
const synthWav = new Float32Array(DATA_WIDTH);
const SMP = {};
const CLK = {};
const V = {
  t0: 0, last: 0, time: 0, travel: 0, intensity: 0, shown: null, kick: 0, onset: 0, flash: 0,
  idle: 1, bass: 0, loud: 0, wavePeak: 0.1, scale: 1,
  frameMs: 16.7, cpu: 0, kickAt: -100, kickStrength: 0, bigAt: -100, bigStrength: 0,
  colorAt: 0, cssBase: "", cssAccent: "", slowFor: 0, fastFor: 0, frames: 0, fpsFrom: 0, fps: 0,
  kickSlot: 0, onsetSlot: 0, lastOnsetBurst: 0, lastKickHeard: -100, stageLabel: "", num: "", subs: {},
  hot: false, broken: false, pointerAt: 0, uiHidden: false,
  hue: 0, hueTarget: 0, travelBoost: 0, camZoomKick: 0, rollKick: 0, camPunch: 0,
  camBase: { x: 0, y: 0, zoom: 1.02, roll: 0 }, camTarget: { x: 0, y: 0, zoom: 1.02, roll: 0 },
  cw: 0, ch: 0, stripW: 0, timeText: "", nextText: "", phaseText: "", playingShown: null, bannerAt: 0,
  pump: 0, snap: 0, laser: 0, fast: 0, meterText: "", lastScale: "", syncShownAt: 0,
};
{
  const sc = Number(store.get(SCALE_KEY));
  if (sc >= 0.5 && sc <= 1) V.scale = sc; // where the last show settled on this machine
}
const cam = { x: 0, y: 0, zoom: 1, roll: 0 };
const bursts = Array.from({ length: BURST_SLOTS }, () => ({ x: 0, y: 0, t: -100, s: 0, r: 1, g: 1, b: 1, kind: 0 }));
const limiter = new FlashLimiter({ reduced: reducedMq.matches });
const PAL = { base: [0, 0, 0], accent: [0, 0, 0], shadow: [0, 0, 0], hot: 0, heat: 0 };
const frame = {
  time: 0, travel: 0, heat: 0, hot: 0, kick: 0, bass: 0, loud: 0, idle: 1, tunnel: 0,
  zoom: 1, rot: 0, decay: 0.85, ringR: 0.26, ringH: 0.2, bloom: 1, bloomThreshold: 0.5, ca: 0, exposure: 1.2,
  grain: 0.03, glitch: 0, flash: 0, starBright: 0.3, shake: [0, 0], tension: 0,
  pump: 0, snap: 0, fast: 0, laser: [0, 0, 0, 0],
  palette: PAL, drive: null, spectrum, wave, bursts,
};

export const concertOpen = () => open;

// ------------------------------------------------------------------ overlay

function build() {
  const root = document.createElement("div");
  root.className = "concert";
  root.id = "concert";
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", t("Concert mode"));
  // the essentials inline: the overlay covers the page even if its stylesheet fails to load
  root.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:10000;background:#000;color:#f5f7fb;overflow:hidden;margin:0;";
  const subs = DIMENSIONS.map((d) => `<div class="cc-sub" data-k="${d.key}" style="--c:${DIM_COLORS[d.key]}"><div class="cc-sub-bar"><i></i></div><span>${d.label}</span></div>`).join("");
  const abs = "position:absolute;inset:0;width:100%;height:100%;";
  root.innerHTML = `
    <canvas class="cc-canvas" aria-hidden="true" style="${abs}display:block"></canvas>
    <div class="cc-hud" style="${abs}">
      <div class="cc-top">
        <div class="cc-status"><span class="cc-dot"></span><span class="cc-phase"></span></div>
        <div class="cc-actions">
          <div class="cc-sync" role="group" aria-label="${t("Visual delay")}">
            <button type="button" class="cc-sync-btn" data-cc="sync-" title="${t("Visuals earlier ([ or -)")}" aria-label="${t("Visuals earlier ([ or -)")}">−</button>
            <span class="cc-sync-val" aria-live="polite"></span>
            <button type="button" class="cc-sync-btn" data-cc="sync+" title="${t("Visuals later (] or +)")}" aria-label="${t("Visuals later (] or +)")}">+</button>
          </div>
          <button type="button" class="cc-btn cc-play" data-cc="play"></button>
          <button type="button" class="cc-btn cc-fs" data-cc="fs" title="${t("Full screen (F)")}" aria-label="${t("Full screen (F)")}">⛶</button>
          <button type="button" class="cc-btn cc-close" data-cc="close" title="${t("Close (Esc)")}" aria-label="${t("Close concert mode")}">✕</button>
        </div>
      </div>
      <div class="cc-center">
        <div class="cc-num-wrap"><div class="cc-num" aria-live="off">—</div></div>
        <div class="cc-stage"></div>
        <div class="cc-next"></div>
        <div class="cc-meter" aria-hidden="true"><i class="cc-led"></i><span class="cc-meter-text"></span></div>
      </div>
      <div class="cc-bottom">
        <div class="cc-track">
          <div class="cc-cover" style="width:clamp(56px,11vh,128px);height:clamp(56px,11vh,128px);overflow:hidden;flex:none"><span>♪</span></div>
          <div class="cc-meta">
            <div class="cc-kicker">${t("Now playing")}</div>
            <div class="cc-title"></div>
            <div class="cc-artist"></div>
          </div>
        </div>
        <div class="cc-subs" aria-hidden="true">${subs}</div>
      </div>
      <div class="cc-strip-row">
        <span class="cc-time cc-elapsed">0:00</span>
        <div class="cc-strip" role="slider" tabindex="0" aria-label="${t("Position in the track")}" aria-valuemin="0">
          <canvas class="cc-strip-canvas" aria-hidden="true"></canvas>
          <div class="cc-strip-fill"></div>
          <div class="cc-strip-head"></div>
        </div>
        <span class="cc-time cc-total">0:00</span>
      </div>
    </div>
    <div class="cc-banner" aria-hidden="true"><span></span></div>
    <div class="cc-idle" aria-live="polite">
      <div class="cc-idle-title"></div>
      <p class="cc-idle-text"></p>
    </div>`;
  document.body.appendChild(root);
  const q = (s) => root.querySelector(s);
  el = {
    root, canvas: q(".cc-canvas"), num: q(".cc-num"), numWrap: q(".cc-num-wrap"), stage: q(".cc-stage"), next: q(".cc-next"),
    phase: q(".cc-phase"), play: q(".cc-play"), title: q(".cc-title"), artist: q(".cc-artist"), cover: q(".cc-cover"), track: q(".cc-track"),
    idle: q(".cc-idle"), idleTitle: q(".cc-idle-title"), idleText: q(".cc-idle-text"), banner: q(".cc-banner"), bannerText: q(".cc-banner span"),
    strip: q(".cc-strip"), stripCanvas: q(".cc-strip-canvas"), stripFill: q(".cc-strip-fill"), stripHead: q(".cc-strip-head"),
    elapsed: q(".cc-elapsed"), total: q(".cc-total"),
    syncVal: q(".cc-sync-val"), led: q(".cc-led"), meterText: q(".cc-meter-text"),
    subs: Object.fromEntries([...root.querySelectorAll(".cc-sub")].map((s) => [s.dataset.k, s.querySelector("i")])),
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cc]");
    if (!b) return;
    if (b.dataset.cc === "close") closeConcert();
    else if (b.dataset.cc === "fs") toggleFullscreen();
    else if (b.dataset.cc === "play") togglePlay();
    else if (b.dataset.cc === "sync-") nudgeDelay(-DELAY_STEP);
    else if (b.dataset.cc === "sync+") nudgeDelay(DELAY_STEP);
  });
  el.strip.addEventListener("pointerdown", (e) => {
    const box = el.strip.getBoundingClientRect();
    if (S && box.width > 0) seekTo(clamp((e.clientX - box.left) / box.width) * S.show.duration);
  });
  root.addEventListener("pointermove", wake);
  root.addEventListener("pointerdown", wake);
  document.addEventListener("fullscreenchange", () => {
    // leaving full screen keeps the show open in the window
    root.dataset.fs = document.fullscreenElement === root ? "1" : "0";
    el.root.querySelector(".cc-fs").setAttribute("aria-pressed", String(root.dataset.fs === "1"));
    measureNow();
  });
  new ResizeObserver(() => measureNow()).observe(root);
  new ResizeObserver(() => { V.stripW = el.strip.clientWidth; drawStrip(); }).observe(el.strip);
  reducedMq.addEventListener?.("change", () => limiter.set({ reduced: reducedMq.matches }));
  makeRenderer();
}

/** Overlay size in CSS pixels (read on resize only, never per frame). */
function measureNow() {
  if (!el) return;
  V.cw = el.root.clientWidth || window.innerWidth;
  V.ch = el.root.clientHeight || window.innerHeight;
}

function makeRenderer() {
  renderer = new URLSearchParams(location.search).has("concert2d") ? null : createGLRenderer(el.canvas);
  if (!renderer) {
    // a canvas that tried WebGL cannot give a 2D context: use a fresh one
    const c = document.createElement("canvas");
    c.className = "cc-canvas";
    c.setAttribute("aria-hidden", "true");
    c.style.cssText = el.canvas.style.cssText;
    el.canvas.replaceWith(c);
    el.canvas = c;
    renderer = create2DRenderer(c);
  }
  el.root.dataset.renderer = renderer?.kind ?? "none";
}

function wake() {
  V.pointerAt = performance.now();
  if (V.uiHidden) {
    V.uiHidden = false;
    el.root.classList.remove("ui-idle");
  }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el.root.requestFullscreen({ navigationUI: "hide" });
  } catch { /* not allowed: the overlay still covers the window */ }
}

function onKey(e) {
  if (!open) return;
  const k = e.key;
  let used = true;
  if (k === "Escape") closeConcert();
  else if (k === " " || k === "Spacebar" || k === "k" || k === "K") togglePlay();
  else if (k === "ArrowRight") seekBy(e.shiftKey ? 15 : SEEK_STEP);
  else if (k === "ArrowLeft") seekBy(-(e.shiftKey ? 15 : SEEK_STEP));
  else if (k === "Home") seekTo(0);
  else if (k === "f" || k === "F") toggleFullscreen();
  else if (k === "[" || k === "-" || k === "_") nudgeDelay(-DELAY_STEP);
  else if (k === "]" || k === "+" || k === "=") nudgeDelay(DELAY_STEP);
  else if (k === "Tab") { used = false; wake(); }
  else used = false;
  if (used) {
    e.preventDefault();
    e.stopPropagation();
    wake();
  }
}

/**
 * Opens the show for an analysed track and starts it playing.
 * @param {string} id  record id
 * @param {{from?:number|null, onClose?:() => void}} [opts]  start time (s); called after closing
 */
export function openConcert(id, { from = null, onClose = null } = {}) {
  const record = state.records.get(id);
  const show = prepareShow(record);
  if (!show || !player.canPlay(id)) return false;
  if (open) closeConcert({ silent: true });
  if (!el) build();
  S = {
    id, record, show, kind: player.kind(id), director: new ShowDirector(show), onClose,
    pausedAt: 0, wanted: true, starting: true, seekPos: null, seekTimer: 0, failed: false,
    spCorr: 0, spCorrTarget: 0, syncAt: 0, syncing: false, syncCount: 0, syncs: [], nudge: 0, wasPlaying: false,
    clock: null, delay: 0,
  };
  S.delay = clamp(Number(store.get(DELAY_KEY + S.kind)) || 0, -500, 1000);
  showDelay(false);
  const start = Number.isFinite(from) && from > 0 && from < show.duration - 1 ? from : player.isPlaying(id) ? player.position(id) ?? 0 : 0;
  S.pausedAt = start;
  open = true;
  el.root.hidden = false;
  el.root.dataset.kind = S.kind;
  el.root.classList.remove("broken", "hot");
  el.root.focus({ preventScroll: true });
  document.documentElement.classList.add("concert-on");
  document.dispatchEvent(new CustomEvent("concert-state", { detail: { open: true } }));
  document.addEventListener("keydown", onKey, true);
  measureNow();
  V.last = performance.now();
  if (!V.t0) V.t0 = V.last; // one clock for the page: bursts and the flash limiter keep their times
  V.fpsFrom = V.last;
  V.frames = 0;
  V.shown = null;
  V.num = "";
  V.stageLabel = "";
  V.intensity = show.intensity[0] ?? 0;
  V.timeText = V.nextText = V.phaseText = "";
  V.playingShown = null;
  setTrack(record);
  drawStrip();
  const sec = sampleShow(show, start, SMP);
  V.hue = V.hueTarget = sec.section ? sectionHue(sec.section.label, sec.sectionIndex) : 0;
  if (S.kind === "file") attachTap();
  wake();
  if (el.root.requestFullscreen && !document.fullscreenElement) el.root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  requestAnimationFrame(() => el.root.classList.add("in"));
  raf = requestAnimationFrame(tick);
  startPlayback(start);
  return true;
}

export function closeConcert({ silent = false } = {}) {
  if (!open) return;
  open = false;
  cancelAnimationFrame(raf);
  clearTimeout(S?.seekTimer);
  detachTap();
  document.removeEventListener("keydown", onKey, true);
  el.root.classList.remove("in", "hot", "ui-idle", "broken", "paused", "tense");
  el.root.hidden = true;
  document.documentElement.classList.remove("concert-on");
  document.dispatchEvent(new CustomEvent("concert-state", { detail: { open: false } }));
  if (document.fullscreenElement === el.root) document.exitFullscreen().catch(() => {});
  const cb = S?.onClose;
  S = null;
  if (!silent) cb?.();
}

// ------------------------------------------------------------------ playback

async function startPlayback(at) {
  if (!S) return;
  const s = S;
  s.starting = true;
  s.wanted = true;
  s.director.reset();
  const ok = await player.playAt(s.id, at).catch(() => false);
  if (s !== S) return;
  s.starting = false;
  if (!ok) {
    s.failed = true;
    s.wanted = false;
    s.pausedAt = at;
    return;
  }
  s.failed = false;
  s.spCorr = s.spCorrTarget = 0;
  s.syncs.length = 0;
  s.syncCount = 0;
  s.clock = null;
  s.syncAt = performance.now() + SYNC_FIRST_MS[0]; // Spotify: first check once it has really started
}

function togglePlay() {
  if (!S || S.starting) return;
  if (S.wanted && player.isPlaying(S.id)) {
    S.pausedAt = currentPosition();
    S.wanted = false;
    player.stop();
    S.director.reset();
  } else {
    startPlayback(S.pausedAt >= S.show.duration - 0.5 ? 0 : S.pausedAt);
  }
}

function seekBy(d) {
  if (S) seekTo((S.seekPos ?? currentPosition()) + d);
}

/** Seeks now on screen, the player follows a moment later (repeated keys make one Spotify call). */
function seekTo(pos) {
  if (!S) return;
  pos = clamp(pos, 0, Math.max(0, S.show.duration - 0.5));
  S.seekPos = pos;
  S.director.reset();
  clearTimeout(S.seekTimer);
  const s = S;
  s.seekTimer = setTimeout(async () => {
    if (s !== S) return;
    if (s.wanted) await startPlayback(pos);
    else s.pausedAt = pos;
    if (s === S && s.seekPos === pos) s.seekPos = null;
  }, S.kind === "spotify" ? 250 : 60);
}

/** Playback position (s) as shown: the player's, corrected for Spotify, frozen when paused. */
function currentPosition() {
  if (!S) return 0;
  if (S.seekPos != null) return S.seekPos;
  const playing = player.isPlaying(S.id);
  if (playing) {
    S.wasPlaying = true;
    return Math.max(0, (player.position(S.id) ?? 0) + (S.kind === "spotify" ? S.spCorr : 0));
  }
  if (S.wasPlaying && S.wanted && !S.starting) {
    // it stopped by itself (end of the track, or stopped elsewhere)
    S.wasPlaying = false;
    S.wanted = false;
    const p = player.position(S.id) ?? 0;
    S.pausedAt = p > 0.5 ? p : S.show.duration;
  }
  return S.pausedAt;
}

/** Spotify: the position is extrapolated locally; check it against the app now and then. */
async function syncSpotify() {
  const s = S;
  s.syncing = true;
  try {
    const t0 = performance.now();
    const st = await api.playbackState();
    const rtt = (performance.now() - t0) / 1000;
    if (s !== S || !st) return;
    const uri = s.record.source?.uri ?? "";
    if (st.itemId && !uri.endsWith(st.itemId)) return; // another track: leave it alone
    if (!st.isPlaying) {
      if (s.wanted && player.isPlaying(s.id)) {
        s.pausedAt = st.progressMs / 1000;
        s.wanted = false;
        player.stop();
      }
      return;
    }
    // the position was read somewhere in the round trip: its middle is the best guess,
    // and the fastest round trip of the last few the most precise one
    const real = st.progressMs / 1000 + rtt / 2;
    const local = player.position(s.id) ?? real;
    const err = real - local;
    if (Math.abs(err - s.spCorrTarget) > 1.5) {
      // a jump (a seek in the app, a late start): follow at once, forget the old round trips
      s.syncs.length = 0;
      if (Math.abs(err - s.spCorr) > 3) s.spCorr = err;
    }
    s.syncs.push({ err, rtt });
    if (s.syncs.length > SYNC_KEEP) s.syncs.shift();
    s.spCorrTarget = s.syncs.reduce((a, b) => (b.rtt < a.rtt ? b : a)).err;
  } catch { /* offline, rate limit: keep the local clock */ } finally {
    s.syncing = false;
    s.syncAt = performance.now() + (SYNC_FIRST_MS[++s.syncCount] ?? SYNC_EVERY_MS);
  }
}

/** Visual delay (ms, + = later), remembered per kind of playback. */
function nudgeDelay(ms) {
  if (!S) return;
  S.delay = clamp(Math.round((S.delay + ms) / DELAY_STEP) * DELAY_STEP, -500, 1000);
  store.set(DELAY_KEY + S.kind, String(S.delay));
  showDelay(true);
}

function showDelay(flash) {
  if (!el || !S) return;
  const d = S.delay;
  el.syncVal.textContent = `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)} ms`;
  el.syncVal.title = t("Visual delay");
  if (flash) {
    V.syncShownAt = performance.now();
    el.root.classList.add("sync-shown");
  }
}

/**
 * The time the show draws: what is being heard, on a smooth clock. The audio
 * clock moves in blocks (and Spotify's is corrected now and then): the show
 * clock runs on the frame time and eases onto it, jumping only on a seek.
 */
function showClock(dt, playing) {
  const raw = currentPosition();
  if (!playing) { S.clock = null; return raw; }
  let lat = 0;
  if (S.kind === "file") {
    const c = engine.context;
    lat = (c.outputLatency || 0) + (c.baseLatency || 0);
  }
  const target = raw - lat - S.delay / 1000;
  if (S.clock == null || Math.abs(target - S.clock) > 0.25) S.clock = target;
  else S.clock += dt + (target - S.clock - dt) * Math.min(1, dt * 6);
  return Math.max(0, S.clock);
}

// ------------------------------------------------------------------ audio (local files)

function attachTap() {
  detachTap();
  try {
    const ctx = engine.context;
    tap = ctx.createAnalyser();
    tap.fftSize = FFT;
    tap.smoothingTimeConstant = 0.15;
    tap.minDecibels = -100;
    tap.maxDecibels = -10;
    engine.addTap(tap);
    freq = new Float32Array(tap.frequencyBinCount);
    time = new Float32Array(FFT);
    detector = new OnsetDetector({ sampleRate: ctx.sampleRate, fftSize: FFT });
    bandMap = logBands(ctx.sampleRate);
  } catch (err) {
    console.warn("Concert mode: no audio tap", err);
    tap = null;
  }
}

function detachTap() {
  if (tap) engine.removeTap(tap);
  tap = null;
  detector = null;
}

/** For each display bin, the FFT bin range it covers (log spaced, 30 Hz – 16 kHz). */
function logBands(sr) {
  const hz = sr / FFT, lo = Math.log(30), hi = Math.log(16000);
  const map = new Float32Array(DATA_WIDTH * 3);
  for (let i = 0; i < DATA_WIDTH; i++) {
    const f0 = Math.exp(lo + ((hi - lo) * i) / DATA_WIDTH);
    const f1 = Math.exp(lo + ((hi - lo) * (i + 1)) / DATA_WIDTH);
    map[i * 3] = f0 / hz;
    map[i * 3 + 1] = Math.max(f0 / hz + 1, f1 / hz);
    map[i * 3 + 2] = 4.5 * Math.log2(Math.sqrt(f0 * f1) / 1000); // tilt: highs carry less energy
  }
  return map;
}

function readAudio(dt, now) {
  tap.getFloatFrequencyData(freq);
  tap.getFloatTimeDomainData(time);
  // silent bins are -Infinity: keep every number finite (a NaN would spread through the feedback)
  for (let i = 0; i < freq.length; i++) if (!(freq[i] > -160)) freq[i] = -160;
  const o = detector.push(freq, now / 1000);
  const rel = Math.exp(-dt * 7);
  for (let i = 0; i < DATA_WIDTH; i++) {
    const a = bandMap[i * 3], b = bandMap[i * 3 + 1];
    let m = -200;
    if (b - a < 1.5) {
      const k = Math.floor(a), f = a - k;
      m = freq[k] + (freq[Math.min(freq.length - 1, k + 1)] - freq[k]) * f;
    } else {
      for (let k = Math.floor(a); k < Math.min(freq.length, Math.ceil(b)); k++) if (freq[k] > m) m = freq[k];
    }
    const v = clamp((m + bandMap[i * 3 + 2] + 82) / 62);
    spectrum[i] = v > spectrum[i] ? v : spectrum[i] * rel + v * (1 - rel);
  }
  let peak = 0;
  for (let i = 0; i < FFT; i++) { const a = Math.abs(time[i]); if (a > peak) peak = a; }
  V.wavePeak = Math.max(peak, V.wavePeak * Math.exp(-dt * 1.5), 0.02);
  const gain = Math.min(6, 0.8 / V.wavePeak);
  const step = FFT / DATA_WIDTH;
  for (let i = 0; i < DATA_WIDTH; i++) wave[i] = wave[i] * 0.35 + time[i * step] * gain * 0.65;
  V.bass = approach(V.bass, o.bass, dt, o.bass > V.bass ? 30 : 6);
  V.loud = approach(V.loud, o.loud, dt, o.loud > V.loud ? 20 : 4);
  return o;
}

/** Spotify: spectrum and waveform from the analysis and the beat clock, smoothed like the real ones. */
function synthAudio(dt, smp, clk, playing) {
  const tt = V.time;
  synthSpectrum(synthSpec, smp, clk, tt);
  synthWave(synthWav, smp, clk, tt);
  const on = playing ? 1 : 0;
  const rel = Math.exp(-dt * 7);
  for (let i = 0; i < DATA_WIDTH; i++) {
    const v = synthSpec[i] * on;
    spectrum[i] = v > spectrum[i] ? v : spectrum[i] * rel + v * (1 - rel);
    wave[i] = wave[i] * 0.35 + synthWav[i] * on * 0.65;
  }
  const kick = smp.beatAmt * Math.exp(-clk.phase * 7) * on;
  const bass = clamp((0.35 + 0.65 * Math.max(smp.bands[0], smp.bands[1])) * (0.4 + 0.6 * smp.level) * 0.7 + kick * 0.4) * on;
  const loud = clamp((0.25 + 0.75 * smp.level) * (0.35 + 0.65 * clamp(smp.intensity / 100))) * on;
  V.bass = approach(V.bass, bass, dt, bass > V.bass ? 30 : 6);
  V.loud = approach(V.loud, loud, dt, loud > V.loud ? 20 : 4);
}

// ------------------------------------------------------------------ frame

function tick(now) {
  if (!open || !S) return;
  raf = requestAnimationFrame(tick);
  const dt = Math.min(0.1, Math.max(0.001, (now - V.last) / 1000));
  V.last = now;
  measure(now, dt);
  const reduced = reducedMq.matches;
  V.time = (now - V.t0) / 1000;

  const playing = S.wanted && !S.starting && S.seekPos == null && player.isPlaying(S.id);
  if (S.kind === "spotify") {
    S.spCorr = approach(S.spCorr, S.spCorrTarget, dt, 1.5);
    if (playing && !S.syncing && now > S.syncAt) syncSpotify();
  }
  const pos = showClock(dt, playing);
  const smp = sampleShow(S.show, pos, SMP);
  const clk = beatClock(S.show, pos, S.nudge, CLK);
  S.director.nudge = S.nudge;
  const events = playing ? S.director.advance(pos) : (S.director.reset(), NO_EVENTS);

  // paused: a calmer, dimmer show
  V.idle = approach(V.idle, playing ? 0 : 0.65, dt, playing ? 3 : 1.5);

  // intensity from the analysis (the jump at a drop is already in the sample)
  V.intensity = approach(V.intensity, smp.intensity, dt, 7);
  const I = V.intensity;
  const Iv = Math.min(I, GAUGE_TOP);
  const drive = concertDrive(Iv, smp.subs);
  palette(Iv, dt);
  const heat = drive.heat, hot = drive.hot;

  // audio
  let o = null;
  if (S.kind === "file" && tap && detector) o = readAudio(dt, now);
  else synthAudio(dt, smp, clk, playing);

  // hits: the stored kicks and snares (exact), else kicks heard (local) or on the beat clock
  // (Spotify, or a local track whose kicks the detector misses)
  const stored = !!S.show.kicks;
  const heard = !stored && !!o && playing;
  if (heard && o.kick) {
    kick(o.kickStrength, heat, hot, reduced);
    V.lastKickHeard = V.time;
    // phase-lock the beat clock on the kicks heard (the bar grid only matters for accents)
    if (smp.beatAmt > 0.3) {
      let e = clk.phase > 0.5 ? clk.phase - 1 : clk.phase;
      if (Math.abs(e) < 0.2) S.nudge -= e * 0.08;
    }
  }
  if (!!o && playing && o.onset && V.time - V.lastOnsetBurst > 0.14 && !S.show.snaps) onset(o.strength, heat);
  for (const ev of events) {
    if (ev.type === "kick") {
      kick(ev.amp * (0.55 + 0.45 * smp.beatAmt), heat, hot, reduced);
    } else if (ev.type === "snap") {
      snap(ev.amp, heat);
    } else if (ev.type === "beat") {
      const s = smp.beatAmt * (ev.downbeat ? 1 : 0.72);
      if (!stored && (!heard || V.time - V.lastKickHeard > 2)) { if (s > 0.12) kick(s, heat, hot, reduced); }
      if (ev.downbeat) V.camPunch = Math.max(V.camPunch, smp.beatAmt);
    }
  }
  const dropNow = events.some((e) => e.type === "drop");
  for (const ev of events) {
    if (ev.type === "drop") drop(ev.drop, reduced);
    else if (ev.type === "section") section(ev.section, ev.index, dropNow, reduced);
  }
  // no stored attacks and nothing heard: attacks at the stored rate, as sparks
  if (!S.show.snaps && !o && playing && Math.random() < Math.min(8, smp.onsetRate) * dt * 0.35) onset(0.3 + 0.5 * heat, heat);

  // effects driven by the track's measures: lasers (heat, section, density, tempo),
  // fast attacks (the attack-rate measure: speedcore, blast beats, extratone)
  const on = playing ? 1 : 0;
  V.laser = approach(V.laser, laserAmount(heat, smp) * on, dt, 2.5);
  const rate = Math.max(smp.fastRate, smp.kickRate ?? 0);
  V.fast = approach(V.fast, clamp((rate - 5) / 15) * on, dt, 3);
  V.pump *= Math.exp(-dt * 9);
  V.snap *= Math.exp(-dt * 11);

  V.kick *= Math.exp(-dt * 6);
  V.onset *= Math.exp(-dt * 8);
  V.flash *= Math.exp(-dt * 10);
  V.travelBoost *= Math.exp(-dt * 1.6);
  V.bigStrength *= V.time - V.bigAt > 2.5 ? 0 : 1;

  // motion
  const k = V.kick;
  const tension = reduced ? smp.tension * 0.4 : smp.tension;
  V.travel += dt * (drive.speed * (1 + k * 0.9) + V.travelBoost + tension * 2.2) * (reduced ? 0.5 : 1) * (1 - V.idle * 0.7);
  camera(dt, heat, tension, reduced);
  visualParams(frame, {
    kickAt: V.kickAt, kickStrength: V.kickStrength, time: V.time, dt, travel: V.travel, kick: k, bass: V.bass, loud: V.loud,
    idle: V.idle, flash: V.flash, drive, palette: PAL, reduced, tension: playing ? tension : 0,
    bigAt: V.bigAt, bigStrength: V.bigStrength, cam,
    pump: V.pump, kickRate: stored ? smp.kickRate : smp.bpm / 60, snap: V.snap, snapRate: smp.snapRate || 2, fast: V.fast,
    laser: V.laser, laserCount: 2 + Math.round(5 * drive.density), beats: clk.beats, laserHit: V.kick,
  });

  // size, with an adaptive render scale (keeps 60 fps on smaller GPUs)
  const cw = V.cw || window.innerWidth, ch = V.ch || window.innerHeight;
  let dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  dpr *= Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, cw * ch * dpr * dpr))) * V.scale;
  renderer?.resize(cw * dpr, ch * dpr);
  renderer?.render(frame);

  hud(pos, smp, I, k, dt, playing, tension);
  V.cpu += (performance.now() - now - V.cpu) * 0.05;
  if (V.frames === 0) el.root.dataset.cpu = V.cpu.toFixed(2);
}
const NO_EVENTS = [];

/** Heat-ramp palette, turned by the section's hue (smoothly). */
function palette(I, dt) {
  V.hue = approach(V.hue, V.hueTarget, dt, 1.2);
  const p = concertPalette(I);
  hueRotate(p.base, V.hue, PAL.base);
  hueRotate(p.accent, V.hue * 0.6, PAL.accent);
  hueRotate(p.shadow, V.hue, PAL.shadow);
  PAL.hot = p.hot;
  PAL.heat = p.heat;
}

function kick(strength, heat, hot, reduced) {
  const s = clamp(strength * (0.6 + heat * 0.8));
  V.kick = Math.max(V.kick, s);
  V.kickAt = V.time;
  V.kickStrength = s;
  burst(V.kickSlot, 0, 0, s, PAL.accent, 1);
  V.kickSlot = (V.kickSlot + 1) % 4;
  V.pump = Math.max(V.pump, s);
  V.camPunch = Math.max(V.camPunch, s);
  const want = heat > 0.55 ? strength * (heat - 0.45) * 1.8 + hot * 0.45 : 0;
  const fl = limiter.request(V.time, want * (reduced ? 0.4 : 1));
  if (fl > V.flash) V.flash = fl;
}

/** A snare, a clap (stored attacks that are not kicks): side panels and a spark. */
function snap(amp, heat) {
  V.snap = Math.max(V.snap, amp * (0.5 + 0.5 * heat));
  if (amp > 0.35 && V.time - V.lastOnsetBurst > 0.1) onset(0.25 + 0.6 * amp * (0.4 + 0.6 * heat), heat);
}

function onset(strength, heat) {
  V.lastOnsetBurst = V.time;
  V.onset = Math.max(V.onset, strength);
  const a = Math.random() * Math.PI * 2, r = 0.45 + Math.random() * 0.5;
  const aspect = (V.cw || 16) / Math.max(1, V.ch || 9);
  const c = Math.random() < 0.5 ? PAL.base : PAL.accent;
  burst(4 + V.onsetSlot, Math.cos(a) * r * aspect * 0.8, Math.sin(a) * r, clamp(strength * (0.3 + heat)), c, 0);
  V.onsetSlot = (V.onsetSlot + 1) % 4;
}

/** The drop: everything at once, on the beat it was waited for. */
function drop(d, reduced) {
  V.bigAt = V.time;
  V.bigStrength = clamp(0.75 + d.rise / 80);
  const fl = limiter.request(V.time, reduced ? 0.3 : 0.95);
  if (fl > V.flash) V.flash = fl;
  for (let i = 0; i < BURST_SLOTS; i++) {
    const a = (i / BURST_SLOTS) * Math.PI * 2 + Math.random() * 0.4;
    const r = i < 4 ? 0 : 0.35;
    burst(i, Math.cos(a) * r, Math.sin(a) * r, 1, i % 2 ? PAL.accent : [1, 1, 1], i < 4 ? 1 : 0);
  }
  V.kick = 1;
  V.kickAt = V.time;
  V.kickStrength = 1;
  if (!reduced) {
    V.travelBoost = 3.5;
    V.camZoomKick = 0.16;
    V.rollKick = (Math.random() < 0.5 ? -1 : 1) * 0.05;
  }
  banner(t("Drop"), true);
}

/** A new part of the track: a new camera angle, a new light, a shockwave. */
function section(s, index, withDrop, reduced) {
  V.hueTarget = sectionHue(s.label, index);
  const rnd = () => Math.random() - 0.5;
  V.camTarget = reduced ? { x: 0, y: 0, zoom: 1.02, roll: 0 } : {
    x: rnd() * 0.03, y: rnd() * 0.02,
    zoom: s.label === "Break" || s.label === "Outro" ? 1.1 : s.label === "Peak" ? 1.02 : 1.05,
    roll: rnd() * 0.07,
  };
  if (withDrop) return;
  if (V.time - V.bigAt > 1) { V.bigAt = V.time; V.bigStrength = 0.5; }
  banner(t(s.label), false);
}

function camera(dt, heat, tension, reduced) {
  const T = V.camTarget, B = V.camBase;
  for (const key of ["x", "y", "zoom", "roll"]) B[key] = approach(B[key], T[key], dt, 0.8);
  V.camZoomKick *= Math.exp(-dt * 2.2);
  V.rollKick *= Math.exp(-dt * 1.1);
  V.camPunch *= Math.exp(-dt * 9);
  const drift = reduced ? 0 : 0.004 + 0.008 * heat;
  const tt = V.time;
  cam.x = B.x + Math.sin(tt * 0.13) * drift;
  cam.y = B.y + Math.sin(tt * 0.11 + 1.7) * drift * 0.7;
  cam.roll = reduced ? 0 : clamp(B.roll + V.rollKick + Math.sin(tt * 0.07) * 0.012 * heat + Math.sin(tt * 9) * 0.004 * tension, -0.06, 0.06);
  // tension pushes the camera in; the drop kicks it out
  let z = B.zoom + V.camZoomKick * (reduced ? 0.3 : 1) + (reduced ? 0.008 : 0.03) * V.camPunch + 0.09 * tension;
  const asp = (V.cw || 16) / Math.max(1, V.ch || 9);
  const need = Math.cos(cam.roll) + Math.max(asp, 1 / asp) * Math.abs(Math.sin(cam.roll)) + 2.2 * Math.max(Math.abs(cam.x), Math.abs(cam.y)) + 0.01;
  cam.zoom = Math.max(need, z);
}

function burst(slot, x, y, s, c, kind) {
  const b = bursts[slot];
  b.x = x; b.y = y; b.t = V.time; b.s = s; b.r = c[0]; b.g = c[1]; b.b = c[2]; b.kind = kind;
}

function measure(now, dt) {
  V.frames++;
  if (now - V.fpsFrom >= 1000) {
    V.fps = (V.frames * 1000) / (now - V.fpsFrom);
    V.frames = 0;
    V.fpsFrom = now;
    el.root.dataset.fps = V.fps.toFixed(1);
  }
  V.frameMs += (dt * 1000 - V.frameMs) * 0.05;
  // lower the resolution when frames take too long, raise it back when there is room
  if (V.frameMs > 20) { V.slowFor += dt; V.fastFor = 0; } else if (V.frameMs < 15) { V.fastFor += dt; V.slowFor = 0; } else { V.slowFor = V.fastFor = 0; }
  if (V.slowFor > 0.7 && V.scale > 0.5) { V.scale = Math.max(0.5, V.scale - 0.15); V.slowFor = 0; V.frameMs = 16.7; }
  if (V.fastFor > 5 && V.scale < 1) { V.scale = Math.min(1, V.scale + 0.1); V.fastFor = 0; }
  const sc = V.scale.toFixed(2);
  if (sc !== V.lastScale) {
    // a data attribute write restyles the overlay: only on a change
    V.lastScale = sc;
    el.root.dataset.scale = sc;
    store.set(SCALE_KEY, sc);
  }
}

// ------------------------------------------------------------------ HUD

function setTrack(r) {
  const title = r.tags?.title || String(r.name ?? "").replace(/\.[a-z0-9]{2,5}$/i, "");
  el.title.textContent = title || t("No track");
  const chip = r.finalScore != null
    ? `${t("Track score")} ${Math.round(r.finalScore)} · ${r.finalScore > GAUGE_TOP ? "???" : stageFor(r.finalScore).label}`
    : "";
  el.artist.textContent = [r.tags?.artist, r.tags?.album, chip].filter(Boolean).join(" · ");
  const img = r.source?.image ?? null;
  el.cover.innerHTML = "";
  if (img) {
    const im = new Image();
    im.alt = "";
    im.referrerPolicy = "no-referrer";
    im.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
    im.src = img;
    el.cover.appendChild(im);
  } else {
    el.cover.innerHTML = "<span>♪</span>";
  }
  el.total.textContent = clockText(S.show.duration);
  el.strip.setAttribute("aria-valuemax", String(Math.round(S.show.duration)));
  el.track.classList.remove("swap");
  void el.track.offsetWidth;
  el.track.classList.add("swap");
}

/** The whole track under the playhead: intensity curve, sections, drops. Drawn on resize only. */
function drawStrip() {
  if (!el || !S) return;
  const c = el.stripCanvas;
  const w = el.strip.clientWidth, h = el.strip.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const { show } = S;
  const D = show.duration;
  const x = (tt) => (tt / D) * w;
  // sections: a thin coloured rail at the bottom
  for (const s of show.sections) {
    g.fillStyle = SECTION_COLORS[s.label] ?? SECTION_COLORS.Section;
    g.globalAlpha = 0.85;
    g.fillRect(x(s.start), h - 3, Math.max(1, x(s.end) - x(s.start) - 1), 3);
  }
  g.globalAlpha = 1;
  // intensity curve, filled with the heat ramp (the gauge tops out: above it, noise)
  const top = Math.max(100, Math.min(GAUGE_TOP, show.peak));
  const y = (v) => (h - 5) - (Math.min(v, top) / top) * (h - 8);
  const grad = g.createLinearGradient(0, h, 0, 0);
  for (const s of [0, 0.25, 0.5, 0.75, 1]) {
    const rgb = intensityRgb(s * top);
    grad.addColorStop(s, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.75)`);
  }
  const { times, intensity } = show;
  g.beginPath();
  g.moveTo(0, h - 5);
  g.lineTo(0, y(intensity[0]));
  for (let i = 0; i < times.length; i++) g.lineTo(x(times[i]), y(intensity[i]));
  g.lineTo(w, y(intensity.at(-1)));
  g.lineTo(w, h - 5);
  g.closePath();
  g.fillStyle = grad;
  g.globalAlpha = 0.55;
  g.fill();
  g.globalAlpha = 1;
  g.beginPath();
  for (let i = 0; i < times.length; i++) g[i ? "lineTo" : "moveTo"](x(times[i]), y(intensity[i]));
  g.strokeStyle = "rgba(255,255,255,0.85)";
  g.lineWidth = 1.5;
  g.stroke();
  // off the gauge: a broken, glitched band
  for (let i = 0; i < times.length; i++) {
    if (intensity[i] <= GAUGE_TOP) continue;
    const x0 = x(times[i] - 1.5), x1 = x(times[i] + 1.5);
    for (let yy = 0; yy < h - 5; yy += 3) {
      g.fillStyle = (Math.floor(yy / 3) + i) % 2 ? "rgba(255,40,90,0.85)" : "rgba(40,220,255,0.85)";
      const jitter = ((i * 7 + yy * 13) % 5) - 2;
      g.fillRect(x0 + jitter, yy, Math.max(1, x1 - x0), 1.5);
    }
  }
  // drops
  for (const d of show.drops) {
    g.fillStyle = "#fff";
    g.beginPath();
    const dx = x(d.time);
    g.moveTo(dx - 4, 0);
    g.lineTo(dx + 4, 0);
    g.lineTo(dx, 6);
    g.closePath();
    g.fill();
  }
}

function banner(text, big) {
  if (!el) return;
  el.bannerText.textContent = text;
  el.banner.classList.remove("show", "big");
  void el.banner.offsetWidth;
  el.banner.classList.add("show");
  el.banner.classList.toggle("big", big);
}

function hud(pos, smp, I, k, dt, playing, tension) {
  const r = el.root;
  const paused = !playing && !S.starting;
  if (!V.uiHidden && playing && performance.now() - V.pointerAt > IDLE_UI_MS) {
    V.uiHidden = true;
    r.classList.add("ui-idle");
  } else if (V.uiHidden && !playing) wake();
  r.classList.toggle("paused", paused);
  r.classList.toggle("tense", tension > 0.35 && playing);
  const hotNow = I > 100 && I <= GAUGE_TOP;
  if (hotNow !== V.hot) { V.hot = hotNow; r.classList.toggle("hot", hotNow); }
  const broken = I > GAUGE_TOP;
  if (broken !== V.broken) { V.broken = broken; r.classList.toggle("broken", broken); }

  // colours of the typography follow the palette (10 times a second: a
  // custom property change restyles the whole overlay)
  const now = performance.now();
  if (now - V.colorAt > 100) {
    V.colorAt = now;
    // in steps of 6/255: the glow of the type repaints only when the colour visibly moves
    const q6 = (x) => Math.min(255, Math.round((x * 255) / 6) * 6);
    const rgb = (c) => `${q6(c[0])},${q6(c[1])},${q6(c[2])}`;
    const b = rgb(PAL.base), a = rgb(PAL.accent);
    if (b !== V.cssBase) { V.cssBase = b; r.style.setProperty("--cc-base", b); }
    if (a !== V.cssAccent) { V.cssAccent = a; r.style.setProperty("--cc-accent", a); }
  }
  el.numWrap.style.transform = reducedMq.matches ? "" : `scale(${(1 + k * 0.09 + tension * 0.06).toFixed(4)})`;

  // the number counts smoothly towards the window score (the real one, whatever its size)
  V.shown = V.shown == null ? I : approach(V.shown, I, dt, 8);
  const n = String(Math.max(0, Math.round(V.shown)));
  if (n !== V.num) { V.num = n; el.num.textContent = n; }
  const label = V.shown > GAUGE_TOP ? "???" : stageFor(V.shown).label;
  // a new stage shows once it holds for a moment (no flicker on a boundary)
  if (label !== V.pendingLabel) { V.pendingLabel = label; V.pendingAt = now; }
  if (label !== V.stageLabel && (now - V.pendingAt > 250 || !V.stageLabel)) {
    V.stageLabel = label;
    el.stage.textContent = label;
    el.stage.classList.remove("swap");
    void el.stage.offsetWidth;
    el.stage.classList.add("swap");
  }

  // what comes next: a countdown to the drop, else the next section
  let next = "";
  let soon = false;
  if (smp.nextDropIn != null && smp.nextDropIn <= 8) {
    next = t("Drop in {n}", { n: Math.max(1, Math.ceil(smp.nextDropIn)) });
    soon = true;
  } else if (smp.nextSection && smp.nextSectionIn != null) {
    next = t("Next: {label} in {time}", { label: t(smp.nextSection.label), time: clockText(Math.ceil(smp.nextSectionIn)) });
  } else if (smp.section) {
    next = t(smp.section.label);
  }
  if (next !== V.nextText) {
    V.nextText = next;
    el.next.textContent = next;
    el.next.classList.toggle("soon", soon);
  }

  // the beat meter: tempo and attacks per second here, a light on each kick
  el.led.style.opacity = (0.18 + 0.82 * Math.min(1, k * 1.4)).toFixed(3);
  el.led.style.transform = `scale(${(0.8 + 0.6 * k).toFixed(3)})`;
  const bpm = S.show.bpmSure ? Math.round(smp.bpm) : 0;
  const hits = smp.kickKnown ? smp.kickRate + smp.snapRate : smp.onsetRate;
  const meter = [bpm ? t("{n} BPM", { n: bpm }) : "", hits > 0.2 ? t("{n} attacks/s", { n: hits.toFixed(1) }) : ""].filter(Boolean).join(" · ");
  if (meter !== V.meterText) { V.meterText = meter; el.meterText.textContent = meter; }
  if (V.syncShownAt && now - V.syncShownAt > 2500) { V.syncShownAt = 0; r.classList.remove("sync-shown"); }

  // phase line and play button
  const phase = S.starting ? t("Starting playback…")
    : S.failed ? t("Playback unavailable")
    : playing ? (S.kind === "spotify" ? t("Playing on Spotify") : t("Playing"))
    : t("Paused");
  if (phase !== V.phaseText) { V.phaseText = phase; el.phase.textContent = phase; }
  r.classList.toggle("live", playing);
  if (V.playingShown !== playing) {
    V.playingShown = playing;
    el.play.textContent = playing ? "❚❚" : "▶";
    const tip = playing ? t("Pause (Space)") : t("Play (Space)");
    el.play.title = tip;
    el.play.setAttribute("aria-label", tip);
    el.idleTitle.textContent = S.failed ? t("Playback unavailable") : t("Paused");
    el.idleText.textContent = S.failed
      ? (S.kind === "spotify" ? t("Open Spotify (the app or open.spotify.com), then press Space.") : t("Press Space to try again."))
      : t("Space: play · ← →: move 5 s · [ ]: visuals earlier / later · F: full screen · Esc: close");
  }

  // time and progress
  const tt = clockText(pos);
  if (tt !== V.timeText) {
    V.timeText = tt;
    el.elapsed.textContent = tt;
    el.strip.setAttribute("aria-valuenow", String(Math.round(pos)));
    el.strip.setAttribute("aria-valuetext", `${tt} / ${clockText(S.show.duration)}`);
  }
  const p = smp.progress;
  el.stripFill.style.transform = `scaleX(${p.toFixed(4)})`;
  el.stripHead.style.transform = `translateX(${(p * V.stripW).toFixed(1)}px)`;

  // sub-scores
  for (const d of DIMENSIONS) {
    const target = clamp((smp.subs[d.key] ?? 0) / 100) * (paused ? 0.5 : 1);
    const v = (V.subs[d.key] = approach(V.subs[d.key] ?? 0, target, dt, 4));
    el.subs[d.key].style.transform = `scaleY(${v.toFixed(3)})`;
  }
}
