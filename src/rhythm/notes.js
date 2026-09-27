// From band onset envelopes to a rhythm map: lanes (instrument groups) and
// individual notes. Pure functions: cheap enough to re-run instantly when the
// grouping parameters change (the spectral pass in bands.js is not redone).
//
// 1. Grouping (automatic, or manual boundaries edited by the user).
//    A sound excites several neighbouring bands at the same instant
//    (a kick: 40–150 Hz, a snare: body + noise, a violin note: its partials).
//    Neighbouring band groups are merged, most similar first (their attack
//    strengths keep a constant ratio), until no neighbours are similar
//    enough (grouping threshold)
//    and there are no more than `lanes` groups. Near-silent groups are always
//    absorbed. Lanes are therefore contiguous frequency ranges.
// 2. Notes. Each lane's envelope (sum of its bands) is peak-picked against an
//    adaptive threshold (local mean + k·local deviation, plus a floor relative
//    to the lane's strong attacks) with a minimum gap. This follows the local
//    dynamics, so it works for soft orchestral attacks as for 20+ notes/s
//    extratone.

import { RHYTHM_DEFAULTS, RHYTHM } from "../config.js";

const POOL = 2; // frames max-pooled before comparing groups (tolerates small jitter)
// notes of different lanes closer than this are one attack (soft attacks peak
// a little later in some bands than in others)
const ECHO_WINDOW = 0.03;

/** @returns {{b0:number, b1:number, lo:number, hi:number}[]} contiguous band ranges, low to high */
export function groupBands(data, params = RHYTHM_DEFAULTS) {
  const { nb, nf, flux, bands } = data;
  if (params.boundaries?.length) return manualGroups(data, params.boundaries);
  const maxLanes = Math.max(1, Math.min(RHYTHM.maxLanes, params.lanes));
  const n = Math.floor(nf / POOL);
  const make = (b0, b1, env) => ({ b0, b1, env, activity: sum(env), events: events(env) });
  let groups = [];
  for (let b = 0; b < nb; b++) {
    const env = new Float64Array(n);
    const row = b * nf;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let k = 0; k < POOL; k++) m = Math.max(m, flux[row + i * POOL + k]);
      env[i] = m;
    }
    groups.push(make(b, b, env));
  }
  const total = groups.reduce((a, g) => a + g.activity, 0) || 1;
  const similarity = params.groupingMode === "rhythm" ? coincidence
    : params.groupingMode === "timbre" ? proportionality
    : auto;
  const sim = groups.slice(0, -1).map((g, i) => similarity(g, groups[i + 1]));

  while (groups.length > 1) {
    // near-silent groups first: they carry no attacks of their own
    let idx;
    const weakest = groups.reduce((w, g, i) => (g.activity < groups[w].activity ? i : w), 0);
    if (groups[weakest].activity / total < 0.01) {
      if (weakest === 0) idx = 0;
      else if (weakest === groups.length - 1) idx = weakest - 1;
      else idx = sim[weakest - 1] >= sim[weakest] ? weakest - 1 : weakest;
    } else {
      let best = 0;
      for (let i = 1; i < sim.length; i++) if (sim[i] > sim[best]) best = i;
      if (groups.length <= maxLanes && sim[best] < params.grouping) break;
      idx = best;
    }
    const a = groups[idx], b = groups[idx + 1];
    const env = new Float64Array(a.env.length);
    for (let i = 0; i < env.length; i++) env[i] = a.env[i] + b.env[i];
    const merged = make(a.b0, b.b1, env);
    groups.splice(idx, 2, merged);
    sim.splice(idx, 1);
    if (idx > 0) sim[idx - 1] = similarity(groups[idx - 1], merged);
    if (idx < groups.length - 1) sim[idx] = similarity(merged, groups[idx + 1]);
  }
  return groups.map((g) => ({ b0: g.b0, b1: g.b1, lo: bands[g.b0].lo, hi: bands[g.b1].hi, activity: g.activity / total }));
}

/** Lanes from user-edited boundaries (band index where each lane starts, the first one being 0). */
function manualGroups(data, boundaries) {
  const { nb, nf, flux, bands } = data;
  const starts = [...new Set([0, ...boundaries.filter((b) => b > 0 && b < nb)])].sort((a, b) => a - b);
  const act = (b0, b1) => {
    let s = 0;
    for (let b = b0; b <= b1; b++) for (let t = 0; t < nf; t++) s += flux[b * nf + t];
    return s;
  };
  const groups = starts.map((b0, i) => {
    const b1 = (starts[i + 1] ?? nb) - 1;
    return { b0, b1, lo: bands[b0].lo, hi: bands[b1].hi, activity: act(b0, b1) };
  });
  const total = groups.reduce((a, g) => a + g.activity, 0) || 1;
  for (const g of groups) g.activity /= total;
  return groups;
}

