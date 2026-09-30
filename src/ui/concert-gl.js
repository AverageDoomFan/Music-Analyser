// Concert mode: the WebGL2 renderer. Passes per frame:
//   1. background (half res): nebula → hyperspace tunnel
//   2. trails (full res, ping-pong feedback) + spectrum ring + waveform
//   3. GPU particles (bursts + star field), MAX-blended into the trails
//   4. bloom: bright pass (half) → blur → quarter → blur
//   5. composite to the screen (shake, glitch, chromatic aberration, grade)
// Every buffer is allocated once per size; nothing is allocated per frame.

import { FULLSCREEN_VS, BG_FS, TRAIL_FS, PARTICLE_VS, PARTICLE_FS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS } from "./concert-shaders.js";

export const DATA_WIDTH = 512;
export const BURST_SLOTS = 8;
const PER_BURST = 700;
const STARS = 5000;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader: ${log}`);
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  const a = compile(gl, gl.VERTEX_SHADER, vs);
  const b = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, a);
  gl.attachShader(p, b);
  gl.linkProgram(p);
  gl.deleteShader(a);
  gl.deleteShader(b);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  // uniform locations, looked up once
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, "");
    u[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {null | {kind:"webgl2", resize(w:number,h:number):void, render(f:object):void, dispose():void, lost():boolean}}
 */
export function createGLRenderer(canvas) {
  let gl;
  try {
    gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
  } catch { gl = null; }
  if (!gl) return null;

  let P, vao, dataTex, dataBuf, fmt, targets = null, ping = 0, contextLost = false;
  const W = { w: 0, h: 0 };

  function init() {
    const hdr = !!gl.getExtension("EXT_color_buffer_float");
    fmt = hdr ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    P = {
      bg: program(gl, FULLSCREEN_VS, BG_FS),
      trail: program(gl, FULLSCREEN_VS, TRAIL_FS),
      part: program(gl, PARTICLE_VS, PARTICLE_FS),
      bright: program(gl, FULLSCREEN_VS, BRIGHT_FS),
      blur: program(gl, FULLSCREEN_VS, BLUR_FS),
      comp: program(gl, FULLSCREEN_VS, COMPOSITE_FS),
    };
    vao = gl.createVertexArray();
    dataTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, DATA_WIDTH, 2, 0, gl.RED, gl.FLOAT, null);
    texParams(gl.LINEAR);
    dataBuf = new Float32Array(DATA_WIDTH * 2);
    targets = null;
    W.w = W.h = 0;
  }

  function texParams(filter) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function target(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, gl.RGBA, fmt.type, null);
    texParams(gl.LINEAR);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && fmt.internal !== gl.RGBA8) {
      // half-float not renderable after all: fall back to 8 bits
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(tex);
      fmt = { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
      return target(w, h);
    }
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, w, h };
  }

  function freeTargets() {
    if (!targets) return;
    for (const t of Object.values(targets).flat()) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    targets = null;
  }

  function resize(w, h) {
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (targets && W.w === w && W.h === h) return;
    freeTargets();
    W.w = w; W.h = h;
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    const qw = Math.ceil(w / 4), qh = Math.ceil(h / 4);
    targets = {
      bg: [target(hw, hh)],
      trail: [target(w, h), target(w, h)],
      half: [target(hw, hh), target(hw, hh)],
      quarter: [target(qw, qh), target(qw, qh)],
    };
  }

  const bind = (t) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : W.w, t ? t.h : W.h);
  };
  const tex = (unit, t, loc) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(loc, unit);
  };
  const tri = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
  const v3 = (loc, c) => gl.uniform3f(loc, c[0], c[1], c[2]);

  const burstPos = new Float32Array(BURST_SLOTS * 4);
  const burstCol = new Float32Array(BURST_SLOTS * 4);

  /**
   * @param {object} f  frame (see concert.js: buildFrame)
   */
  function render(f) {
    if (contextLost || !targets) return;
    const { w, h } = W;
    const pal = f.palette;
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);

    // spectrum + waveform
    dataBuf.set(f.spectrum, 0);
    dataBuf.set(f.wave, DATA_WIDTH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DATA_WIDTH, 2, gl.RED, gl.FLOAT, dataBuf);

    // 1. background
    let pr = P.bg;
    gl.useProgram(pr.p);
    bind(targets.bg[0]);
    gl.uniform2f(pr.u.u_res, targets.bg[0].w, targets.bg[0].h);
    gl.uniform1f(pr.u.u_time, f.time);
    gl.uniform1f(pr.u.u_travel, f.travel);
    gl.uniform1f(pr.u.u_heat, f.heat);
    gl.uniform1f(pr.u.u_hot, f.hot);
    gl.uniform1f(pr.u.u_turb, f.drive.turbulence);
    gl.uniform1f(pr.u.u_kick, f.kick);
    gl.uniform1f(pr.u.u_bass, f.bass);
    gl.uniform1f(pr.u.u_tunnel, f.tunnel);
    gl.uniform1f(pr.u.u_idle, f.idle);
    gl.uniform1f(pr.u.u_sparkle, f.drive.sparkle);
    gl.uniform1f(pr.u.u_tension, f.tension ?? 0);
    v3(pr.u.u_base, pal.base); v3(pr.u.u_accent, pal.accent); v3(pr.u.u_shadow, pal.shadow);
    tri();

    // 2. trails: feedback + ring
    const prev = targets.trail[ping], cur = targets.trail[1 - ping];
    ping = 1 - ping;
    pr = P.trail;
    gl.useProgram(pr.p);
    bind(cur);
    tex(0, prev.tex, pr.u.u_prev);
    tex(1, dataTex, pr.u.u_data);
    gl.uniform2f(pr.u.u_res, w, h);
    gl.uniform1f(pr.u.u_time, f.time);
    gl.uniform1f(pr.u.u_zoom, f.zoom);
    gl.uniform1f(pr.u.u_rot, f.rot);
    gl.uniform1f(pr.u.u_decay, f.decay);
    gl.uniform1f(pr.u.u_fade, f.fade);
    gl.uniform2f(pr.u.u_shock, f.shock[0], f.shock[1]);
    gl.uniform2f(pr.u.u_shock2, f.shock2?.[0] ?? 9, f.shock2?.[1] ?? 0);
    gl.uniform1f(pr.u.u_tension, f.tension ?? 0);
    gl.uniform1f(pr.u.u_turb, f.drive.turbulence);
    gl.uniform1f(pr.u.u_heat, f.heat);
    gl.uniform1f(pr.u.u_hot, f.hot);
    gl.uniform1f(pr.u.u_kick, f.kick);
    gl.uniform1f(pr.u.u_loud, f.loud);
    gl.uniform1f(pr.u.u_ringR, f.ringR);
    gl.uniform1f(pr.u.u_ringH, f.ringH);
    gl.uniform1f(pr.u.u_idle, f.idle);
    v3(pr.u.u_base, pal.base); v3(pr.u.u_accent, pal.accent);
    tri();

    // 3. particles, MAX blend (bounded brightness, like the trails)
    pr = P.part;
    gl.useProgram(pr.p);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    for (let i = 0; i < BURST_SLOTS; i++) {
      const b = f.bursts[i];
      const k = i * 4;
      burstPos[k] = b.x; burstPos[k + 1] = b.y; burstPos[k + 2] = b.t; burstPos[k + 3] = b.s;
      burstCol[k] = b.r; burstCol[k + 1] = b.g; burstCol[k + 2] = b.b; burstCol[k + 3] = b.kind;
    }
    gl.uniform4fv(pr.u.u_burst, burstPos);
    gl.uniform4fv(pr.u.u_bcol, burstCol);
    gl.uniform1i(pr.u.u_perBurst, PER_BURST);
    gl.uniform1i(pr.u.u_stars, STARS);
    gl.uniform1f(pr.u.u_time, f.time);
    gl.uniform1f(pr.u.u_travel, f.travel);
    gl.uniform1f(pr.u.u_aspect, w / h);
    gl.uniform1f(pr.u.u_heat, f.heat);
    gl.uniform1f(pr.u.u_hot, f.hot);
    gl.uniform1f(pr.u.u_density, f.drive.density);
    gl.uniform1f(pr.u.u_px, Math.max(1, h / 720));
    gl.uniform1f(pr.u.u_starBright, f.starBright);
    v3(pr.u.u_accent, pal.accent);
    gl.drawArrays(gl.POINTS, 0, PER_BURST * BURST_SLOTS + STARS);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);

    // 4. bloom
    const [h0, h1] = targets.half, [q0, q1] = targets.quarter;
    pr = P.bright;
    gl.useProgram(pr.p);
    bind(h0);
    tex(0, targets.bg[0].tex, pr.u.u_bg);
    tex(1, cur.tex, pr.u.u_trail);
    gl.uniform2f(pr.u.u_texel, 1 / w, 1 / h);
    gl.uniform1f(pr.u.u_thr, f.bloomThreshold);
    tri();
    pr = P.blur;
    gl.useProgram(pr.p);
    const blur = (src, dst, dx, dy) => {
      bind(dst);
      tex(0, src.tex, pr.u.u_src);
      gl.uniform2f(pr.u.u_dir, dx / src.w, dy / src.h);
      tri();
    };
    blur(h0, h1, 1, 0);
    blur(h1, h0, 0, 1);
    blur(h0, q0, 0.5, 0.5); // downsample with a little spread
    blur(q0, q1, 1.6, 0);
    blur(q1, q0, 0, 1.6);
    blur(q0, q1, 3, 0);
    blur(q1, q0, 0, 3);

    // 5. composite
    pr = P.comp;
    gl.useProgram(pr.p);
    bind(null);
    tex(0, targets.bg[0].tex, pr.u.u_bg);
    tex(1, cur.tex, pr.u.u_trail);
    tex(2, h0.tex, pr.u.u_b1);
    tex(3, q0.tex, pr.u.u_b2);
    gl.uniform2f(pr.u.u_res, w, h);
    gl.uniform2f(pr.u.u_shake, f.shake[0], f.shake[1]);
    gl.uniform1f(pr.u.u_time, f.time);
    gl.uniform1f(pr.u.u_ca, f.ca);
    gl.uniform1f(pr.u.u_bloom, f.bloom);
    gl.uniform1f(pr.u.u_exposure, f.exposure);
    gl.uniform1f(pr.u.u_hot, f.hot);
    gl.uniform1f(pr.u.u_flash, f.flash);
    gl.uniform1f(pr.u.u_grain, f.grain);
    gl.uniform1f(pr.u.u_glitch, f.glitch);
    gl.uniform1f(pr.u.u_idle, f.idle);
    gl.uniform1f(pr.u.u_tension, f.tension ?? 0);
    const cam = f.cam ?? [0, 0, 1, 0];
    gl.uniform4f(pr.u.u_cam, cam[0], cam[1], cam[2], cam[3]);
    v3(pr.u.u_accent, pal.accent);
    tri();
  }

  const onLost = (e) => { e.preventDefault(); contextLost = true; };
  const onRestored = () => {
    contextLost = false;
    const { w, h } = W;
    init();
    resize(w, h);
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  try {
    init();
  } catch (err) {
    console.warn("Concert mode: WebGL2 unavailable, Canvas2D fallback.", err);
    return null;
  }

  return {
    kind: "webgl2",
    resize,
    render,
    lost: () => contextLost,
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (!contextLost) {
        freeTargets();
        for (const x of Object.values(P)) gl.deleteProgram(x.p);
        gl.deleteTexture(dataTex);
        gl.deleteVertexArray(vao);
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
