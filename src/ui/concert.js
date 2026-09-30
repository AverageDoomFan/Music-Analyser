// Concert mode: a full-screen, audio-reactive visualiser for the Live tab.
// It taps the Live capture (its own AnalyserNode, chained after the Live
// tab's analyser, which passes the audio through unchanged) for per-frame FFT
// and waveform, and reads the live intensity (the gauge's smoothed needle),
// the stage, the sub-scores and the current track from the Live tab.
// WebGL2 (concert-gl.js), Canvas2D fallback (concert-2d.js).

import { stageFor, DIMENSIONS, SCORE_MAX } from "../config.js";
import { t } from "../i18n/index.js";
import { DIM_COLORS } from "./live-draw.js";
import { OnsetDetector, FlashLimiter, concertPalette, concertDrive, visualParams, levelIntensity, approach, clamp } from "./concert-logic.js";
import { createGLRenderer, DATA_WIDTH, BURST_SLOTS } from "./concert-gl.js";
import { create2DRenderer } from "./concert-2d.js";

const FFT = 2048;
const MAX_DPR = 1.5;
const MAX_PIXELS = 2.2e6; // ~1080p: hiDPI and 4K screens render a little softer, not slower
const IDLE_UI_MS = 2000;
const SILENCE_S = 2.5;
const reducedMq = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false };

let hooks = null;          // { state(): {...}, setActive(on) }
let el = null;             // overlay element and its parts
let renderer = null;
let raf = 0;
let open = false;

// audio tap
let tapFor = null, tap = null, detector = null;
let freq = null, time = null;

// visual state (reused every frame)
const spectrum = new Float32Array(DATA_WIDTH);
const wave = new Float32Array(DATA_WIDTH);
let bandMap = null;
const V = {
  t0: 0, last: 0, time: 0, travel: 0, intensity: 8, shown: null, kick: 0, onset: 0, flash: 0,
  idle: 1, silentFor: 99, bass: 0, loud: 0, mid: 0, high: 0, wavePeak: 0.1, scale: 1,
  frameMs: 16.7, cpu: 0, kickAt: -100, kickStrength: 0, colorAt: 0, cssBase: "", cssAccent: "", slowFor: 0, fastFor: 0, frames: 0, fpsFrom: 0, fps: 0,
  kickSlot: 0, onsetSlot: 0, lastOnsetBurst: 0, trackId: undefined, stageLabel: "", num: "", subs: {},
  hot: false, pointerAt: 0, uiHidden: false,
};
const bursts = Array.from({ length: BURST_SLOTS }, () => ({ x: 0, y: 0, t: -100, s: 0, r: 1, g: 1, b: 1, kind: 0 }));
const limiter = new FlashLimiter({ reduced: reducedMq.matches });
const frame = {
  time: 0, travel: 0, heat: 0, hot: 0, kick: 0, bass: 0, loud: 0, idle: 1, tunnel: 0,
  zoom: 1, rot: 0, decay: 0.85, ringR: 0.26, ringH: 0.2, bloom: 1, bloomThreshold: 0.5, ca: 0, exposure: 1.2,
  grain: 0.03, glitch: 0, flash: 0, starBright: 0.3, shake: [0, 0],
  palette: null, drive: null, spectrum, wave, bursts,
};

/**
 * @param {{state: () => {capture:object|null, status:object|null, current:object|null, readout:number|null},
 *   setActive: (on:boolean) => void}} h  hooks into the Live tab
 */