/** Boundaries (band index of each lane start) of a lane list, for manual editing. */
export const boundariesOf = (lanes) => lanes.map((l) => l.b0);

/** Coarse attack list of an envelope: local maxima above mean + 1 std, with their strength. */
function events(env) {
  const n = env.length;
  let m = 0, m2 = 0;
  for (let i = 0; i < n; i++) { m += env[i]; m2 += env[i] * env[i]; }
  m /= n;
  const thr = m + Math.sqrt(Math.max(0, m2 / n - m * m));
  const idx = [], str = [];
  for (let i = 1; i < n - 1; i++) {
    const v = env[i];
    if (v > thr && v >= env[i - 1] && v > env[i + 1]) {
      if (idx.length && i - idx[idx.length - 1] < 3) {
        if (v > str[str.length - 1]) { idx[idx.length - 1] = i; str[str.length - 1] = v; }
        continue;
      }
      idx.push(i);
      str.push(v);
    }
  }
  return { idx, str, total: str.reduce((x, y) => x + y, 0) };
}

/**
 * Do two groups belong to the same sound? At every attack of either group we
 * take each group's strength (max over ±1 pooled frame). Two parts of the
 * same sound keep a constant strength ratio from one attack to the next; two
 * different sounds do not (a kick's click leaking into the melody bands is
 * weak there while the melody's own attacks are strong). Similarity is
 * exp(-2 · mean absolute deviation of log(strength ratio)): 1 for perfectly
 * proportional attacks, → 0 for unrelated ones. Silent baselines and the
 * absolute level of each group play no role.
 */
function proportionality(a, b) {
  const at = [...new Set([...a.events.idx, ...b.events.idx])];
  if (at.length < 4) return 1; // (almost) no attacks: nothing speaks against merging
  const peak = (env, i) => Math.max(env[i - 1] ?? 0, env[i], env[i + 1] ?? 0);
  const xs = at.map((i) => peak(a.env, i));
  const ys = at.map((i) => peak(b.env, i));
  const ex = 0.1 * median(xs) + 1e-6, ey = 0.1 * median(ys) + 1e-6;
  const lr = xs.map((x, k) => Math.log(x + ex) - Math.log(ys[k] + ey));
  const c = median(lr);
  let dev = 0;
  for (const v of lr) dev += Math.abs(v - c);
  return Math.exp((-2 * dev) / lr.length);
}

/**
 * "Rhythm" grouping: strength-weighted share of each group's attacks that
 * happen at the same instant (±1 pooled frame) as an attack of the other; the
 * smaller share. Merges the registers of a melodic instrument whose notes
 * change pitch (and so change which bands are strongest), at the cost of also
 * merging instruments that always play together.
 */
function coincidence(a, b) {
  const share = (x, y, env) => {
    let hit = 0, tot = 0, j = 0;
    for (const i of x.idx) {
      const s = Math.max(env[i - 1] ?? 0, env[i], env[i + 1] ?? 0);
      tot += s;
      while (j < y.idx.length && y.idx[j] < i - 1) j++;
      if (j < y.idx.length && Math.abs(y.idx[j] - i) <= 1) hit += s;
    }
    return tot ? hit / tot : 1;
  };
  return Math.min(share(a.events, b.events, a.env), share(b.events, a.events, b.env));
}

/**
 * Default grouping: parts of one sound either keep a constant strength ratio
 * (drums, most timbres) or, for a sound whose pitch moves (melody, melodic
 * extratone, legato strings), attack at virtually the same instants in both
 * directions (≥ ~85 %). Occasional coincidences between different
 * instruments (a melody note on a kick, ~60 %) stay far below.
 */
function auto(a, b) {
  const c = coincidence(a, b);
  return Math.max(proportionality(a, b), Math.max(0, (c - 0.7) / 0.3));
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y);
  return s[s.length >> 1];
}

/**
 * @returns {{b0,b1,lo,hi,activity,notes:Float64Array,strengths:Float32Array}[]} notes in seconds
 */
