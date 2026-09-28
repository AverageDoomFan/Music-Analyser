// From band analysis to a rhythm map: instruments (lanes) and their notes.
// Pure functions; everything here re-runs instantly from the cached band
// analysis when a parameter changes.
//
// 1. Attacks. Onset envelopes are computed for the whole spectrum and for
//    four registers (so a quiet hi-hat is not hidden by a loud bass). A peak
//    is an attack when its prominence — rise above the valley just before
//    it — reaches a fraction of the local scale (running max over ±1.5 s).
//    Prominence works for sparse and for very dense attacks (the envelope
//    of a fast pulse train never returns to zero). A silence gate relative
//    to the track's loud level removes everything that happens where the
//    music is (almost) silent, and the local scale has a floor, so noise
//    between tracks or after the end is never taken for notes.
// 2. Attack spectra. For every attack we measure what appeared in the
//    spectrum: the rise of each band's level, pooled to a few bins per
//    octave (timbre and register, not exact pitch).
// 3. Instruments. The attack spectra (attacks × bins) are factorised with a
//    non-negative matrix factorisation: K spectral templates (instruments)
//    and, for every attack, how much of each template it contains. Unlike
//    frequency ranges, templates overlap in frequency (kick and bass,
//    piano hands), and an attack containing two instruments (kick + hi-hat)
//    activates both. K is chosen automatically (elbow of the
//    reconstruction error) or set by the user.
// 4. Notes. An attack becomes a note of every instrument that carries a
//    significant share of it (one sound → one lane, simultaneous sounds →
//    several lanes), then a minimum gap is enforced per lane.

import { RHYTHM_DEFAULTS, RHYTHM } from "../config.js";

const REGIONS = [0, 200, 1000, 4000, Infinity]; // Hz, per-register envelopes
const POOL_PER_OCTAVE = 4;                        // attack-spectrum resolution
const MERGE_S = 0.02;                             // candidates closer than this are one attack
const WHITEN = 2;                                 // band flux counts above this × its local mean
const COHERENCE = 3;                              // envelope = (Σ flux^(1/c))^c: rewards simultaneous rises

// ---------------------------------------------------------------------------
// 1. Attacks

/** @returns {{frame:number, prominence:number}[]} sorted attacks */
export function detectAttacks(data, params = RHYTHM_DEFAULTS) {
  const { nb, nf, flux, bands, frameRate, rmsDb } = data;
  const minGap = Math.max(1, Math.round((params.minGapMs / 1000) * frameRate));
  const gated = silenceGate(rmsDb, params.silenceDb, frameRate);

  const envs = [new Float64Array(nf)];
  const regionOf = bands.map((b) => REGIONS.findIndex((edge, i) => b.center >= edge && b.center < REGIONS[i + 1]));
  for (let r = 0; r < REGIONS.length - 1; r++) envs.push(new Float64Array(nf));
  // Per-band adaptive whitening: a band's flux only counts above WHITEN × its
  // local mean (±0.5 s). Beating between ringing partials (piano, organ,
  // pads) makes a band fluctuate regularly, so its peaks stay near its mean
  // and vanish; a real attack is a sparse peak far above it.
  const W = Math.round(0.5 * frameRate);
  const prefix = new Float64Array(nf + 1);
  for (let b = 0; b < nb; b++) {
    const row = b * nf;
    for (let t = 0; t < nf; t++) prefix[t + 1] = prefix[t] + flux[row + t];
    const reg = envs[1 + regionOf[b]];
    for (let t = 0; t < nf; t++) {
      const a = Math.max(0, t - W), z = Math.min(nf, t + W + 1);
      const v = flux[row + t] - (params.whiten ?? WHITEN) * ((prefix[z] - prefix[a]) / (z - a));
      if (v <= 0) continue;
      const r = v ** (1 / (params.coherence ?? COHERENCE));
      envs[0][t] += r;
      reg[t] += r;
    }
  }
  // (Σ √flux)²: a rise shared by many bands at once (a note's harmonic series,
  // a drum hit) weighs far more than the same total in one or two bands
  // (partials beating against each other).
  const pw = params.coherence ?? COHERENCE;
  for (const env of envs) for (let t = 0; t < nf; t++) env[t] = env[t] ** pw;
  // candidates from every envelope, merged when closer than MERGE_S
  const cand = [];
  envs.forEach((env) => {
    for (const c of pickProminent(env, frameRate, params.sensitivity, minGap, gated)) cand.push(c);
  });
  cand.sort((a, b) => a.frame - b.frame);
  const merge = Math.max(1, Math.round(MERGE_S * frameRate));
  const out = [];
  for (const c of cand) {
    const last = out[out.length - 1];
    if (last && c.frame - last.frame <= merge) {
      if (c.score > last.score) Object.assign(last, { frame: c.frame, score: c.score });
      last.prominence = Math.max(last.prominence, c.prominence);
      continue;
    }
    out.push({ frame: c.frame, prominence: c.prominence, score: c.score });
  }
  return out.map(({ frame, prominence }) => ({ frame, prominence }));
}