export function initConcert(h) {
  hooks = h;
  document.getElementById("lv-concert")?.addEventListener("click", () => openConcert());
}

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
  const subs = DIMENSIONS.map((d) => `<div class="cc-sub" data-k="${d.key}" style="--c:${DIM_COLORS[d.key]}"><div class="cc-sub-bar"><i></i></div><span>${d.label}</span></div>`).join("");
  root.innerHTML = `
    <canvas class="cc-canvas" aria-hidden="true"></canvas>
    <div class="cc-hud">
      <div class="cc-top">
        <div class="cc-status"><span class="cc-dot"></span><span class="cc-phase"></span></div>
        <div class="cc-actions">
          <button type="button" class="cc-btn cc-fs" title="${t("Full screen (F)")}" aria-label="${t("Full screen (F)")}">⛶</button>
          <button type="button" class="cc-btn cc-close" title="${t("Close (Esc)")}" aria-label="${t("Close concert mode")}">✕</button>
        </div>
      </div>
      <div class="cc-center">
        <div class="cc-num-wrap"><div class="cc-num" aria-live="off">—</div></div>
        <div class="cc-stage"></div>
      </div>
      <div class="cc-bottom">
        <div class="cc-track">
          <div class="cc-cover"><span>♪</span></div>
          <div class="cc-meta">
            <div class="cc-kicker">${t("Now playing")}</div>
            <div class="cc-title"></div>
            <div class="cc-artist"></div>
          </div>
        </div>
        <div class="cc-subs" aria-hidden="true">${subs}</div>
      </div>
    </div>
    <div class="cc-idle" aria-live="polite">
      <div class="cc-idle-title">${t("Waiting for sound")}</div>
      <p class="cc-idle-text">${t("Start a scan, the follow mode or the demo in the Live tab: the show starts with the first note.")}</p>
    </div>`;
  document.body.appendChild(root);
  const q = (s) => root.querySelector(s);
  el = {
    root, canvas: q(".cc-canvas"), num: q(".cc-num"), numWrap: q(".cc-num-wrap"), stage: q(".cc-stage"), phase: q(".cc-phase"),
    title: q(".cc-title"), artist: q(".cc-artist"), cover: q(".cc-cover"), track: q(".cc-track"), idle: q(".cc-idle"),
    subs: Object.fromEntries([...root.querySelectorAll(".cc-sub")].map((s) => [s.dataset.k, s.querySelector("i")])),
  };
  q(".cc-close").addEventListener("click", () => closeConcert());
  q(".cc-fs").addEventListener("click", () => toggleFullscreen());
  root.addEventListener("pointermove", wake);
  root.addEventListener("pointerdown", wake);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeConcert(); }
    else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
    else wake();
  });
  document.addEventListener("fullscreenchange", () => {
    // leaving full screen (Esc handled by the browser) closes the show
    if (open && root.dataset.fs === "1" && document.fullscreenElement !== root) closeConcert();
    root.dataset.fs = document.fullscreenElement === root ? "1" : "0";
  });
  reducedMq.addEventListener?.("change", () => limiter.set({ reduced: reducedMq.matches }));
  makeRenderer();
}

