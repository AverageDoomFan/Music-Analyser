// Small dependency-free SVG chart: scores along an order (rank or playlist
// position), with perceptual stage bands, crosshair + tooltip on hover.

import { STAGES } from "../config.js";
import { escapeHtml } from "../util/format.js";

const NS = "http://www.w3.org/2000/svg";

/**
 * @param {HTMLElement} container
 * @param {{id:string,label:string,score:number,flag?:boolean}[]} points
 * @param {{height?:number, onSelect?:(id:string)=>void, xLabel?:string}} opts
 */
export function renderScoreChart(container, points, opts = {}) {
  container.classList.add("chart");
  const draw = () => drawChart(container, points, opts);
  draw();
  container._ro?.disconnect();
  if ("ResizeObserver" in window) {
    let lastWidth = container.clientWidth;
    container._ro = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - lastWidth) < 4) return;
      lastWidth = container.clientWidth;
      draw();
    });
    container._ro.observe(container);
  }
}

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.append(n);
  return n;
}

function drawChart(container, points, { height = 200, onSelect, xLabel = "" }) {
  container.innerHTML = "";
  const width = Math.max(280, container.clientWidth || 600);
  const m = { top: 10, right: 12, bottom: 24, left: 34 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Scores dans l'ordre" }, container);
  const g = el("g", { transform: `translate(${m.left},${m.top})` }, svg);
  const y = (s) => h - (s / 100) * h;
  const n = points.length;
  const x = (i) => (n <= 1 ? w / 2 : (i / (n - 1)) * w);

  // alternate stage bands (recessive), labelled on the right when there is room
  STAGES.forEach((s, i) => {
    const top = STAGES[i + 1]?.min ?? 100;
    if (i % 2 === 1) el("rect", { class: "stage-band", x: 0, y: y(top), width: w, height: y(s.min) - y(top) }, g);
    if (w > 420 && y(s.min) - y(top) >= 12) {
      const t = el("text", { class: "stage-label", x: w - 4, y: (y(s.min) + y(top)) / 2 + 4, "text-anchor": "end" }, g);
      t.textContent = s.label;
    }
  });
  const grid = el("g", { class: "grid axis" }, g);
  for (const v of [0, 25, 50, 75, 100]) {
    el("line", { x1: 0, x2: w, y1: y(v), y2: y(v) }, grid);
    const t = el("text", { x: -8, y: y(v) + 4, "text-anchor": "end" }, grid);
    t.textContent = v;
  }
  if (xLabel) {
    const t = el("text", { x: 0, y: h + 18, class: "stage-label" }, g);
    t.textContent = xLabel;
  }
  if (!n) return;

  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join("");
  el("path", { class: "line", d }, g);
  const r = n > 120 ? 2.5 : n > 50 ? 3 : 4;
  points.forEach((p, i) => el("circle", { class: `dot${p.flag ? " jump" : ""}`, cx: x(i), cy: y(p.score), r: p.flag ? r + 1 : r }, g));

  // hover layer
  const cross = el("line", { class: "crosshair", y1: 0, y2: h, visibility: "hidden" }, g);
  const focus = el("circle", { class: "dot", r: r + 2, visibility: "hidden" }, g);
  const hit = el("rect", { class: "hit", x: -6, y: 0, width: w + 12, height: h }, g);
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  container.append(tip);
  const nearest = (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = evt.clientX - rect.left - m.left;
    return Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : (px / w) * (n - 1))));
  };
  hit.addEventListener("pointermove", (evt) => {
    const i = nearest(evt);
    const p = points[i];
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    focus.setAttribute("cx", x(i));
    focus.setAttribute("cy", y(p.score));
    cross.setAttribute("visibility", "visible");
    focus.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `${i + 1}. ${escapeHtml(p.label)} · <b>${Math.round(p.score)}</b>`;
    const left = Math.min(Math.max(m.left + x(i), 90), width - 90);
    tip.style.left = `${left}px`;
    tip.style.top = `${m.top + y(p.score)}px`;
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    focus.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
  if (onSelect) hit.addEventListener("click", (evt) => onSelect(points[nearest(evt)].id));
}

/**
 * Curve of one value over time (track timeline).
 * @param {HTMLElement} container
 * @param {{times:number[], values:(number|null)[], min?:number, max?:number, format?:(v:number)=>string,
 *          ref?:number, refLabel?:string, height?:number, bands?:boolean, duration?:number,
 *          onSeek?:(t:number)=>void}} opts   onSeek: click on the chart (e.g. play from there)
 * The container gets `container.setPlayhead(t | null)` to show a moving playhead.
 */
export function renderTimeline(container, opts) {
  container.classList.add("chart");
  const draw = () => drawTimeline(container, opts);
  draw();
  container._ro?.disconnect();
  if ("ResizeObserver" in window) {
    let lastWidth = container.clientWidth;
    container._ro = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - lastWidth) < 4) return;
      lastWidth = container.clientWidth;
      draw();
    });
    container._ro.observe(container);
  }
}

function niceRange(values, min, max) {
  const v = values.filter(Number.isFinite);
  let lo = min ?? Math.min(...v);
  let hi = max ?? Math.max(...v);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  return [min ?? lo - pad, max ?? hi + pad];
}

