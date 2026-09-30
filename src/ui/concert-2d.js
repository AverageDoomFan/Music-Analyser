// Concert mode: Canvas2D fallback when WebGL2 is unavailable. Same frame
// input as the WebGL renderer, a lighter show: heat-coloured glow, trails by
// fading instead of clearing, the radial spectrum, the waveform ring, a few
// hundred particles, shake and flashes.

import { BURST_SLOTS } from "./concert-gl.js";

const MAX_PARTICLES = 700;

export function create2DRenderer(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  let W = 0, H = 0;
  // particle pool (struct of arrays, no per-frame allocation)
  const px = new Float32Array(MAX_PARTICLES), py = new Float32Array(MAX_PARTICLES);
  const vx = new Float32Array(MAX_PARTICLES), vy = new Float32Array(MAX_PARTICLES);
  const life = new Float32Array(MAX_PARTICLES), col = new Array(MAX_PARTICLES).fill("#fff");
  let next = 0;
  const seen = new Float64Array(BURST_SLOTS).fill(-1);
  let lastTime = 0;
  const rgb = (c, a = 1, k = 1) => `rgba(${Math.round(Math.min(1, c[0] * k) * 255)},${Math.round(Math.min(1, c[1] * k) * 255)},${Math.round(Math.min(1, c[2] * k) * 255)},${a})`;

  function spawn(b, n) {
    const color = rgb([b.r, b.g, b.b], 1, 1.2);
    for (let i = 0; i < n; i++) {
      const k = next;
      next = (next + 1) % MAX_PARTICLES;
      const a = Math.random() * Math.PI * 2;
      const sp = (0.2 + Math.random() ** 2 * 1.4) * (0.5 + b.s) * (b.kind ? 1 : 0.5);
      const r0 = b.kind ? 0.26 : 0;
      px[k] = b.x + Math.cos(a) * r0;
      py[k] = b.y + Math.sin(a) * r0;
      vx[k] = Math.cos(a) * sp;
      vy[k] = Math.sin(a) * sp;
      life[k] = 0.6 + Math.random() * 1.2;
      col[k] = color;
    }
  }

  return {
    kind: "canvas2d",
    lost: () => false,
    resize(w, h) {
      W = Math.max(2, Math.round(w));
      H = Math.max(2, Math.round(h));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    },
    render(f) {
      const dt = Math.min(0.05, Math.max(0, f.time - lastTime));
      lastTime = f.time;
      const pal = f.palette;
      const S = H / 2; // particle unit: half the height (as in WebGL)
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // fade the previous frame (trails)
      ctx.globalCompositeOperation = "source-over";
      const fade = 0.28 + 0.2 * (1 - f.heat); // per 1/60 s: trails last as long at any frame rate
      ctx.fillStyle = rgb(pal.shadow, 1 - Math.pow(1 - fade, Math.max(0.25, dt * 60)));
      ctx.fillRect(0, 0, W, H);
      const cx = W / 2 + f.shake[0] * W, cy = H / 2 - f.shake[1] * H;
      // glow
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
      g.addColorStop(0, rgb(pal.accent, 0.25 + 0.35 * (f.bass + f.kick) * (1 - f.idle * 0.7)));
      g.addColorStop(0.35, rgb(pal.base, 0.12 + 0.12 * f.heat));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      // radial spectrum, mirrored
      ctx.translate(cx, cy);
      const R = f.ringR * H, bars = 48; // ring unit: the height (as in WebGL)
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(2, (Math.PI * R) / bars * 0.55);
      for (let i = 0; i < bars; i++) {
        const v = f.spectrum[Math.floor(((i + 0.5) / bars) * 0.92 * f.spectrum.length + 0.02 * f.spectrum.length)];
        const len = f.ringH * v * H;
        if (len < 1) continue;
        const a = ((i + 0.5) / bars) * Math.PI;
        ctx.strokeStyle = rgb(i / bars < 0.5 ? pal.base : pal.accent, 0.35 + 0.6 * v, 1.2);
        for (const sgn of [-1, 1]) {
          const sx = Math.sin(a) * sgn, sy = Math.cos(a);
          ctx.beginPath();
          ctx.moveTo(sx * R, sy * R);
          ctx.lineTo(sx * (R + len), sy * (R + len));
          ctx.stroke();
        }
      }
      // waveform ring
      ctx.beginPath();
      const n = 128;
      for (let i = 0; i <= n; i++) {
        const u = i / n, a = u * Math.PI * 2;
        const m = u <= 0.5 ? u * 2 : (1 - u) * 2;
        const r = (f.ringR * 0.8 + f.wave[Math.floor(m * (f.wave.length - 1))] * (0.05 + 0.1 * f.loud)) * H;
        const x = Math.sin(a) * r, y = Math.cos(a) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgb(pal.accent, 0.5 + 0.5 * f.loud, 1.4);
      ctx.stroke();
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // particles
      for (let i = 0; i < BURST_SLOTS; i++) {
        const b = f.bursts[i];
        if (b.s > 0 && b.t !== seen[i]) { seen[i] = b.t; spawn(b, Math.round((b.kind ? 110 : 40) * (0.4 + b.s))); }
      }
      for (let k = 0; k < MAX_PARTICLES; k++) {
        if (life[k] <= 0) continue;
        life[k] -= dt;
        const drag = Math.exp(-dt * 2.6);
        vx[k] *= drag; vy[k] *= drag;
        vy[k] -= 0.12 * dt;
        px[k] += vx[k] * dt; py[k] += vy[k] * dt;
        const a = Math.max(0, Math.min(1, life[k]));
        ctx.globalAlpha = a;
        ctx.fillStyle = col[k];
        const s = 1.5 + 2.5 * a;
        ctx.fillRect(cx + px[k] * S - s / 2, cy - py[k] * S - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (f.flash > 0.01) {
        ctx.fillStyle = `rgba(255,248,240,${Math.min(0.6, f.flash * 0.6)})`;
        ctx.fillRect(0, 0, W, H);
      }
      if (f.hot > 0) {
        ctx.fillStyle = `rgba(255,255,255,${f.hot * 0.12})`;
        ctx.fillRect(0, 0, W, H);
      }
    },
    dispose() {},
  };
}
