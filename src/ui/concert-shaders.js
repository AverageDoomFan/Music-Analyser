// Concert mode: GLSL ES 3.00 shaders (WebGL2), as template strings.

const HEAD = `#version 300 es
precision highp float;
`;

const NOISE = `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0., a = .5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = m * p; a *= .5; }
  return s;
}
`;

/** Fullscreen triangle, no attributes. */
export const FULLSCREEN_VS = `${HEAD}
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`;

/**
 * Background (half resolution): a flowing domain-warped nebula when calm that
 * turns into a hyperspace tunnel as the intensity rises; rings pulse on kicks.
 */
export const BG_FS = `${HEAD}
in vec2 v_uv;
out vec4 o;
uniform vec2 u_res;
uniform float u_time, u_travel, u_heat, u_hot, u_turb, u_kick, u_bass, u_tunnel, u_idle, u_sparkle;
uniform vec3 u_base, u_accent, u_shadow;
${NOISE}
void main() {
  vec2 p = (v_uv - .5) * vec2(u_res.x / u_res.y, 1.);
  float t = u_time;
  // nebula: fbm warped by fbm (the warp grows with the turbulence)
  vec2 q = vec2(fbm(p * 1.4 + vec2(0., t * .03)), fbm(p * 1.4 + vec2(5.2, 1.3) - t * .025));
  float w = 1.2 + u_turb * 2.4;
  vec2 r = vec2(fbm(p * 1.4 + q * w + vec2(1.7, 9.2) + u_travel * .07), fbm(p * 1.4 + q * w + vec2(8.3, 2.8) - u_travel * .05));
  float n = fbm(p * 1.3 + r * 2.2);
  vec3 neb = mix(u_shadow, u_base * .42, smoothstep(.4, .95, n));
  neb += u_accent * .35 * smoothstep(.6, 1.15, length(r) * n * 1.35);
  neb *= .55 + .45 * smoothstep(1.4, .1, length(p));

  // tunnel: depth = 1/radius, mirrored angle (kaleidoscopic, seamless)
  float rad = length(p);
  float ang = abs(atan(p.x, -p.y)) / 3.14159;
  float z = .32 / max(rad, .015);
  vec2 tuv = vec2(ang * 3., z + u_travel);
  float wall = fbm(tuv * vec2(1.4, .55) + r * .8);
  float streak = pow(vnoise(vec2(ang * 38., z * .35 + u_travel * .6)), 6.) * (.5 + 1. * u_sparkle);
  float rings = pow(abs(sin((z + u_travel * 1.3) * 3.14159 * .9)), 18. - 12. * u_kick);
  float fog = smoothstep(0.02, .55, rad);
  vec3 tun = mix(u_shadow * 1.3, u_base * .6, pow(smoothstep(.42, .95, wall), 1.6)) * fog;
  tun += u_accent * (streak + rings * (.12 + .7 * u_kick)) * fog * fog;
  tun += mix(u_accent, vec3(1.), .5) * .5 / (1. + rad * rad * 160.) * (.4 + u_bass);

  vec3 col = mix(neb, tun, u_tunnel);
  // light at the centre, breathing with the bass
  col += u_accent * .10 * (u_bass + u_kick) / (1. + rad * 6.);
  // white hot past 100
  float l = dot(col, vec3(.3, .55, .15));
  col = mix(col, vec3(l * .9), u_hot * .35) + vec3(1., .95, .9) * l * l * 2.2 * u_hot;
  col *= mix(1., .45, u_idle);
  o = vec4(col, 1.);
}`;

/**
 * Trails (full resolution, ping-pong): the previous frame zoomed, rotated and
 * warped (feedback), faded, plus the radial spectrum and the waveform ring.
 * Particles are drawn on top of it afterwards with a MAX blend.
 */
