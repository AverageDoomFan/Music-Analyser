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