/** Frames where the music is quieter than the track's loud level minus `db`. */
function silenceGate(rmsDb, db, frameRate) {
  const n = rmsDb.length;
  const ref = quantile(rmsDb, 0.95);
  const thr = Math.max(-80, ref - db);
  const gated = new Uint8Array(n);
  const look = Math.max(1, Math.round(0.02 * frameRate)); // an attack may start just before the level rises
  for (let t = 0; t < n; t++) {
    let m = -Infinity;
    for (let k = Math.max(0, t - 1); k <= Math.min(n - 1, t + look); k++) m = Math.max(m, rmsDb[k]);
    gated[t] = m < thr ? 1 : 0;
  }
  return gated;
}

function pickProminent(env, frameRate, sensitivity, minGap, gated) {
  const n = env.length;
  const theta = 0.3 - 0.25 * clamp01(sensitivity); // share of the local scale
  const scaleWin = Math.round(1.5 * frameRate);
  const valleyWin = Math.max(2, Math.round(0.05 * frameRate));
  const half = Math.max(1, Math.floor(minGap / 2));
  const scale = runningMax(env, scaleWin);
  // floor: a fraction of the envelope's strong attacks over the whole track
  const floor = 0.08 * quantile(env, 0.995);
  const out = [];
  for (let t = 1; t < n - 1; t++) {
    const v = env[t];
    if (gated[t] || v <= 0 || v < env[t - 1] || v < env[t + 1]) continue;
    let isMax = true;
    for (let k = Math.max(0, t - half); k <= Math.min(n - 1, t + half); k++) if (env[k] > v) { isMax = false; break; }
    if (!isMax) continue;
    let valley = v;
    for (let k = Math.max(0, t - valleyWin); k < t; k++) valley = Math.min(valley, env[k]);
    const prom = v - valley;
    const s = Math.max(scale[t], floor);
    if (prom < theta * s || prom < floor * 0.5) continue;
    const score = prom / s;
    const last = out[out.length - 1];
    if (last && t - last.frame < minGap) {
      if (score > last.score) Object.assign(last, { frame: t, prominence: prom, score });
      continue;
    }
    out.push({ frame: t, prominence: prom, score });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Attack spectra

/** Pooled bins: groups of bands per 1/POOL_PER_OCTAVE octave. */
export function poolLayout(bands) {
  const f0 = bands[0].center;
  const idx = bands.map((b) => Math.floor(Math.log2(b.center / f0) * POOL_PER_OCTAVE));
  // renumber so that pooled bins are contiguous (wide low bands may skip some)
  const used = [...new Set(idx)];
  const remap = new Map(used.map((v, i) => [v, i]));
  const ridx = idx.map((v) => remap.get(v));
  const n = used.length;
  const lo = new Array(n).fill(Infinity), hi = new Array(n).fill(0);
  bands.forEach((b, i) => { lo[ridx[i]] = Math.min(lo[ridx[i]], b.lo); hi[ridx[i]] = Math.max(hi[ridx[i]], b.hi); });
  return { idx: ridx, n, lo, hi, center: lo.map((l, i) => Math.sqrt(l * hi[i])) };
}

/**
 * @returns {{A:Float32Array, F:number, energy:Float32Array}} A: attacks × pooled bins (log-level rise);
 *          energy: perceived (A-weighted) linear rise of each attack, for strengths
 */
export function attackSpectra(data, attacks, pool) {
  const { nb, nf, level, bands } = data;
  const F = pool.n;
  const A = new Float32Array(attacks.length * F);
  const energy = new Float32Array(attacks.length);
  const aW = bands.map((b) => aWeighting(b.center));
  attacks.forEach(({ frame }, n) => {
    const before = Math.max(0, frame - 3);
    let e = 0;
    for (let b = 0; b < nb; b++) {
      const row = b * nf;
      let peak = 0;
      for (let k = frame; k <= Math.min(nf - 1, frame + 2); k++) peak = Math.max(peak, level[row + k]);
      const rise = peak - level[row + before];
      if (rise > 0) {
        const j = n * F + pool.idx[b];
        A[j] = Math.max(A[j], rise);
        e += (Math.expm1(peak) - Math.expm1(level[row + before])) * aW[b];
      }
    }
    energy[n] = Math.max(0, e) / 1000;
  });
  return { A, F, energy };
}

// ---------------------------------------------------------------------------
// 3. Instruments: NMF of the attack spectra

/**
 * Non-negative factorisation X ≈ G·H of unit-normalised rows.
 * @returns {{G:Float32Array (N×K), H:Float32Array (K×F), err:number}} err = relative squared error
 */
export function nmf(X, N, F, K, { iterations = 150, seed = 7 } = {}) {
  const H = seedTemplates(X, N, F, K, seed);
  const G = new Float32Array(N * K);
  for (let n = 0; n < N; n++) for (let k = 0; k < K; k++) {
    let d = 0;
    for (let f = 0; f < F; f++) d += X[n * F + f] * H[k * F + f];
    G[n * K + k] = Math.max(1e-3, d);
  }
  const eps = 1e-9;
  const GtX = new Float64Array(K * F), GtG = new Float64Array(K * K), HHt = new Float64Array(K * K), XHt = new Float64Array(N * K);
  for (let it = 0; it < iterations; it++) {
    // H ← H ∘ (GᵀX) / (GᵀG H)
    GtX.fill(0); GtG.fill(0);
    for (let n = 0; n < N; n++) {
      for (let k = 0; k < K; k++) {
        const g = G[n * K + k];
        if (!g) continue;
        for (let f = 0; f < F; f++) GtX[k * F + f] += g * X[n * F + f];
        for (let j = 0; j < K; j++) GtG[k * K + j] += g * G[n * K + j];
      }
    }
    for (let k = 0; k < K; k++) for (let f = 0; f < F; f++) {
      let den = 0;
      for (let j = 0; j < K; j++) den += GtG[k * K + j] * H[j * F + f];
      H[k * F + f] *= GtX[k * F + f] / (den + eps);
    }
    // keep templates unit-norm (scale moves into G)
    for (let k = 0; k < K; k++) {
      let s = 0;
      for (let f = 0; f < F; f++) s += H[k * F + f] ** 2;
      s = Math.sqrt(s) || 1;
      for (let f = 0; f < F; f++) H[k * F + f] /= s;
      for (let n = 0; n < N; n++) G[n * K + k] *= s;
    }
    // G ← G ∘ (X Hᵀ) / (G H Hᵀ)
    HHt.fill(0);
    for (let k = 0; k < K; k++) for (let j = 0; j < K; j++) {
      let s = 0;
      for (let f = 0; f < F; f++) s += H[k * F + f] * H[j * F + f];
      HHt[k * K + j] = s;
    }
    for (let n = 0; n < N; n++) for (let k = 0; k < K; k++) {
      let s = 0;
      for (let f = 0; f < F; f++) s += X[n * F + f] * H[k * F + f];
      XHt[n * K + k] = s;
    }
    for (let n = 0; n < N; n++) for (let k = 0; k < K; k++) {
      let den = 0;
      for (let j = 0; j < K; j++) den += G[n * K + j] * HHt[j * K + k];
      G[n * K + k] *= XHt[n * K + k] / (den + eps);
    }
  }
  let e = 0, tot = 0;
  for (let n = 0; n < N; n++) for (let f = 0; f < F; f++) {
    let r = 0;
    for (let k = 0; k < K; k++) r += G[n * K + k] * H[k * F + f];
    const x = X[n * F + f];
    e += (x - r) ** 2;
    tot += x * x;
  }
  return { G, H, err: tot ? e / tot : 0 };
}

/** k-means++ seeding on the rows (cosine), deterministic. */
function seedTemplates(X, N, F, K, seed) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const H = new Float32Array(K * F);
  const d = new Float64Array(N).fill(Infinity);
  let pick = Math.floor(rand() * N);
  for (let k = 0; k < K; k++) {
    for (let f = 0; f < F; f++) H[k * F + f] = X[pick * F + f] + 1e-3;
    let sum = 0;
    for (let n = 0; n < N; n++) {
      let dot = 0;
      for (let f = 0; f < F; f++) dot += X[n * F + f] * H[k * F + f];
      d[n] = Math.min(d[n], 1 - dot); // rows and seeds ~unit norm
      sum += Math.max(0, d[n]) ** 2;
    }
    let r = rand() * sum;
    pick = 0;
    for (let n = 0; n < N; n++) {
      r -= Math.max(0, d[n]) ** 2;
      if (r <= 0) { pick = n; break; }
    }
  }
  return H;
}

/** Rows scaled to unit L2 norm (timbre shape, independent of loudness). */
function normalizeRows(A, N, F) {
  const X = new Float32Array(N * F);
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (let f = 0; f < F; f++) s += A[n * F + f] ** 2;
    s = Math.sqrt(s);
    if (s > 0) for (let f = 0; f < F; f++) X[n * F + f] = A[n * F + f] / s;
  }
  return X;
}

