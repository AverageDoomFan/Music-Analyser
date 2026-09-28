// Canvas renderers of the live scan stage (always dark). Dependency-free.

import { STAGES, stageFor, DIMENSIONS } from "../config.js";

export const DIM_COLORS = {
  energy: "#fb923c", tempo: "#22d3ee", density: "#a3e635", brightness: "#facc15",
  harshness: "#f87171", pressure: "#a78bfa", complexity: "#2dd4bf", noise: "#f0abfc",
};

const SCALE = [
  [0, [59, 130, 246]], [20, [6, 182, 212]], [38, [34, 197, 94]], [55, [234, 179, 8]],
  [70, [249, 115, 22]], [84, [239, 68, 68]], [94, [217, 70, 239]], [100, [250, 232, 255]],
];

/** Colour of an intensity value on the stage palette (blue calm → magenta noise). */
export function intensityRgb(v) {
  const x = Math.max(0, Math.min(100, v ?? 0));
  for (let i = 1; i < SCALE.length; i++) {
    const [x1, c1] = SCALE[i];
    if (x <= x1) {
      const [x0, c0] = SCALE[i - 1];
      const t = (x - x0) / (x1 - x0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * t));
    }
  }
  return SCALE.at(-1)[1];
}
export const intensityColor = (v, a = 1) => {
  const [r, g, b] = intensityRgb(v);
  return a === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
};

const TEXT = "#eef1f7";
const MUTED = "#8b93a7";
const LINE = "#232835";
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Sizes the backing store to the CSS size × devicePixelRatio; returns a context in CSS pixels. */
export function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, canvas.clientWidth);
  const h = Math.max(10, canvas.clientHeight || Number(canvas.getAttribute("height")) || 100);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

// ---------------------------------------------------------------- gauge