function makeRenderer() {
  renderer = new URLSearchParams(location.search).has("concert2d") ? null : createGLRenderer(el.canvas);
  if (!renderer) {
    // a canvas that tried WebGL cannot give a 2D context: use a fresh one
    const c = document.createElement("canvas");
    c.className = "cc-canvas";
    c.setAttribute("aria-hidden", "true");
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

export function openConcert() {
  if (open) return;
  if (!el) build();
  open = true;
  el.root.hidden = false;
  el.root.focus({ preventScroll: true });
  document.documentElement.classList.add("concert-on");
  hooks?.setActive(true);
  V.last = performance.now();
  if (!V.t0) V.t0 = V.last; // one clock for the page: bursts and the flash limiter keep their times
  V.fpsFrom = V.last;
  V.frames = 0;
  V.trackId = undefined;
  V.shown = null;
  V.num = "";
  wake();
  if (el.root.requestFullscreen) el.root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  requestAnimationFrame(() => el.root.classList.add("in"));
  raf = requestAnimationFrame(tick);
}

export function closeConcert() {
  if (!open) return;
  open = false;
  cancelAnimationFrame(raf);
  untap();
  el.root.classList.remove("in", "hot", "ui-idle");
  el.root.hidden = true;
  document.documentElement.classList.remove("concert-on");
  hooks?.setActive(false);
  if (document.fullscreenElement === el.root) document.exitFullscreen().catch(() => {});
  document.getElementById("lv-concert")?.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ audio

function retap(capture) {
  if (capture === tapFor) return;
  untap();
  tapFor = capture;
  const src = capture?.analyser;
  if (!src) return;
  try {
    const ctx = src.context;
    tap = ctx.createAnalyser();
    tap.fftSize = FFT;
    tap.smoothingTimeConstant = 0.15;
    tap.minDecibels = -100;
    tap.maxDecibels = -10;
    src.connect(tap); // an AnalyserNode passes its input through
    freq = new Float32Array(tap.frequencyBinCount);
    time = new Float32Array(FFT);
    detector = new OnsetDetector({ sampleRate: ctx.sampleRate, fftSize: FFT });
    bandMap = logBands(ctx.sampleRate);
  } catch (err) {
    console.warn("Concert mode: no audio tap", err);
    tap = null;
  }
}

function untap() {
  try { if (tap) tapFor?.analyser?.disconnect(tap); } catch { /* context closed */ }
  tap = null;
  tapFor = null;
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
  if (!tap || !detector) {
    spectrum.fill(0);
    for (let i = 0; i < DATA_WIDTH; i++) wave[i] *= 0.9;
    V.bass = V.loud = V.mid = V.high = 0;
    return null;
  }
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
      // interpolate between the two nearest FFT bins
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
  V.mid = o.mid;
  V.high = o.high;
  return o;
}

// ------------------------------------------------------------------ frame

function tick(now) {
  if (!open) return;
  raf = requestAnimationFrame(tick);
  const dt = Math.min(0.1, Math.max(0.001, (now - V.last) / 1000));
  V.last = now;
  measure(now, dt);
  const reduced = reducedMq.matches;
  const st = hooks?.state() ?? {};
  retap(st.capture ?? null);
  const o = readAudio(dt, now);

  // silence / idle
  const sounding = !!o && o.loud > 0.03;
  V.silentFor = sounding ? 0 : V.silentFor + dt;
  const idle = !st.capture || V.silentFor > SILENCE_S;
  V.idle = approach(V.idle, idle ? 1 : 0, dt, idle ? 1.5 : 4);

  // intensity: the gauge's needle, else a guess from the level, calm when idle
  const cur = st.current ?? null;
  const reading = st.readout ?? cur?.final?.score ?? null;
  const target = idle ? 8 + 4 * Math.sin(now / 2400) : reading ?? levelIntensity(V.loud);
  V.intensity = approach(V.intensity, target, dt, 2.5);
  const I = V.intensity;
  const sub = cur?.live?.current?.subscores ?? null;
  const drive = concertDrive(I, sub);
  const pal = concertPalette(I);
  const heat = drive.heat, hot = drive.hot;
  V.time = (now - V.t0) / 1000;

  // hits
  if (o && !idle) {
    if (o.kick) {
      const s = clamp(o.kickStrength * (0.6 + heat * 0.8));
      V.kick = Math.max(V.kick, s);
      V.kickAt = V.time;
      V.kickStrength = s;
      burst(V.kickSlot, 0, 0, s, pal.accent, 1);
      V.kickSlot = (V.kickSlot + 1) % 4;
      const want = heat > 0.55 ? o.kickStrength * (heat - 0.45) * 1.8 + hot * 0.45 : 0;
      const fl = limiter.request(V.time, want * (reduced ? 0.4 : 1));
      if (fl > V.flash) V.flash = fl;
    }
    if (o.onset && V.time - V.lastOnsetBurst > 0.14) {
      V.lastOnsetBurst = V.time;
      V.onset = Math.max(V.onset, o.strength);
      const a = Math.random() * Math.PI * 2, r = 0.45 + Math.random() * 0.5;
      const aspect = el.canvas.width / Math.max(1, el.canvas.height);
      const c = Math.random() < 0.5 ? pal.base : pal.accent;
      burst(4 + V.onsetSlot, Math.cos(a) * r * aspect * 0.8, Math.sin(a) * r, clamp(o.strength * (0.3 + heat)), c, 0);
      V.onsetSlot = (V.onsetSlot + 1) % 4;
    }
  }
  V.kick *= Math.exp(-dt * 6);
  V.onset *= Math.exp(-dt * 8);
  V.flash *= Math.exp(-dt * 10);

  // motion
  const k = V.kick;
  V.travel += dt * drive.speed * (1 + k * 0.9) * (reduced ? 0.5 : 1) * (1 - V.idle * 0.7);
  visualParams(frame, { kickAt: V.kickAt, kickStrength: V.kickStrength, time: V.time, dt, travel: V.travel, kick: k, bass: V.bass, loud: V.loud, idle: V.idle, flash: V.flash, drive, palette: pal, reduced });

  // size, with an adaptive render scale (keeps 60 fps on smaller GPUs)
  const cw = window.innerWidth, ch = window.innerHeight; // the overlay is fixed, inset 0 (no layout read)
  let dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  dpr *= Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, cw * ch * dpr * dpr))) * V.scale;
  renderer?.resize(cw * dpr, ch * dpr);
  renderer?.render(frame);

  hud(st, cur, reading, k, pal, dt, idle);
  // main-thread cost of the frame (GPU work excluded), for diagnostics
  V.cpu += (performance.now() - now - V.cpu) * 0.05;
  if (V.frames === 0) el.root.dataset.cpu = V.cpu.toFixed(2);
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
  if (V.frameMs > 21) { V.slowFor += dt; V.fastFor = 0; } else if (V.frameMs < 15) { V.fastFor += dt; V.slowFor = 0; } else { V.slowFor = V.fastFor = 0; }
  if (V.slowFor > 1.5 && V.scale > 0.5) { V.scale = Math.max(0.5, V.scale - 0.15); V.slowFor = 0; }
  if (V.fastFor > 4 && V.scale < 1) { V.scale = Math.min(1, V.scale + 0.1); V.fastFor = 0; }
  el.root.dataset.scale = V.scale.toFixed(2);
}