/** Automatic number of instruments: the elbow of the reconstruction error. */
export function chooseInstrumentCount(X, N, F, maxK) {
  const fits = [];
  for (let k = 1; k <= Math.min(maxK, N); k++) fits.push(nmf(X, N, F, k, { iterations: 80 }));
  if (!fits.length) return { k: 1, fits };
  // stop when one more instrument explains less than 4 % of the attack spectra
  let k = 1;
  while (k < fits.length && fits[k - 1].err - fits[k].err >= 0.04) k++;
  return { k, fits };
}

// ---------------------------------------------------------------------------
// 4. Notes

/** Full map from band data and parameters. */
export function buildRhythmMap(data, params = RHYTHM_DEFAULTS) {
  const attacks = detectAttacks(data, params);
  const pool = poolLayout(data.bands);
  const { A, F, energy } = attackSpectra(data, attacks, pool);
  const N = attacks.length;
  const X = normalizeRows(A, N, F);
  const maxK = Math.max(1, Math.min(RHYTHM.maxLanes, params.maxInstruments ?? RHYTHM.maxLanes));
  let K = params.instruments > 0 ? Math.min(params.instruments, RHYTHM.maxLanes) : chooseInstrumentCount(X, N, F, maxK).k;
  K = Math.max(1, Math.min(K, N || 1));
  const { G, H } = N ? nmf(X, N, F, K) : { G: new Float32Array(0), H: new Float32Array(K * F) };
  const lanes = assign(data, attacks, energy, G, H, K, F, pool, params);
  const map = { lanes, params: { ...params }, duration: data.duration };
  // kept in memory (not persisted) for manual splits
  Object.defineProperty(map, "attacks", { value: { attacks, X, F, energy, pool }, enumerable: false });
  return map;
}

