// Animated backdrop behind every tab: slow heat-ramp light (an "aurora" of a
// few soft blobs drawn on a tiny canvas that the compositor scales up, so the
// blur is free) and three faint waveform lines drifting sideways across a band
// of the window. The vignette and the grain of body::before / ::after sit on top.
//
// It reacts a little to what is heard or looked at: setBackdropHeat(0..1, key)
// warms the colours and speeds the drift up (a track playing, a track's detail
// open, the Live gauge). Calm and cool when nothing is set.
//
// Cost: one canvas of about 1/12 of the window (≈ 120 × 75 px) and three
// polylines, redrawn together at most 30 times a second (both layers change
// in the same frame, so the compositor works 30 times a second, not 60), and
// nothing at all while the page is hidden. Under prefers-reduced-motion it is
// drawn once and stays still. Settings can make it still or turn it off
// ("mea.backdrop": "on" | "still" | "off").

const KEY = "mea.backdrop";
export const BACKDROP_MODES = ["on", "still", "off"];
const SCALE = 12;          // canvas pixel = SCALE CSS pixels
const FRAME_MS = 1000 / 30;
const CALM = 0.12;         // heat when nothing is set
const LINE_RES = 0.5;      // waveform canvas pixels per CSS pixel

// calm → hot colours of each blob (heat ramp stops of styles.css)
const BLOBS = [
  { calm: [59, 130, 246], hot: [239, 68, 68], x: 0.18, y: 0.12, r: 0.62, ax: 0.16, ay: 0.10, sx: 0.050, sy: 0.037, p: 0.0 },
  { calm: [217, 70, 239], hot: [217, 70, 239], x: 0.82, y: 0.08, r: 0.55, ax: 0.14, ay: 0.12, sx: 0.041, sy: 0.053, p: 1.7 },
  { calm: [6, 182, 212], hot: [249, 115, 22], x: 0.70, y: 0.78, r: 0.60, ax: 0.18, ay: 0.10, sx: 0.033, sy: 0.045, p: 3.1 },
  { calm: [99, 102, 241], hot: [234, 179, 8], x: 0.20, y: 0.85, r: 0.50, ax: 0.12, ay: 0.14, sx: 0.047, sy: 0.029, p: 4.4 },
];

const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false, addEventListener() {} };
const lightQuery = window.matchMedia?.("(prefers-color-scheme: light)") ?? { matches: false, addEventListener() {} };

const sources = new Map(); // key → heat, most recent last
let el = null, canvas = null, ctx = null, lines = null, lctx = null;
let mode = "on";
let heat = CALM, target = CALM;
let clock = 0;             // animation time (s), advances faster when hot
let last = 0, lastDraw = 0, raf = 0;
let concertOn = false;

export function getBackdropMode() { return mode; }

/** Current (eased) heat, 0 … 1. */
export const backdropHeat = () => heat;

/** "on" (animated), "still" (drawn once) or "off" (hidden). Remembered in this browser. */
export function setBackdropMode(m) {
  mode = BACKDROP_MODES.includes(m) ? m : "on";
  try { localStorage.setItem(KEY, mode); } catch { /* storage blocked */ }
  apply();
}

/**
 * How intense the backdrop should feel, 0 (calm) … 1 (off the charts), for a
 * given source ("play", "detail", "live"…). null removes that source; the most
 * recently set source wins.
 */
export function setBackdropHeat(value, key = "default") {
  const v = value == null || !Number.isFinite(value) ? null : Math.max(0, Math.min(1, value));
  if (v == null) sources.delete(key);
  else if (sources.get(key) !== v) { sources.delete(key); sources.set(key, v); }
  const next = sources.size ? [...sources.values()].at(-1) : CALM;
  if (next === target) return;
  target = next;
  if (mode === "still" || (mode === "on" && reduce.matches)) { heat = target; drawOnce(); }
}

/** Heat of a score on the app's scale (0 … ≈ 110 = off the charts). */
export const heatOfScore = (score) => (score == null || !Number.isFinite(score) ? null : Math.max(0, Math.min(1, score / 110)));