// ------------------------------------------------------------------ HUD

function hud(st, cur, reading, k, pal, dt, idle) {
  const r = el.root;
  if (!V.uiHidden && performance.now() - V.pointerAt > IDLE_UI_MS) {
    V.uiHidden = true;
    r.classList.add("ui-idle");
  }
  r.classList.toggle("idle", idle);
  const hotNow = reading != null && reading > 100;
  if (hotNow !== V.hot) { V.hot = hotNow; r.classList.toggle("hot", hotNow); }

  // colours of the typography follow the heat ramp (10 times a second: a
  // custom property change restyles the whole overlay)
  const now = performance.now();
  if (now - V.colorAt > 100) {
    V.colorAt = now;
    const rgb = (c) => `${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}`;
    const b = rgb(pal.base), a = rgb(pal.accent);
    if (b !== V.cssBase) { V.cssBase = b; r.style.setProperty("--cc-base", b); }
    if (a !== V.cssAccent) { V.cssAccent = a; r.style.setProperty("--cc-accent", a); }
  }
  el.numWrap.style.transform = reducedMq.matches ? "" : `scale(${(1 + k * 0.09).toFixed(4)})`;

  // the number counts smoothly towards the reading
  if (reading != null) {
    V.shown = V.shown == null ? reading : approach(V.shown, reading, dt, 5);
    const n = String(Math.round(Math.max(0, Math.min(SCORE_MAX, V.shown))));
    if (n !== V.num) { V.num = n; el.num.textContent = n; }
    const label = stageFor(V.shown).label;
    if (label !== V.stageLabel) {
      V.stageLabel = label;
      el.stage.textContent = label;
      el.stage.classList.remove("swap");
      void el.stage.offsetWidth;
      el.stage.classList.add("swap");
    }
  } else if (V.num !== "—") {
    V.shown = null;
    V.num = "—";
    el.num.textContent = "—";
    V.stageLabel = t("Listening");
    el.stage.textContent = V.stageLabel;
  }

  // phase line
  const s = st.status;
  const phase = !st.capture ? t("No audio captured") : s?.paused ? t("Paused") : s?.running ? s.phase || "…" : st.capture.label ?? "";
  if (el.phase.textContent !== phase) el.phase.textContent = phase;
  r.classList.toggle("live", !!st.capture && !s?.paused);

  // track
  const tk = cur?.track ?? null;
  const id = tk?.id ?? null;
  if (id !== V.trackId) {
    V.trackId = id;
    el.title.textContent = tk?.name ?? t("No track");
    el.artist.textContent = tk ? [tk.artists?.join(", "), tk.album].filter(Boolean).join(" · ") : st.capture ? t("Free listening: no scan running") : "";
    const img = tk?.imageLarge || tk?.image;
    el.cover.innerHTML = "";
    if (img) {
      const im = new Image();
      im.alt = "";
      im.referrerPolicy = "no-referrer";
      im.src = img;
      el.cover.appendChild(im);
      r.style.setProperty("--cc-cover", `url("${img.replace(/["\\]/g, "")}")`);
    } else {
      el.cover.innerHTML = "<span>♪</span>";
      r.style.setProperty("--cc-cover", "none");
    }
    el.track.classList.remove("swap");
    void el.track.offsetWidth;
    el.track.classList.add("swap");
  }

  // sub-scores
  const sub = cur?.live?.current?.subscores ?? null;
  for (const d of DIMENSIONS) {
    const target = idle || !sub ? 0 : clamp((sub[d.key] ?? 0) / 100);
    const v = (V.subs[d.key] = approach(V.subs[d.key] ?? 0, target, dt, 4));
    el.subs[d.key].style.transform = `scaleY(${v.toFixed(3)})`;
  }
}