function assign(data, attacks, energy, G, H, K, F, pool, params) {
  const { frameRate, t0 } = data;
  const ratio = params.assignRatio ?? 0.35;
  const minGap = (params.minGapMs / 1000);
  const members = Array.from({ length: K }, () => []);
  for (let n = 0; n < attacks.length; n++) {
    let max = 0;
    for (let k = 0; k < K; k++) max = Math.max(max, G[n * K + k]);
    if (max <= 0) continue;
    for (let k = 0; k < K; k++) {
      const g = G[n * K + k];
      // a significant share of this attack's spectrum belongs to instrument k
      if (g >= ratio * max && g >= 0.2) members[k].push({ n, g });
    }
  }
  const lanes = [];
  for (let k = 0; k < K; k++) {
    const template = H.slice(k * F, (k + 1) * F);
    lanes.push(laneFrom(members[k].map(({ n, g }) => ({
      n, t: t0 + attacks[n].frame / frameRate, s: g * Math.sqrt(energy[n] + 1e-12),
    })), template, pool, minGap, params.minStrength ?? 0));
  }
  return finishLanes(lanes);
}

/**
 * Builds a lane from its notes (t, strength, attack index) and template.
 * Notes weaker than `minStrength` × the lane's strong notes (p90) are dropped:
 * leftovers of other sounds rather than attacks of this instrument.
 */