export function drawGauge(canvas, { value, score, label, caption, active }) {
  const { ctx, w, h } = fit(canvas);
  const cx = w / 2, cy = h / 2 + 6, r = Math.min(w, h) / 2 - 16;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const ang = (v) => a0 + (a1 - a0) * Math.max(0, Math.min(1, v / 100));
  // track, coloured by segments
  ctx.lineCap = "butt";
  for (let v = 0; v < 100; v += 2) {
    ctx.beginPath();
    ctx.strokeStyle = intensityColor(v + 1, value != null && v <= value ? 1 : 0.14);
    ctx.lineWidth = 14;
    ctx.arc(cx, cy, r, ang(v), ang(v + 1.6));
    ctx.stroke();
  }
  // track score marker
  if (score != null) {
    const a = ang(score);
    ctx.beginPath();
    ctx.strokeStyle = TEXT;
    ctx.lineWidth = 3;
    ctx.moveTo(cx + Math.cos(a) * (r - 13), cy + Math.sin(a) * (r - 13));
    ctx.lineTo(cx + Math.cos(a) * (r + 12), cy + Math.sin(a) * (r + 12));
    ctx.stroke();
  }
  // glow on the tip
  if (value != null) {
    const a = ang(value);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 22);
    g.addColorStop(0, intensityColor(value, active ? 0.9 : 0.5));
    g.addColorStop(1, intensityColor(value, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = "center";
  ctx.fillStyle = TEXT;
  ctx.font = `700 54px ${FONT}`;
  ctx.fillText(value == null ? "—" : String(Math.round(value)), cx, cy + 12);
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = value == null ? MUTED : intensityColor(value);
  ctx.fillText(label ?? "intensité", cx, cy + 36);
  ctx.font = `12px ${FONT}`;
  ctx.fillStyle = MUTED;
  if (caption) ctx.fillText(caption, cx, cy + 56);
}

// ---------------------------------------------------------------- timeline bar

export function drawTimeline(canvas, cur, position, t) {
  const { ctx, w, h } = fit(canvas);
  const top = 14, bh = 18;
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  roundRect(ctx, 0, top, w, bh, 6);
  ctx.fill();
  if (!cur) return;
  const x = (s) => (s / cur.duration) * w;
  // intensity of heard windows as a coloured strip
  const live = cur.live;
  const curve = live?.scoring?.curves;
  if (curve) {
    curve.times.forEach((tm, i) => {
      const x0 = x(tm - 1.5), x1 = x(tm + 1.5);
      ctx.fillStyle = intensityColor(curve.intensity[i], 0.9);
      ctx.fillRect(x0, top + 2, Math.max(1, x1 - x0), bh - 4);
    });
  }
  for (const seg of cur.plan) {
    const x0 = x(seg.pos), x1 = x(seg.pos + seg.len);
    if (seg.state === "planned" || seg.state === "seeking") {
      ctx.strokeStyle = seg.state === "seeking" ? "#ffffff" : "rgba(255,255,255,0.35)";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, top + 0.5, Math.max(2, x1 - x0) - 1, bh - 1);
      ctx.setLineDash([]);
    } else if (seg.state === "recording") {
      // animated stripes on the part still to be heard
      const from = x((seg.recordedFrom ?? seg.pos) + (seg.filled ?? 0));
      ctx.save();
      ctx.beginPath();
      ctx.rect(from, top, Math.max(0, x1 - from), bh);
      ctx.clip();
      ctx.fillStyle = "rgba(255,59,92,0.18)";
      ctx.fillRect(from, top, x1 - from, bh);
      ctx.strokeStyle = "rgba(255,59,92,0.5)";
      ctx.lineWidth = 3;
      const off = (t / 40) % 12;
      for (let k = from - bh - 12 + off; k < x1 + bh; k += 12) {
        ctx.beginPath();
        ctx.moveTo(k, top + bh);
        ctx.lineTo(k + bh, top);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (seg.kind === "probe" || seg.kind === "focus") {
      ctx.fillStyle = seg.kind === "probe" ? "rgba(255,255,255,0.55)" : "#ffd166";
      ctx.fillRect(x0, top + bh + 3, Math.max(2, x1 - x0), 3);
    }
  }
  // probe scores
  for (const p of cur.probes ?? []) {
    if (p.score == null) continue;
    const px = x(p.pos + p.len / 2);
    ctx.fillStyle = intensityColor(p.score);
    ctx.beginPath();
    ctx.arc(px, top - 6, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // playhead
  if (position != null) {
    const px = x(position);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(px - 1, top - 4, 2, bh + 8);
    ctx.beginPath();
    ctx.arc(px, top + bh / 2, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------- intensity curve

export function drawCurve(canvas, { cur, enabled, position }) {
  const { ctx, w, h } = fit(canvas);
  const m = { l: 30, r: 10, t: 8, b: 20 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const dur = cur?.duration || 180;
  const X = (s) => m.l + (s / dur) * pw;
  const Y = (v) => m.t + ph - (v / 100) * ph;
  // stage bands
  STAGES.forEach((s, i) => {
    const top = STAGES[i + 1]?.min ?? 100;
    ctx.fillStyle = intensityColor((s.min + top) / 2, 0.05 + (i % 2) * 0.03);
    ctx.fillRect(m.l, Y(top), pw, Y(s.min) - Y(top));
    if (pw > 380 && Y(s.min) - Y(top) > 11) {
      ctx.fillStyle = "rgba(139,147,167,0.7)";
      ctx.font = `10px ${FONT}`;
      ctx.textAlign = "right";
      ctx.fillText(s.label, m.l + pw - 4, (Y(s.min) + Y(top)) / 2 + 3);
    }
  });
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.fillStyle = MUTED;
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = "right";
  for (const v of [0, 25, 50, 75, 100]) {
    ctx.beginPath();
    ctx.moveTo(m.l, Y(v) + 0.5);
    ctx.lineTo(m.l + pw, Y(v) + 0.5);
    ctx.stroke();
    ctx.fillText(String(v), m.l - 5, Y(v) + 3);
  }
  ctx.textAlign = "center";
  const step = dur > 400 ? 60 : dur > 150 ? 30 : 15;
  for (let s = 0; s <= dur; s += step) ctx.fillText(fmtTime(s), X(s), h - 5);
  if (!cur) return;

  // heard excerpts
  for (const seg of cur.plan) {
    if (seg.state === "planned") continue;
    const from = seg.recordedFrom ?? seg.pos;
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.fillRect(X(from), m.t, Math.max(1, X(from + (seg.filled ?? 0)) - X(from)), ph);
  }
  const curve = cur.live?.scoring?.curves;
  if (!curve?.times.length) return;
  const T = curve.times;
  // runs of consecutive windows (gaps between excerpts are not joined)
  const runs = [];
  let run = [0];
  for (let i = 1; i < T.length; i++) {
    if (T[i] - T[i - 1] > 4.5) { runs.push(run); run = [i]; } else run.push(i);
  }
  runs.push(run);

  // sub-score curves
  for (const d of DIMENSIONS) {
    if (!enabled.has(d.key)) continue;
    const vals = curve.subscores[d.key];
    ctx.strokeStyle = DIM_COLORS[d.key];
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.5;
    for (const r of runs) {
      ctx.beginPath();
      r.forEach((i, k) => (k ? ctx.lineTo(X(T[i]), Y(vals[i])) : ctx.moveTo(X(T[i]), Y(vals[i]))));
      if (r.length === 1) ctx.arc(X(T[r[0]]), Y(vals[r[0]]), 1.5, 0, 7);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // intensity: gradient area + line
  if (enabled.has("intensity")) {
    const grad = ctx.createLinearGradient(0, Y(100), 0, Y(0));
    for (const [v] of SCALE) grad.addColorStop(1 - v / 100, intensityColor(v, 0.55));
    const half = (i) => X(T[i] + 1.5) - X(T[i]); // a lone window (probe) covers ~3 s
    for (const r of runs) {
      const x0 = X(T[r[0]]) - (r.length === 1 ? half(r[0]) : 0), x1 = X(T[r.at(-1)]) + (r.length === 1 ? half(r[0]) : 0);
      ctx.beginPath();
      ctx.moveTo(x0, Y(0));
      if (r.length === 1) { ctx.lineTo(x0, Y(curve.intensity[r[0]])); ctx.lineTo(x1, Y(curve.intensity[r[0]])); }
      else r.forEach((i) => ctx.lineTo(X(T[i]), Y(curve.intensity[i])));
      ctx.lineTo(x1, Y(0));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.45;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    const lineGrad = ctx.createLinearGradient(0, Y(100), 0, Y(0));
    for (const [v] of SCALE) lineGrad.addColorStop(1 - v / 100, intensityColor(v));
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    for (const r of runs) {
      ctx.beginPath();
      if (r.length === 1) {
        const y = Y(curve.intensity[r[0]]);
        ctx.moveTo(X(T[r[0]]) - half(r[0]), y);
        ctx.lineTo(X(T[r[0]]) + half(r[0]), y);
      } else r.forEach((i, k) => (k ? ctx.lineTo(X(T[i]), Y(curve.intensity[i])) : ctx.moveTo(X(T[i]), Y(curve.intensity[i]))));
      ctx.stroke();
    }
    // last point pulses
    const li = T.indexOf(Math.round((cur.live.lastTime ?? T.at(-1)) * 100) / 100);
    const i = li >= 0 ? li : T.length - 1;
    ctx.fillStyle = intensityColor(curve.intensity[i]);
    ctx.beginPath();
    ctx.arc(X(T[i]), Y(curve.intensity[i]), 4.5, 0, 7);
    ctx.fill();
    // aggregated score line
    const score = cur.final?.score ?? cur.live.scoring?.score;
    if (score != null) {
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m.l, Y(score) + 0.5);
      ctx.lineTo(m.l + pw, Y(score) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = TEXT;
      ctx.textAlign = "left";
      ctx.font = `600 10px ${FONT}`;
      ctx.fillText(`score ${Math.round(score)}`, m.l + 4, Y(score) - 4);
    }
  }
  // probe markers
  for (const p of cur.probes ?? []) {
    if (p.score == null) continue;
    ctx.strokeStyle = intensityColor(p.score);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(X(p.pos + p.len / 2), Y(p.score), 5, 0, 7);
    ctx.stroke();
  }
  if (position != null) {
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(X(position) - 0.5, m.t, 1, ph);
  }
}

// ---------------------------------------------------------------- radar

export function drawRadar(canvas, { current, aggregate }) {
  const { ctx, w, h } = fit(canvas);
  const cx = w / 2, cy = h / 2 + 2, r = Math.max(30, Math.min(w / 2 - 88, h / 2 - 40));
  const n = DIMENSIONS.length;
  const pt = (i, v) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r * (v / 100), cy + Math.sin(a) * r * (v / 100)];
  };
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  for (const lv of [25, 50, 75, 100]) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const [x, y] = pt(i % n, lv);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  ctx.font = `600 10.5px ${FONT}`;
  DIMENSIONS.forEach((d, i) => {
    const [x, y] = pt(i, 100);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
    const [lx, ly] = pt(i, 114);
    ctx.fillStyle = DIM_COLORS[d.key];
    ctx.textAlign = Math.abs(lx - cx) < 8 ? "center" : lx > cx ? "left" : "right";
    ctx.fillText(d.label, lx, ly + 4);
    if (current?.[d.key] != null) {
      ctx.fillStyle = MUTED;
      ctx.font = `10px ${FONT}`;
      ctx.fillText(String(Math.round(current[d.key])), lx, ly + 16);
      ctx.font = `600 10.5px ${FONT}`;
    }
  });
  const poly = (vals, fill, stroke, dash) => {
    ctx.beginPath();
    DIMENSIONS.forEach((d, i) => {
      const [x, y] = pt(i, vals[d.key] ?? 0);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.setLineDash(dash ?? []);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (aggregate) poly(aggregate, null, "rgba(255,255,255,0.75)", [4, 3]);
  if (current) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "rgba(56,189,248,0.10)");
    g.addColorStop(1, "rgba(244,63,94,0.45)");
    poly(current, g, "#fb7185");
  }
}

// ---------------------------------------------------------------- spectrum & spectrogram

const F_LO = 25, F_HI = 18000;

export class SpectrumView {
  constructor(bands = 96) {
    this.n = bands;
    this.peaks = new Float32Array(bands);
    this.levels = new Float32Array(bands);
    this.data = null;
  }

  /** Band levels (0..1) from the analyser, log-spaced. */
  read(analyser) {
    const bins = analyser.frequencyBinCount;
    if (!this.data || this.data.length !== bins) this.data = new Float32Array(bins);
    analyser.getFloatFrequencyData(this.data);
    const hz = analyser.context.sampleRate / analyser.fftSize;
    const min = analyser.minDecibels, max = analyser.maxDecibels;
    for (let b = 0; b < this.n; b++) {
      const f0 = F_LO * (F_HI / F_LO) ** (b / this.n);
      const f1 = F_LO * (F_HI / F_LO) ** ((b + 1) / this.n);
      const k0 = Math.max(1, Math.floor(f0 / hz)), k1 = Math.max(k0, Math.min(bins - 1, Math.ceil(f1 / hz)));
      let m = -Infinity;
      for (let k = k0; k <= k1; k++) if (this.data[k] > m) m = this.data[k];
      // gentle tilt (+3 dB/oct) so music looks flat-ish
      const tilt = 3 * Math.log2(Math.sqrt(f0 * f1) / 1000);
      const v = Math.max(0, Math.min(1, (m + tilt - min) / (max - min)));
      this.levels[b] = v;
    }
    return this.levels;
  }

  draw(canvas, analyser) {
    const { ctx, w, h } = fit(canvas);
    if (!analyser) return drawEmpty(ctx, w, h, "Capture inactive");
    const lv = this.read(analyser);
    const bw = w / this.n;
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, "#3b82f6");
    grad.addColorStop(0.4, "#06b6d4");
    grad.addColorStop(0.7, "#facc15");
    grad.addColorStop(0.88, "#f97316");
    grad.addColorStop(1, "#f43f5e");
    ctx.fillStyle = grad;
    for (let b = 0; b < this.n; b++) {
      const v = lv[b];
      this.peaks[b] = Math.max(v, this.peaks[b] - 0.006);
      const bh = v * (h - 14);
      ctx.fillRect(b * bw + 0.5, h - 12 - bh, Math.max(1, bw - 1.5), bh);
    }
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (let b = 0; b < this.n; b++) if (this.peaks[b] > 0.02) ctx.fillRect(b * bw + 0.5, h - 12 - this.peaks[b] * (h - 14) - 2, Math.max(1, bw - 1.5), 2);
    ctx.fillStyle = MUTED;
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = "center";
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * w;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, h - 1);
    }
  }
}

const LUT = (() => {
  // inferno-like colour map
  const stops = [[0, [0, 0, 4]], [0.25, [60, 9, 101]], [0.5, [177, 50, 90]], [0.72, [237, 105, 37]], [0.9, [251, 180, 26]], [1, [252, 255, 164]]];
  const out = [];
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let j = 1;
    while (stops[j][0] < x) j++;
    const [x0, c0] = stops[j - 1], [x1, c1] = stops[j];
    const t = (x - x0) / (x1 - x0);
    out.push(c0.map((c, k) => Math.round(c + (c1[k] - c) * t)));
  }
  return out;
})();

export class Spectrogram {
  constructor() {
    this.img = null;
    this.buf = null;
    this.spec = new SpectrumView(160);
  }

  draw(canvas, analyser, advance = 2) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round((canvas.clientHeight || 120) * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
      const c = canvas.getContext("2d");
      c.fillStyle = "#000004";
      c.fillRect(0, 0, W, H);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!analyser) return;
    const lv = this.spec.read(analyser);
    const a = Math.max(1, Math.round(advance * dpr));
    ctx.drawImage(canvas, a, 0, W - a, H, 0, 0, W - a, H);
    if (!this.col || this.col.height !== H || this.col.width !== a) this.col = ctx.createImageData(a, H);
    const d = this.col.data;
    for (let y = 0; y < H; y++) {
      const b = Math.min(lv.length - 1, Math.floor(((H - 1 - y) / H) * lv.length));
      const c = LUT[Math.min(255, Math.round(Math.pow(lv[b], 1.4) * 255))];
      for (let x = 0; x < a; x++) {
        const o = (y * a + x) * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    ctx.putImageData(this.col, W - a, 0);
  }
}

// ---------------------------------------------------------------- meters

export class Meters {
  constructor() {
    this.buf = null;
    this.hold = [-90, -90];
    this.holdAt = [0, 0];
    this.smooth = [-90, -90];
  }

  peakDb(an) {
    if (!this.buf || this.buf.length !== an.fftSize) this.buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (const v of this.buf) { const x = v < 0 ? -v : v; if (x > p) p = x; }
    return 20 * Math.log10(p + 1e-9);
  }

  draw(canvas, cap, loud, t) {
    const { ctx, w, h } = fit(canvas);
    const top = 8, bottom = h - 18, H = bottom - top;
    const bars = [
      { label: "L", db: cap ? this.peakDb(cap.left) : -90, lo: -60, hi: 0, i: 0 },
      { label: "R", db: cap ? this.peakDb(cap.right) : -90, lo: -60, hi: 0, i: 1 },
      { label: "M", db: loud?.momentary ?? -90, lo: -40, hi: 0 },
      { label: "S", db: loud?.shortTerm ?? -90, lo: -40, hi: 0 },
    ];
    const bw = (w - 30) / bars.length;
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = "center";
    bars.forEach((b, k) => {
      const x = 28 + k * bw + 3;
      const width = bw - 8;
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(x, top, width, H);
      let v = b.db;
      if (b.i != null) {
        this.smooth[b.i] = Math.max(v, this.smooth[b.i] - 1.2);
        v = this.smooth[b.i];
        if (b.db > this.hold[b.i] || t - this.holdAt[b.i] > 1500) { this.hold[b.i] = b.db; this.holdAt[b.i] = t; }
      }
      const frac = Math.max(0, Math.min(1, (v - b.lo) / (b.hi - b.lo)));
      const g = ctx.createLinearGradient(0, bottom, 0, top);
      g.addColorStop(0, "#22c55e");
      g.addColorStop(0.7, "#eab308");
      g.addColorStop(0.9, "#ef4444");
      ctx.fillStyle = g;
      ctx.fillRect(x, bottom - frac * H, width, frac * H);
      if (b.i != null) {
        const hf = Math.max(0, Math.min(1, (this.hold[b.i] - b.lo) / (b.hi - b.lo)));
        ctx.fillStyle = "#fff";
        ctx.fillRect(x, bottom - hf * H - 1, width, 2);
      }
      ctx.fillStyle = MUTED;
      ctx.fillText(b.label, x + width / 2, h - 5);
    });
    // scales: dBFS for L/R, LUFS for M/S
    ctx.textAlign = "right";
    ctx.fillStyle = MUTED;
    for (const d of [0, -12, -24, -36, -48, -60]) ctx.fillText(String(d), 24, bottom - ((d + 60) / 60) * H + 3);
  }
}

// ---------------------------------------------------------------- session histogram

export function drawHistogram(canvas, scores) {
  const { ctx, w, h } = fit(canvas);
  const counts = STAGES.map(() => 0);
  for (const s of scores) counts[STAGES.indexOf(stageFor(s))]++;
  const max = Math.max(1, ...counts);
  const m = { l: 6, r: 6, t: 14, b: 34 };
  const bw = (w - m.l - m.r) / STAGES.length;
  const cs = getComputedStyle(canvas);
  const text = cs.getPropertyValue("--text").trim() || "#000";
  const muted = cs.getPropertyValue("--muted").trim() || "#777";
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = "center";
  STAGES.forEach((s, i) => {
    const next = STAGES[i + 1]?.min ?? 100;
    const bh = (counts[i] / max) * (h - m.t - m.b);
    const x = m.l + i * bw + 3;
    ctx.fillStyle = intensityColor((s.min + next) / 2);
    roundRect(ctx, x, h - m.b - bh, bw - 6, Math.max(bh, 2), 4);
    ctx.fill();
    ctx.fillStyle = text;
    if (counts[i]) ctx.fillText(String(counts[i]), x + (bw - 6) / 2, h - m.b - bh - 3);
    ctx.fillStyle = muted;
    const words = s.label.split(" / ");
    words.forEach((wd, k) => ctx.fillText(wd.length > 11 ? `${wd.slice(0, 10)}.` : wd, x + (bw - 6) / 2, h - m.b + 13 + k * 11));
  });
}

// ---------------------------------------------------------------- helpers

export function sparkSvg(values, color, lo = null, hi = null) {
  const v = values.filter(Number.isFinite).slice(-40);
  if (v.length < 2) return `<svg viewBox="0 0 100 26" preserveAspectRatio="none"></svg>`;
  const a = lo ?? Math.min(...v), b = hi ?? Math.max(...v);
  const span = b - a || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * 100).toFixed(1)},${(24 - ((x - a) / span) * 22).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 100 26" preserveAspectRatio="none"><polyline points="0,26 ${pts} 100,26" fill="${color}" fill-opacity="0.12" stroke="none"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

function drawEmpty(ctx, w, h, text) {
  ctx.fillStyle = MUTED;
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText(text, w / 2, h / 2);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export { fmtTime };