export const TRAIL_FS = `${HEAD}
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_prev, u_data;
uniform vec2 u_res;
uniform float u_time, u_zoom, u_rot, u_decay, u_fade, u_turb, u_heat, u_hot, u_kick, u_loud, u_ringR, u_ringH, u_idle;
uniform vec2 u_shock; // age (s), strength of the last kick
uniform vec3 u_base, u_accent;
${NOISE}
void main() {
  float asp = u_res.x / u_res.y;
  vec2 c = (v_uv - .5) * vec2(asp, 1.);
  float s = sin(u_rot), k = cos(u_rot);
  vec2 cw = mat2(k, -s, s, k) * c * u_zoom;
  cw += (vec2(vnoise(c * 2.5 + u_time * .35), vnoise(c * 2.5 + 7.1 - u_time * .3)) - .5) * .006 * u_turb;
  vec2 puv = cw / vec2(asp, 1.) + .5;
  vec3 prev = texture(u_prev, puv).rgb;
  if (isnan(prev.r + prev.g + prev.b)) prev = vec3(0.); // never let a bad value live on in the feedback
  float edge = smoothstep(0., .02, puv.x) * smoothstep(1., .98, puv.x) * smoothstep(0., .02, puv.y) * smoothstep(1., .98, puv.y);
  vec3 trail = max(prev * u_decay * edge - u_fade, 0.);
  vec3 col = vec3(0.);

  // radial spectrum, mirrored left/right: low end at the bottom
  float rad = length(c);
  float ang = abs(atan(c.x, -c.y)) / 3.14159;
  const float BARS = 56.;
  float bi = floor(ang * BARS);
  float bf = fract(ang * BARS);
  float v = texture(u_data, vec2((bi + .5) / BARS * .92 + .02, .25)).r;
  float h = u_ringH * v;
  float gap = smoothstep(.08, .22, bf) * smoothstep(.92, .78, bf);
  float px = 1. / u_res.y;
  float bar = gap * smoothstep(u_ringR - 2. * px, u_ringR, rad) * smoothstep(u_ringR + h + 2. * px, u_ringR + h, rad);
  float tip = gap * exp(-abs(rad - (u_ringR + h)) / (3. * px)) * step(.02, v);
  vec3 barCol = mix(u_base, u_accent, ang) * (.8 + .7 * v);
  barCol = mix(barCol, vec3(1., .85, .95), u_hot * .3) * (1. - u_hot * .35);
  col += barCol * bar * (.22 + .5 * u_loud) + mix(u_accent, vec3(1.), .6) * tip * (.7 + .8 * u_kick);

  // waveform ring inside it
  float wv = texture(u_data, vec2(ang * .98 + .01, .75)).r;
  float rw = u_ringR * .8 + wv * (.05 + .1 * u_loud);
  float d = abs(rad - rw) / px;
  float line = smoothstep(2.2, .4, d) + .25 * exp(-d * .18);
  col += mix(u_accent, vec3(1.), .55 + .45 * u_hot) * line * (.55 + .9 * u_loud) * (1. - u_idle * .7);
  // kick shockwave: a thin ring racing out of the spectrum ring
  if (u_shock.y > 0. && u_shock.x < 1.2) {
    float sr = u_ringR + u_shock.x * (.55 + .5 * u_heat);
    float sd = abs(rad - sr) / px;
    float sw = (smoothstep(3., 0., sd) + .35 * exp(-sd * .08)) * u_shock.y * exp(-u_shock.x * 3.2);
    col += mix(u_accent, vec3(1.), .5 + .5 * u_hot) * sw * 1.4;
  }

  // max, not sum: trails never pile up into a white-out, whatever the frame rate
  o = vec4(max(trail, col), 1.);
}`;

/**
 * GPU particles, attribute-less: 8 burst slots of N particles (kicks from the
 * ring, onsets anywhere) and a star field rushing at the camera. Positions are
 * a function of time (no simulation state), the trail feedback turns them
 * into streaks.
 */
export const PARTICLE_VS = `${HEAD}
uniform float u_time, u_travel, u_aspect, u_heat, u_hot, u_density, u_px, u_starBright;
uniform vec4 u_burst[8];      // x, y, start time, strength
uniform vec4 u_bcol[8];       // rgb, kind (0 onset, 1 kick)
uniform int u_perBurst;
uniform int u_stars;
uniform vec3 u_accent;
out vec3 v_col;
float h1(float n) { return fract(sin(n * 12.9898 + 78.233) * 43758.5453); }
void hide() { gl_Position = vec4(2., 2., 2., 1.); gl_PointSize = 0.; v_col = vec3(0.); }
void main() {
  int id = gl_VertexID;
  int nB = u_perBurst * 8;
  if (id < nB) {
    int slot = id / u_perBurst;
    float fi = float(id);
    vec4 b = u_burst[slot];
    vec4 bc = u_bcol[slot];
    float life = .7 + 1.5 * h1(fi * 1.71);
    float age = u_time - b.z;
    float local = float(id - slot * u_perBurst) / float(u_perBurst);
    if (age < 0. || age > life || b.w <= 0. || local > .25 + .75 * b.w) { hide(); return; }
    float x = age / life;
    float a = h1(fi) * 6.28318;
    float sp = (.25 + 1.6 * pow(h1(fi * 3.13), 2.2)) * (.5 + b.w) * (bc.w > .5 ? 1.25 : .8);
    float kx = 2.6;
    float dist = sp * (1. - exp(-age * kx)) / kx * 2.2;
    vec2 dir = vec2(cos(a), sin(a));
    float r0 = bc.w > .5 ? .26 : 0.;
    vec2 pos = b.xy + dir * (r0 + dist);
    // a curl of swirl, a little gravity
    float sw = (h1(fi * 7.7) - .5) * 1.6 * age;
    pos += vec2(-dir.y, dir.x) * sw * .12;
    pos.y -= .06 * age * age;
    gl_Position = vec4(pos.x / u_aspect, pos.y, 0., 1.);
    float fade = pow(1. - x, 1.6);
    gl_PointSize = (1.2 + 3.3 * pow(h1(fi * 5.3), 2.)) * u_px * (.55 + .6 * b.w) * (.35 + .65 * (1. - x));
    vec3 col = mix(bc.rgb, vec3(1.), pow(1. - x, 4.) * .5 + u_hot * .25);
    v_col = col * fade * (.55 + .6 * b.w);
    return;
  }
  int j = id - nB;
  if (j >= u_stars) { hide(); return; }
  float fj = float(j) + .5;
  if (h1(fj * 9.1) > u_density) { hide(); return; }
  vec2 xy = (vec2(h1(fj), h1(fj * 1.37)) * 2. - 1.) * vec2(u_aspect, 1.) * 1.3;
  float z = fract(h1(fj * 2.71) - u_travel * .09);
  z = .04 + z * 2.2;
  vec2 pr = xy / z * .32;
  gl_Position = vec4(pr.x / u_aspect, pr.y, 0., 1.);
  float al = smoothstep(2.24, 1.3, z) * smoothstep(.04, .18, z);
  gl_PointSize = clamp(1.1 / z, .6, 6.) * u_px;
  v_col = mix(u_accent, vec3(1.), .55 + .45 * h1(fj * 4.4)) * al * u_starBright;
}`;