export function initBackdrop() {
  try { const m = localStorage.getItem(KEY); if (BACKDROP_MODES.includes(m)) mode = m; } catch { /* storage blocked */ }
  el = document.createElement("div");
  el.className = "backdrop";
  el.setAttribute("aria-hidden", "true");
  canvas = document.createElement("canvas");
  canvas.className = "backdrop-aurora";
  ctx = canvas.getContext("2d", { alpha: true });
  lines = document.createElement("canvas");
  lines.className = "backdrop-lines";
  lctx = lines.getContext("2d", { alpha: true });
  el.append(canvas, lines);
  document.body.prepend(el);
  resize();
  window.addEventListener("resize", () => { resize(); if (!raf) drawOnce(); });
  document.addEventListener("visibilitychange", apply);
  document.addEventListener("concert-state", (e) => { concertOn = !!e.detail?.open; apply(); });
  // modules that should not import this one (the Live gauge) send an event
  document.addEventListener("backdrop-heat", (e) => setBackdropHeat(heatOfScore(e.detail?.score), e.detail?.key ?? "event"));
  reduce.addEventListener?.("change", apply);
  lightQuery.addEventListener?.("change", () => drawOnce());
  new MutationObserver(() => drawOnce()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  apply();
}

function apply() {
  if (!el) return;
  el.hidden = mode === "off";
  document.documentElement.classList.toggle("has-backdrop", mode !== "off");
  el.classList.toggle("still", mode === "still" || reduce.matches);
  // the concert mode covers the page: no frames spent on a backdrop nobody sees
  const animate = mode === "on" && !reduce.matches && !document.hidden && !concertOn;
  if (animate && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  if (!animate && raf) { cancelAnimationFrame(raf); raf = 0; }
  if (!animate && mode !== "off") { heat = target; drawOnce(); }
}

function resize() {
  const w = Math.max(24, Math.ceil(window.innerWidth / SCALE));
  const h = Math.max(24, Math.ceil(window.innerHeight / SCALE));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  // the lines' band (see .backdrop-lines) at half resolution: faint soft lines
  // do not need more, and it keeps the canvas upload small
  const dpr = LINE_RES;
  const lw = Math.round(window.innerWidth * dpr), lh = Math.round(window.innerHeight * 0.3 * dpr);
  if (lines.width !== lw || lines.height !== lh) { lines.width = lw; lines.height = lh; }
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  // ease towards the target heat over ~1.5 s, drift faster when hot
  heat += (target - heat) * (1 - Math.exp(-dt / 1.5));
  clock += dt * (1 + heat * 2.2);
  if (now - lastDraw < FRAME_MS - 2) return;
  lastDraw = now;
  draw();
}

function drawOnce() {
  if (!ctx || mode === "off") return;
  draw();
}

const isLight = () => {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === "light" : lightQuery.matches;
};

function draw() {
  const w = canvas.width, h = canvas.height, m = Math.max(w, h);
  const light = isLight();
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = light ? "source-over" : "lighter";
  const base = light ? 0.13 + heat * 0.08 : 0.17 + heat * 0.15;
  for (const b of BLOBS) {
    const x = (b.x + b.ax * Math.sin(clock * b.sx * 2 * Math.PI + b.p)) * w;
    const y = (b.y + b.ay * Math.cos(clock * b.sy * 2 * Math.PI + b.p * 1.3)) * h;
    const r = b.r * m * (0.9 + 0.1 * Math.sin(clock * 0.07 + b.p));
    const c = b.calm.map((v, i) => Math.round(v + (b.hot[i] - v) * heat));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${c},${base})`);
    g.addColorStop(0.45, `rgba(${c},${base * 0.45})`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  drawLines(light);
}

// three waveform lines: sums of sines shaped by a slow envelope, like a
// track's loudness curve, sliding sideways; taller, brighter and faster when hot
const WAVES = [
  { k: [3, 7, 13], ph: 0, speed: 0.012, alpha: 1, amp: 1, cols: ["59,130,246", "217,70,239"] },
  { k: [2, 5, 11], ph: 1.9, speed: -0.009, alpha: 0.7, amp: 0.76, cols: ["6,182,212", "249,115,22"] },
  { k: [4, 9, 17], ph: 3.7, speed: 0.007, alpha: 0.5, amp: 0.48, cols: ["217,70,239", "34,211,238"] },
];

function drawLines(light) {
  const w = lines.width, h = lines.height;
  const dpr = w / Math.max(1, window.innerWidth);
  lctx.clearRect(0, 0, w, h);
  const base = light ? 0.16 + heat * 0.24 : 0.2 + heat * 0.3;
  const amp = h * 0.42 * (0.65 + heat * 0.7);
  const period = Math.max(900, window.innerWidth) * dpr; // one period spans the window
  const step = 6 * dpr;
  lctx.lineWidth = Math.max(1, 1.25 * dpr);
  lctx.lineJoin = "round";
  for (const wv of WAVES) {
    // horizontal colour ramp that fades out at both edges
    const g = lctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, `rgba(${wv.cols[0]},0)`);
    g.addColorStop(0.2, `rgba(${wv.cols[0]},${base * wv.alpha})`);
    g.addColorStop(0.55, `rgba(${wv.cols[1]},${base * wv.alpha})`);
    g.addColorStop(0.82, `rgba(${wv.cols[0]},${base * wv.alpha})`);
    g.addColorStop(1, `rgba(${wv.cols[0]},0)`);
    lctx.strokeStyle = g;
    lctx.beginPath();
    const shift = clock * wv.speed * 2 * Math.PI;
    for (let x = 0; x <= w + step; x += step) {
      const u = (x / period) * 2 * Math.PI + shift;
      const env = 0.55 + 0.45 * Math.sin(u * 2 + wv.ph);
      const y = env * (0.6 * Math.sin(u * wv.k[0] + wv.ph) + 0.28 * Math.sin(u * wv.k[1] + wv.ph * 2) + 0.12 * Math.sin(u * wv.k[2] + wv.ph * 3));
      const py = h / 2 - y * amp * wv.amp;
      if (x === 0) lctx.moveTo(x, py); else lctx.lineTo(x, py);
    }
    lctx.stroke();
  }
}