export function detectNotes(data, groups, params = RHYTHM_DEFAULTS) {
  const { nf, flux, frameRate, t0, level } = data;
  const RISE = 3; // frames (~17 ms) over which the attack's amplitude rise is measured
  const aWeight = data.bands.map((b) => aWeighting(b.center));
  const minGap = Math.max(1, Math.round((params.minGapMs / 1000) * frameRate));
  const W = Math.max(4, Math.round(0.3 * frameRate));
  const k = 2.2 - 2.0 * clamp01(params.sensitivity);

  const lanes = groups.map((g) => {
    const env = new Float64Array(nf);
    for (let b = g.b0; b <= g.b1; b++) {
      const row = b * nf;
      for (let t = 0; t < nf; t++) env[t] += flux[row + t];
    }
    // prefix sums for local mean / deviation in O(n)
    const s1 = new Float64Array(nf + 1), s2 = new Float64Array(nf + 1);
    for (let t = 0; t < nf; t++) {
      s1[t + 1] = s1[t] + env[t];
      s2[t + 1] = s2[t] + env[t] * env[t];
    }
    const floor = quantile(env, 0.995) * (0.06 + 0.1 * (1 - clamp01(params.sensitivity)));
    const times = [];
    const strengths = [];
    let last = -Infinity;
    for (let t = 1; t < nf - 1; t++) {
      const v = env[t];
      if (v <= floor || v < env[t - 1] || v < env[t + 1]) continue;
      const a = Math.max(0, t - W), b = Math.min(nf, t + W + 1);
      const m = (s1[b] - s1[a]) / (b - a);
      const sd = Math.sqrt(Math.max(0, (s2[b] - s2[a]) / (b - a) - m * m));
      if (v < m + k * sd) continue;
      if (t - last < minGap) {
        // keep the strongest of two attacks closer than the minimum gap
        if (v > strengths[strengths.length - 1]) {
          times[times.length - 1] = t;
          strengths[strengths.length - 1] = v;
          last = t;
        }
        continue;
      }
      times.push(t);
      strengths.push(v);
      last = t;
    }
    const ref = quantile(Float64Array.from(strengths), 0.9) || 1;
    // perceived (A-weighted) linear amplitude rise of the lane at each attack:
    // its real share of the sound. The log flux makes faint leaks look big once
    // summed over bands, and raw amplitudes overrate the bass.
    const energy = Float32Array.from(times, (t) => {
      let e = 0;
      for (let b = g.b0; b <= g.b1; b++) {
        const wA = aWeight[b];
        const row = b * nf;
        let peak = 0;
        for (let k = t; k <= Math.min(nf - 1, t + 2); k++) peak = Math.max(peak, level[row + k]);
        const d = Math.expm1(peak) - Math.expm1(level[row + Math.max(0, t - RISE)]);
        if (d > 0) e += d * wA;
      }
      return e / 1000;
    });
    return {
      ...g,
      notes: Float64Array.from(times, (f) => t0 + f / frameRate),
      strengths: Float32Array.from(strengths, (v) => Math.min(1, v / ref)),
      energy,
    };
  });

  if (params.dedupe > 0) removeEchoes(lanes, params.dedupe, ECHO_WINDOW);
  if (params.mergeNeighbors) mergeNeighborNotes(lanes, 0.025);
  if (!params.keepEnergy) for (const lane of lanes) delete lane.energy;
  return lanes;
}

/**
 * One sound, one lane. An attack excites its own lane strongly and leaks
 * weakly into the others (clicks, harmonics). Notes of different lanes
 * closer than `window` form a cluster; within it only the notes whose
 * linear attack energy reaches `ratio` × the strongest one are kept, plus
 * those that are strong for their own lane (a melody note on a kick), so
 * echoes disappear while genuinely simultaneous hits stay.
 */
function removeEchoes(lanes, ratio, window) {
  // Pass 1: weak echoes. Typical attack energy of each lane tells its own notes.
  const typical = lanes.map((lane) => quantile(Float64Array.from(lane.energy), 0.75) || 1e-9);
  let drop = lanes.map((lane) => new Uint8Array(lane.notes.length));
  for (const c of clustersOf(lanes, window)) {
    let max = 0;
    for (const n of c) max = Math.max(max, n.e);
    for (const n of c) {
      // weak compared to the loudest simultaneous attack, and not a strong
      // attack for its own lane either (minor lanes — harmonics, residues —
      // get no benefit of the doubt)
      const ownNote = n.e / typical[n.l] >= 0.5 && n.e >= 0.03 * max && lanes[n.l].activity >= 0.05;
      if (n.e < ratio * max && !ownNote) drop[n.l][n.i] = 1;
    }
  }
  applyDrop(lanes, drop);

  // Pass 2: twin lanes. Lanes whose remaining notes mostly come together are
  // one sound split in two (a pitched sound moving across bands, a melodic
  // extratone): only its strongest part stays.
  const clusters = clustersOf(lanes, window);
  const L = lanes.length;
  const together = Array.from({ length: L }, () => new Float64Array(L));
  for (const c of clusters) {
    const present = new Set(c.map((n) => n.l));
    for (const a of present) for (const b of present) if (a !== b) together[a][b]++;
  }
  const TWIN = 0.6; // share of each lane's notes shared with the other (a kick and a melody: ~0.35)
  const twins = (a, b) => together[a][b] >= TWIN * lanes[a].notes.length && together[b][a] >= TWIN * lanes[b].notes.length;
  drop = lanes.map((lane) => new Uint8Array(lane.notes.length));
  for (const c of clusters) {
    for (const n of c) {
      if (c.some((m) => m.l !== n.l && m.e > n.e && twins(n.l, m.l))) drop[n.l][n.i] = 1;
    }
  }
  applyDrop(lanes, drop);
}