function mmss(t) {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function drawTimeline(container, { times, values, min, max, format = (v) => v.toFixed(0), ref, refLabel, height = 190, bands = false, duration, onSeek }) {
  container.innerHTML = "";
  const width = Math.max(280, container.clientWidth || 600);
  const m = { top: 10, right: 12, bottom: 22, left: 44 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Courbe dans le temps" }, container);
  const g = el("g", { transform: `translate(${m.left},${m.top})` }, svg);
  const [lo, hi] = niceRange(values, min, max);
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  const t0 = 0;
  const t1 = Math.max(duration ?? times.at(-1) ?? 1, 1);
  const x = (t) => ((t - t0) / (t1 - t0)) * w;

  if (bands) {
    STAGES.forEach((s, i) => {
      const top = STAGES[i + 1]?.min ?? 100;
      if (i % 2 === 1) el("rect", { class: "stage-band", x: 0, y: y(top), width: w, height: y(s.min) - y(top) }, g);
    });
  }
  const grid = el("g", { class: "grid axis" }, g);
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    el("line", { x1: 0, x2: w, y1: y(v), y2: y(v) }, grid);
    const t = el("text", { x: -8, y: y(v) + 4, "text-anchor": "end" }, grid);
    t.textContent = format(v);
  }
  const ticks = Math.max(2, Math.min(8, Math.floor(w / 80)));
  for (let i = 0; i <= ticks; i++) {
    const tt = t0 + ((t1 - t0) * i) / ticks;
    const t = el("text", { x: x(tt), y: h + 16, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle" }, grid);
    t.textContent = mmss(tt);
  }
  if (Number.isFinite(ref)) {
    el("line", { class: "ref-line", x1: 0, x2: w, y1: y(ref), y2: y(ref) }, g);
    if (refLabel) {
      const t = el("text", { class: "stage-label", x: 4, y: y(ref) - 4 }, g);
      t.textContent = refLabel;
    }
  }
  // line with gaps for missing values (e.g. unreliable BPM) and excerpt jumps
  const hop = times.length > 1 ? times[1] - times[0] : 3;
  let d = "";
  let pen = false;
  times.forEach((t, i) => {
    const v = values[i];
    const gap = i > 0 && t - times[i - 1] > hop * 1.6;
    if (!Number.isFinite(v)) { pen = false; return; }
    d += `${pen && !gap ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  el("path", { class: "line", d }, g);
  if (times.length <= 60) times.forEach((t, i) => { if (Number.isFinite(values[i])) el("circle", { class: "dot", cx: x(t), cy: y(values[i]), r: 3 }, g); });

  const playhead = el("line", { class: "playhead", y1: 0, y2: h, visibility: "hidden" }, g);
  container.setPlayhead = (t) => {
    if (t == null || !Number.isFinite(t)) return playhead.setAttribute("visibility", "hidden");
    playhead.setAttribute("x1", x(t));
    playhead.setAttribute("x2", x(t));
    playhead.setAttribute("visibility", "visible");
  };
  const cross = el("line", { class: "crosshair", y1: 0, y2: h, visibility: "hidden" }, g);
  const focus = el("circle", { class: "dot", r: 5, visibility: "hidden" }, g);
  const hit = el("rect", { class: "hit", x: 0, y: 0, width: w, height: h }, g);
  const timeAt = (evt) => {
    const rect = svg.getBoundingClientRect();
    return Math.max(0, Math.min(t1, ((evt.clientX - rect.left - m.left) / w) * (t1 - t0) + t0));
  };
  if (onSeek) {
    hit.style.cursor = "pointer";
    hit.addEventListener("click", (evt) => onSeek(timeAt(evt)));
  }
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  container.append(tip);
  hit.addEventListener("pointermove", (evt) => {
    const rect = svg.getBoundingClientRect();
    const tt = ((evt.clientX - rect.left - m.left) / w) * (t1 - t0) + t0;
    let i = 0;
    for (let k = 1; k < times.length; k++) if (Math.abs(times[k] - tt) < Math.abs(times[i] - tt)) i = k;
    const v = values[i];
    cross.setAttribute("x1", x(times[i]));
    cross.setAttribute("x2", x(times[i]));
    cross.setAttribute("visibility", "visible");
    if (Number.isFinite(v)) {
      focus.setAttribute("cx", x(times[i]));
      focus.setAttribute("cy", y(v));
      focus.setAttribute("visibility", "visible");
    } else focus.setAttribute("visibility", "hidden");
    tip.hidden = false;
    tip.innerHTML = `${mmss(times[i])} · <b>${Number.isFinite(v) ? escapeHtml(format(v)) : "—"}</b>${onSeek ? ` <span class="muted">· clic : lire / stop</span>` : ""}`;
    tip.style.left = `${Math.min(Math.max(m.left + x(times[i]), 60), width - 60)}px`;
    tip.style.top = `${m.top + (Number.isFinite(v) ? y(v) : h / 2)}px`;
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    focus.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
}

/** Tiny inline curve (library rows), 0..100 scale. */
export function sparkline(values, { width = 72, height = 22 } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return "";
  const n = values.length;
  const pts = values.map((val, i) => `${((i / (n - 1)) * (width - 2) + 1).toFixed(1)},${(height - 1 - (Math.max(0, Math.min(100, val)) / 100) * (height - 2)).toFixed(1)}`);
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline points="${pts.join(" ")}"/></svg>`;
}
