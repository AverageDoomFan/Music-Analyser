// Target-curve editor (canvas): drag points, click to add, double-click (or
// right-click) to remove. Also draws the generated set over the curve.

import { STAGES } from "../config.js";
import { curveAt } from "../playlist/set.js";
import { intensityColor } from "./live-draw.js";
import { t as tr } from "../i18n/index.js";

export class CurveEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{points:number[][], onChange:(points)=>void}} o
   */
  constructor(canvas, { points, onChange }) {
    this.c = canvas;
    this.points = points.map((p) => [...p]);
    this.onChange = onChange;
    this.steps = null;       // generated set: [{startAt, duration, score}]
    this.total = 0;
    this.drag = -1;
    this.hover = -1;
    this.m = { l: 34, r: 12, t: 10, b: 22 };
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", () => this.up());
    canvas.addEventListener("pointerleave", () => { this.hover = -1; if (this.drag < 0) this.draw(); });
    canvas.addEventListener("dblclick", (e) => this.remove(e));
    canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); this.remove(e); });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setPoints(points) {
    this.points = points.map((p) => [...p]);
    this.draw();
  }

  setSet(steps, total) {
    this.steps = steps;
    this.total = total;
    this.draw();
  }

  geom() {
    const w = this.c.clientWidth, h = this.c.clientHeight;
    const { l, r, t, b } = this.m;
    return { w, h, pw: w - l - r, ph: h - t - b };
  }

  toXY([x, y]) {
    const { pw, ph } = this.geom();
    return [this.m.l + x * pw, this.m.t + ph - (y / 100) * ph];
  }

  fromEvent(e) {
    const rect = this.c.getBoundingClientRect();
    const { pw, ph } = this.geom();
    const x = (e.clientX - rect.left - this.m.l) / pw;
    const y = 100 - ((e.clientY - rect.top - this.m.t) / ph) * 100;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(100, y))];
  }

  nearest(e) {
    const rect = this.c.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best = -1, bd = 14;
    this.points.forEach((p, i) => {
      const [x, y] = this.toXY(p);
      const d = Math.hypot(x - px, y - py);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  down(e) {
    if (e.button !== 0) return;
    let i = this.nearest(e);
    if (i < 0) {
      this.points.push(this.fromEvent(e));
      this.points.sort((a, b) => a[0] - b[0]);
      i = this.nearest(e);
    }
    this.drag = i;
    this.c.setPointerCapture(e.pointerId);
    this.draw();
  }

  move(e) {
    if (this.drag < 0) {
      const h = this.nearest(e);
      if (h !== this.hover) { this.hover = h; this.c.style.cursor = h >= 0 ? "grab" : "crosshair"; this.draw(); }
      return;
    }
    const [x, y] = this.fromEvent(e);
    const i = this.drag;
    // keep the order of points; the first and last stay at the edges
    const lo = i === 0 ? 0 : this.points[i - 1][0] + 0.01;
    const hi = i === this.points.length - 1 ? 1 : this.points[i + 1][0] - 0.01;
    this.points[i] = [i === 0 ? 0 : i === this.points.length - 1 ? 1 : Math.max(lo, Math.min(hi, x)), Math.round(y)];
    this.draw();
  }

  up() {
    if (this.drag < 0) return;
    this.drag = -1;
    this.onChange(this.points.map((p) => [...p]));
  }

  remove(e) {
    const i = this.nearest(e);
    if (i <= 0 || i >= this.points.length - 1 || this.points.length <= 2) return;
    this.points.splice(i, 1);
    this.draw();
    this.onChange(this.points.map((p) => [...p]));
  }

  draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { w, h, pw, ph } = this.geom();
    if (!w || !h) return;
    if (this.c.width !== Math.round(w * dpr) || this.c.height !== Math.round(h * dpr)) {
      this.c.width = Math.round(w * dpr);
      this.c.height = Math.round(h * dpr);
    }
    const ctx = this.c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(this.c);
    const muted = cs.getPropertyValue("--muted").trim() || "#777";
    const grid = cs.getPropertyValue("--grid").trim() || "#ddd";
    const text = cs.getPropertyValue("--text").trim() || "#000";
    const { l, t } = this.m;
    const Y = (v) => t + ph - (v / 100) * ph;
    STAGES.forEach((s, i) => {
      const top = STAGES[i + 1]?.min ?? 100;
      ctx.fillStyle = intensityColor((s.min + top) / 2, 0.07 + (i % 2) * 0.04);
      ctx.fillRect(l, Y(top), pw, Y(s.min) - Y(top));
    });
    ctx.strokeStyle = grid;
    ctx.fillStyle = muted;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    for (const v of [0, 25, 50, 75, 100]) {
      ctx.beginPath();
      ctx.moveTo(l, Y(v) + 0.5);
      ctx.lineTo(l + pw, Y(v) + 0.5);
      ctx.stroke();
      ctx.fillText(String(v), l - 6, Y(v) + 3);
    }
    // generated set: one bar per track over its playing time
    if (this.steps?.length && this.total) {
      for (const s of this.steps) {
        const x0 = l + (s.startAt / this.total) * pw, x1 = l + ((s.startAt + (s.duration ?? 200)) / this.total) * pw;
        ctx.fillStyle = intensityColor(s.score, 0.85);
        ctx.fillRect(x0 + 0.5, Y(s.score), Math.max(1, x1 - x0 - 1), 4);
        ctx.fillStyle = intensityColor(s.score, 0.15);
        ctx.fillRect(x0 + 0.5, Y(s.score) + 4, Math.max(1, x1 - x0 - 1), Y(0) - Y(s.score) - 4);
      }
      ctx.textAlign = "center";
      ctx.fillStyle = muted;
      const mins = this.total / 60;
      const step = mins > 120 ? 30 : mins > 45 ? 15 : mins > 15 ? 5 : 1;
      for (let m = 0; m <= mins; m += step) ctx.fillText(`${m} min`, l + ((m * 60) / this.total) * pw, h - 6);
    } else {
      ctx.textAlign = "center";
      ctx.fillStyle = muted;
      ctx.fillText(tr("start"), l + 16, h - 6);
      ctx.fillText(tr("end"), l + pw - 10, h - 6);
    }
    // target curve
    ctx.strokeStyle = text;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let i = 0; i <= 200; i++) {
      const x = i / 200;
      const [px, py] = this.toXY([x, curveAt(this.points, x)]);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    this.points.forEach((p, i) => {
      const [x, y] = this.toXY(p);
      ctx.beginPath();
      ctx.arc(x, y, i === this.drag || i === this.hover ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = intensityColor(p[1]);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = text;
      ctx.stroke();
    });
  }
}