/**
 * Groups of notes within `window` of the group's first note. Anchored rather
 * than chained, so a fast pulse train (40 ms apart) never collapses into one.
 */
function clustersOf(lanes, window) {
  const all = [];
  lanes.forEach((lane, l) => lane.notes.forEach((t, i) => all.push({ t, l, i, e: lane.energy[i] })));
  all.sort((a, b) => a.t - b.t);
  const clusters = [];
  for (let s = 0; s < all.length;) {
    let e = s + 1;
    while (e < all.length && all[e].t - all[s].t <= window) e++;
    if (e - s > 1) clusters.push(all.slice(s, e));
    s = e;
  }
  return clusters;
}

function applyDrop(lanes, drop) {
  lanes.forEach((lane, l) => {
    const idx = [...lane.notes.keys()].filter((i) => !drop[l][i]);
    lane.notes = Float64Array.from(idx, (i) => lane.notes[i]);
    lane.strengths = Float32Array.from(idx, (i) => lane.strengths[i]);
    lane.energy = Float32Array.from(idx, (i) => lane.energy[i]);
  });
}

/** Simultaneous notes in neighbouring lanes are one sound: keep the relatively stronger one. */
function mergeNeighborNotes(lanes, window) {
  for (let l = 0; l < lanes.length - 1; l++) {
    const A = lanes[l], B = lanes[l + 1];
    const dropA = new Uint8Array(A.notes.length), dropB = new Uint8Array(B.notes.length);
    let j = 0;
    for (let i = 0; i < A.notes.length; i++) {
      while (j < B.notes.length && B.notes[j] < A.notes[i] - window) j++;
      if (j < B.notes.length && Math.abs(B.notes[j] - A.notes[i]) <= window && !dropB[j]) {
        if (A.strengths[i] >= B.strengths[j]) dropB[j] = 1;
        else dropA[i] = 1;
      }
    }
    const keep = (lane, drop) => {
      const idx = [...lane.notes.keys()].filter((i) => !drop[i]);
      lane.notes = Float64Array.from(idx, (i) => lane.notes[i]);
      lane.strengths = Float32Array.from(idx, (i) => lane.strengths[i]);
      lane.energy = Float32Array.from(idx, (i) => lane.energy[i]);
    };
    keep(A, dropA);
    keep(B, dropB);
  }
}

/** Full map from band data and parameters. */
export function buildRhythmMap(data, params = RHYTHM_DEFAULTS) {
  const groups = groupBands(data, params);
  const lanes = detectNotes(data, groups, params);
  return { lanes, params: { ...params }, duration: data.duration };
}

/** Descriptive label of a lane from its frequency range. */
export function laneLabel(lane) {
  const c = Math.sqrt(lane.lo * lane.hi);
  const name = c < 90 ? "Sub / kick" : c < 250 ? "Basses" : c < 700 ? "Bas-médiums" : c < 2000 ? "Médiums" : c < 6000 ? "Haut-médiums" : "Aigus";
  const f = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} k` : `${hz}`);
  return { name, range: `${f(lane.lo)}–${f(lane.hi)} Hz` };
}

// ---------- helpers ----------

/** IEC 61672 A-weighting as a linear amplitude gain (1 at 1 kHz). */
function aWeighting(f) {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return ra / 0.7943; // normalise: RA(1 kHz) ≈ 0.794
}

function sum(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  // sample for speed on long envelopes
  const step = Math.max(1, Math.floor(arr.length / 20000));
  const s = [];
  for (let i = 0; i < arr.length; i += step) s.push(arr[i]);
  s.sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