export const PARTICLE_FS = `${HEAD}
in vec3 v_col;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord - .5;
  float r2 = dot(d, d) * 4.;
  if (r2 > 1.) discard;
  o = vec4(v_col * exp(-r2 * 3.5), 0.);
}`;

/** Bright pass: bg + trails above a soft threshold, downsampled to half size. */
export const BRIGHT_FS = `${HEAD}
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_bg, u_trail;
uniform vec2 u_texel;
uniform float u_thr;
void main() {
  vec3 c = vec3(0.);
  for (int i = 0; i < 4; i++) {
    vec2 off = vec2(i & 1, i >> 1) - .5;
    vec2 uv = v_uv + off * u_texel;
    c += texture(u_bg, uv).rgb + texture(u_trail, uv).rgb;
  }
  c *= .25;
  float b = max(c.r, max(c.g, c.b));
  float w = smoothstep(u_thr, u_thr + .6, b);
  o = vec4(c * w, 1.);
}`;

/** Separable 9-tap gaussian with linear sampling (5 fetches). */
export const BLUR_FS = `${HEAD}
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_dir;
void main() {
  vec3 c = texture(u_src, v_uv).rgb * .2270270;
  c += texture(u_src, v_uv + u_dir * 1.3846154).rgb * .3162162;
  c += texture(u_src, v_uv - u_dir * 1.3846154).rgb * .3162162;
  c += texture(u_src, v_uv + u_dir * 3.2307692).rgb * .0702703;
  c += texture(u_src, v_uv - u_dir * 3.2307692).rgb * .0702703;
  o = vec4(c, 1.);
}`;

/**
 * Final composite to the screen: shake, glitch slices (past 100), chromatic
 * aberration, bloom, tone mapping, white-hot grade, flash, vignette, grain.
 */
export const COMPOSITE_FS = `${HEAD}
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_bg, u_trail, u_b1, u_b2;
uniform vec2 u_res, u_shake;
uniform float u_time, u_ca, u_bloom, u_exposure, u_hot, u_flash, u_grain, u_glitch, u_idle;
uniform vec3 u_accent;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 scene(vec2 uv) {
  return texture(u_bg, uv).rgb + texture(u_trail, uv).rgb + u_bloom * (texture(u_b1, uv).rgb * .55 + texture(u_b2, uv).rgb * .8);
}
void main() {
  vec2 uv = v_uv + u_shake;
  // glitch: horizontal slices jump sideways, a few frames at a time
  if (u_glitch > 0.) {
    float tick = floor(u_time * 14.);
    float row = floor(uv.y * 38.);
    float g = hash12(vec2(row, tick));
    if (g < u_glitch * .22) uv.x += (hash12(vec2(tick, row)) - .5) * .12 * u_glitch;
    float band = step(.985 - u_glitch * .02, hash12(vec2(floor(uv.y * 7.), tick * 1.3)));
    uv.x += band * .03 * u_glitch;
  }
  vec2 dir = uv - .5;
  vec3 col;
  col.r = scene(uv + dir * u_ca).r;
  col.g = scene(uv).g;
  col.b = scene(uv - dir * u_ca).b;
  // filmic-ish tone map
  col = 1. - exp(-col * u_exposure);
  col = mix(col, col * col * (3. - 2. * col), .35); // a touch of contrast
  // white hot: highlights burn to white, the rest desaturates slightly
  float l = dot(col, vec3(.3, .55, .15));
  col = mix(col, vec3(l) * vec3(1.08, 1., .92) + l * l * .6, u_hot * .5);
  // flash: an exposure pump plus a little light (bright parts flare, the darks stay dark)
  col = col * (1. + u_flash * .9) + u_flash * mix(u_accent, vec3(1.), .7) * .18;
  float vig = smoothstep(1.25, .35, length((v_uv - .5) * vec2(u_res.x / u_res.y, 1.) * 1.05));
  col *= mix(.35, 1., vig);
  col += (hash12(v_uv * u_res + fract(u_time * 7.3) * 91.) - .5) * u_grain;
  // scanlines past 100
  col *= 1. - u_hot * .12 * step(.5, fract(v_uv.y * u_res.y * .5));
  o = vec4(clamp(col, 0., 1.), 1.);
}`;