function laneFrom(notes, template, pool, minGap, minStrength = 0) {
  notes.sort((a, b) => a.t - b.t);
  const kept = [];
  for (const x of notes) {
    const last = kept[kept.length - 1];
    if (last && x.t - last.t < minGap) {
      if (x.s > last.s) kept[kept.length - 1] = x;
      continue;
    }
    kept.push(x);
  }
  let ref = quantile(Float64Array.from(kept, (x) => x.s), 0.9) || 1;
  if (minStrength > 0) {
    const strong = kept.filter((x) => x.s >= minStrength * ref);
    kept.length = 0;
    kept.push(...strong);
    ref = quantile(Float64Array.from(kept, (x) => x.s), 0.9) || 1;
  }
  // frequency range: where the template's energy is (p10–p90)
  const w = Array.from(template, (v) => v * v);
  const tot = w.reduce((a, b) => a + b, 0) || 1;
  let acc = 0, lo = pool.lo[0], hi = pool.hi[pool.n - 1], loSet = false, hiSet = false;
  let centroidLog = 0;
  for (let f = 0; f < pool.n; f++) {
    acc += w[f];
    centroidLog += (w[f] / tot) * Math.log(pool.center[f]);
    if (!loSet && acc >= 0.1 * tot) { lo = pool.lo[f]; loSet = true; }
    if (!hiSet && acc >= 0.9 * tot) { hi = pool.hi[f]; hiSet = true; }
  }
  return {
    notes: Float64Array.from(kept, (x) => x.t),
    strengths: Float32Array.from(kept, (x) => Math.min(1, x.s / ref)),
    attackIndex: Int32Array.from(kept, (x) => x.n),
    template: Float32Array.from(template),
    lo: Math.round(lo), hi: Math.round(hi),
    centroid: Math.round(Math.exp(centroidLog)),
  };
}

/** Sorted low → high, empty lanes removed, activity shares. */
function finishLanes(lanes) {
  const kept = lanes.filter((l) => l.notes.length > 0).sort((a, b) => a.centroid - b.centroid);
  const total = kept.reduce((a, l) => a + l.notes.length, 0) || 1;
  for (const l of kept) l.activity = l.notes.length / total;
  return kept;
}

// ---------------------------------------------------------------------------
// Manual edits

/** Merge lane j into lane i (notes united, templates summed). */
export function mergeLanes(map, i, j, pool = map.attacks?.pool) {
  const a = map.lanes[i], b = map.lanes[j];
  const minGap = map.params.minGapMs / 1000;
  const notes = [
    ...[...a.notes].map((t, k) => ({ t, s: a.strengths[k], n: a.attackIndex?.[k] ?? -1 })),
    ...[...b.notes].map((t, k) => ({ t, s: b.strengths[k], n: b.attackIndex?.[k] ?? -1 })),
  ];
  const template = a.template.map((v, f) => v + b.template[f]);
  const norm = Math.hypot(...template) || 1;
  const merged = pool ? laneFrom(notes, template.map((v) => v / norm), pool, minGap) : mergeWithoutPool(a, b, notes, minGap);
  const lanes = map.lanes.filter((_, k) => k !== i && k !== j);
  lanes.push(merged);
  return withLanes(map, finishLanes(lanes));
}

function mergeWithoutPool(a, b, notes, minGap) {
  notes.sort((x, y) => x.t - y.t);
  const kept = [];
  for (const x of notes) {
    if (kept.length && x.t - kept[kept.length - 1].t < minGap) continue;
    kept.push(x);
  }
  return {
    ...a,
    notes: Float64Array.from(kept, (x) => x.t),
    strengths: Float32Array.from(kept, (x) => x.s),
    attackIndex: Int32Array.from(kept, (x) => x.n),
    lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi),
    centroid: Math.round(Math.sqrt(a.centroid * b.centroid)),
  };
}

/** Split a lane in two instruments (NMF with K = 2 on its own attacks). Needs the band analysis. */
export function splitLane(map, i) {
  const src = map.attacks;
  const lane = map.lanes[i];
  if (!src || lane.notes.length < 4) return null;
  const { X, F, energy, pool } = src;
  const idx = [...lane.attackIndex.keys()].filter((r) => lane.attackIndex[r] >= 0);
  const Xs = new Float32Array(idx.length * F);
  idx.forEach((r, i) => Xs.set(X.subarray(lane.attackIndex[r] * F, (lane.attackIndex[r] + 1) * F), i * F));
  const { G, H } = nmf(Xs, idx.length, F, 2);
  const parts = [[], []];
  idx.forEach((r, i) => {
    const n = lane.attackIndex[r];
    const g0 = G[i * 2], g1 = G[i * 2 + 1];
    parts[g0 >= g1 ? 0 : 1].push({ n, t: lane.notes[r], s: Math.max(g0, g1) * Math.sqrt(energy[n] + 1e-12) });
  });
  if (!parts[0].length || !parts[1].length) return null;
  const minGap = map.params.minGapMs / 1000;
  const lanes = map.lanes.filter((_, k) => k !== i);
  lanes.push(laneFrom(parts[0], H.slice(0, F), pool, minGap), laneFrom(parts[1], H.slice(F, 2 * F), pool, minGap));
  return withLanes(map, finishLanes(lanes));
}

/** Edited copy of a map, keeping its in-memory attack data. */
function withLanes(map, lanes) {
  const copy = { ...map, lanes, edited: true };
  if (map.attacks) Object.defineProperty(copy, "attacks", { value: map.attacks, enumerable: false });
  return copy;
}

/** Descriptive label: register of the template's centre, "large bande" for spread templates. */
export function laneLabel(lane) {
  const c = lane.centroid || Math.sqrt(lane.lo * lane.hi);
  const register = c < 120 ? "Grave" : c < 400 ? "Bas-médium" : c < 1500 ? "Médium" : c < 5000 ? "Haut-médium" : "Aigu";
  const wide = lane.hi / Math.max(1, lane.lo) > 24 ? " · large bande" : "";
  const f = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} k` : `${hz}`);
  return { name: `${register}${wide}`, range: `${f(lane.lo)}–${f(lane.hi)} Hz` };
}

// ---------------------------------------------------------------------------
// helpers

/** IEC 61672 A-weighting as a linear amplitude gain (1 at 1 kHz). */
function aWeighting(f) {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return ra / 0.7943;
}

function runningMax(a, w) {
  const n = a.length;
  const out = new Float64Array(n);
  const dq = [];
  let head = 0;
  // centred window [t - w, t + w]
  for (let i = 0, t = -w; t < n; i++, t++) {
    if (i < n) {
      while (dq.length > head && a[dq[dq.length - 1]] <= a[i]) dq.pop();
      dq.push(i);
    }
    if (t >= 0) {
      while (dq[head] < t - w) head++;
      out[t] = a[dq[head]];
    }
  }
  return out;
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const step = Math.max(1, Math.floor(arr.length / 20000));
  const s = [];
  for (let i = 0; i < arr.length; i += step) s.push(arr[i]);
  s.sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
