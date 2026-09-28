// Set generator: picks and orders tracks so that their intensity follows a
// target curve drawn by the user, with smooth transitions (intensity seam,
// tempo, key, timbre, mood) and constraints (first / last track, locked
// tracks, target duration, no same artist twice in a row).
// Simulated annealing over the sequence, starting from a rank assignment
// (the k-th calmest track goes to the k-th calmest slot of the curve).
// Pure functions, tested in Node.

import { keyCompatibility } from "../audio/music.js";

export const CURVE_PRESETS = [
  { key: "echauffement", label: "Échauffement → pic → retour au calme", points: [[0, 25], [0.55, 82], [0.8, 90], [1, 35]] },
  { key: "montee", label: "Montée continue", points: [[0, 15], [1, 92]] },
  { key: "vagues", label: "Vagues", points: [[0, 35], [0.17, 70], [0.33, 40], [0.5, 78], [0.67, 45], [0.83, 88], [1, 50]] },
  { key: "plateau", label: "Plateau intense", points: [[0, 50], [0.15, 75], [0.9, 78], [1, 65]] },
  { key: "sport", label: "Fractionné (sport)", points: [[0, 40], [0.12, 80], [0.24, 50], [0.36, 85], [0.48, 50], [0.6, 88], [0.72, 50], [0.84, 92], [1, 35]] },
  { key: "descente", label: "Descente (fin de soirée)", points: [[0, 85], [1, 15]] },
];

export const TRANSITION_CRITERIA = [
  { key: "curve", label: "Suivre la courbe", default: 1 },
  { key: "seam", label: "Enchaînement d'intensité (fin → début)", default: 0.6 },
  { key: "bpm", label: "Tempo proche", default: 0.5 },
  { key: "key", label: "Tonalités compatibles", default: 0.5 },
  { key: "timbre", label: "Timbre proche", default: 0.3 },
  { key: "mood", label: "Ambiance proche", default: 0.3 },
];

/** Target value (0..100) at x in [0, 1] (linear between points). */
export function curveAt(points, x) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  if (!p.length) return 50;
  if (x <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i][0]) {
      const [x0, y0] = p[i - 1], [x1, y1] = p[i];
      return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return p.at(-1)[1];
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Tempo mismatch 0..1 (half / double time count as compatible). */
export function tempoCost(a, b) {
  const x = a.bpmEnd ?? a.bpm, y = b.bpmStart ?? b.bpm;
  if (!x || !y) return 0.3;
  const d = Math.min(...[0.5, 1, 2].map((k) => Math.abs(Math.log2((y * k) / x))));
  return clamp01(d / Math.log2(1.08)); // 8 % apart = full cost
}

/** Per-criterion costs (0..1) of playing b after a. */
export function transitionParts(a, b) {
  let timbre = 0.4;
  if (a.fp && b.fp) {
    let s = 0;
    for (let i = 0; i < a.fp.length; i++) s += (a.fp[i] - b.fp[i]) ** 2;
    timbre = clamp01(Math.sqrt(s / a.fp.length) / 1.6);
  }
  return {
    seam: clamp01(Math.abs((b.start ?? b.score) - (a.end ?? a.score)) / 30),
    bpm: tempoCost(a, b),
    key: 1 - keyCompatibility(a.keyEnd ?? a.key, b.keyStart ?? b.key),
    timbre,
    mood: a.valence != null && b.valence != null ? clamp01(Math.abs(a.valence - b.valence) / 40) : 0.3,
  };
}

/** 0..100 fluidity of a transition with the given weights. */
export function fluidity(parts, weights) {
  let s = 0, w = 0;
  for (const k of ["seam", "bpm", "key", "timbre", "mood"]) {
    const wi = Math.max(0, weights[k] ?? 0);
    s += wi * parts[k];
    w += wi;
  }
  return w ? Math.round((1 - s / w) * 100) : 100;
}

/**
 * @param {object[]} pool  { id, name, artist, duration, score, start, end, valence, bpm, bpmStart, bpmEnd, key, keyStart, keyEnd, fp }
 * @param {object} o
 *   points        target curve [[x, y]…]
 *   weights       criteria weights (TRANSITION_CRITERIA keys)
 *   duration      target duration in seconds (null = use every track)
 *   first, last   ids forced at the start / end
 *   locked        ids that must be in the set
 *   noSameArtist  forbid the same artist twice in a row
 *   iterations, seed
 */
export function generateSet(pool, o = {}) {
  const weights = { ...Object.fromEntries(TRANSITION_CRITERIA.map((c) => [c.key, c.default])), ...(o.weights ?? {}) };
  const points = o.points ?? CURVE_PRESETS[0].points;
  const items = pool.filter((t) => t.score != null);
  if (!items.length) return emptyResult();
  const byId = new Map(items.map((t) => [t.id, t]));
  const locked = new Set((o.locked ?? []).filter((id) => byId.has(id)));
  if (o.first && byId.has(o.first)) locked.add(o.first);
  if (o.last && byId.has(o.last)) locked.add(o.last);
  const dur = (t) => t.duration ?? 200;
  const targetDur = o.duration && o.duration > 0 ? o.duration : null;

  let seed = o.seed ?? 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // ---- initial selection: locked tracks, then tracks spread over the score range
  let chosen = [...locked].map((id) => byId.get(id));
  const rest = items.filter((t) => !locked.has(t.id));
  if (targetDur) {
    // quantiles of the target curve drive which scores we need
    const sortedRest = [...rest].sort((a, b) => a.score - b.score);
    let total = chosen.reduce((a, t) => a + dur(t), 0);
    const want = [];
    const avgDur = rest.length ? rest.reduce((a, t) => a + dur(t), 0) / rest.length : 200;
    const n = Math.max(0, Math.round((targetDur - total) / avgDur));
    for (let i = 0; i < n; i++) want.push(curveAt(points, (i + 0.5) / n));
    const used = new Set();
    for (const w of want) {
      let best = null;
      for (const t of sortedRest) if (!used.has(t.id) && (!best || Math.abs(t.score - w) < Math.abs(best.score - w))) best = t;
      if (!best) break;
      used.add(best.id);
      chosen.push(best);
      total += dur(best);
    }
  } else {
    chosen = chosen.concat(rest);
  }

  // ---- initial order: rank assignment on the curve
  const order = rankAssign(chosen, points, dur);
  const pinEnds = (seq) => {
    if (o.first && byId.has(o.first)) { const i = seq.findIndex((t) => t.id === o.first); seq.unshift(...seq.splice(i, 1)); }
    if (o.last && byId.has(o.last) && o.last !== o.first) { const i = seq.findIndex((t) => t.id === o.last); seq.push(...seq.splice(i, 1)); }
  };
  pinEnds(order);

  const cost = (seq) => sequenceCost(seq, { points, weights, targetDur, noSameArtist: !!o.noSameArtist, dur });
  let cur = order, curCost = cost(cur);
  let best = cur.slice(), bestCost = curCost;
  const outside = () => items.filter((t) => !cur.includes(t));
  const iterations = o.iterations ?? Math.min(40000, 2000 + cur.length * 150);
  const fixedStart = o.first && byId.has(o.first) ? 1 : 0;
  const fixedEnd = o.last && byId.has(o.last) && o.last !== o.first ? 1 : 0;
  let T = 0.08;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length;
    const lo = fixedStart, hi = n - fixedEnd; // movable range [lo, hi)
    if (hi - lo < 1) break;
    const next = cur.slice();
    const r = rnd();
    if (r < 0.4 && hi - lo >= 2) {
      const i = lo + Math.floor(rnd() * (hi - lo)), j = lo + Math.floor(rnd() * (hi - lo));
      [next[i], next[j]] = [next[j], next[i]];
    } else if (r < 0.7 && hi - lo >= 2) {
      const i = lo + Math.floor(rnd() * (hi - lo));
      const [t] = next.splice(i, 1);
      next.splice(lo + Math.floor(rnd() * (hi - lo)), 0, t);
    } else if (targetDur) {
      const out = outside();
      const i = lo + Math.floor(rnd() * (hi - lo));
      const r2 = rnd();
      if (out.length && r2 < 0.6 && !locked.has(next[i].id)) next[i] = out[Math.floor(rnd() * out.length)];
      else if (out.length && r2 < 0.8) next.splice(i, 0, out[Math.floor(rnd() * out.length)]);
      else if (!locked.has(next[i].id) && next.length > 2) next.splice(i, 1);
    } else if (hi - lo >= 3) {
      // reverse a short segment
      const i = lo + Math.floor(rnd() * (hi - lo - 1));
      const j = Math.min(hi - 1, i + 1 + Math.floor(rnd() * 5));
      next.splice(i, j - i + 1, ...next.slice(i, j + 1).reverse());
    }
    const c = cost(next);
    if (c < curCost || rnd() < Math.exp((curCost - c) / T)) {
      cur = next;
      curCost = c;
      if (c < bestCost) { best = next.slice(); bestCost = c; }
    }
    T *= 0.9997;
  }
  return describeSet(best, { points, weights, dur, targetDur });
}

function rankAssign(tracks, points, dur) {
  const total = tracks.reduce((a, t) => a + dur(t), 0) || 1;
  // slots at the tracks' mean duration
  const n = tracks.length;
  const slots = Array.from({ length: n }, (_, i) => ({ i, y: curveAt(points, (i + 0.5) / n) }));
  const byTarget = [...slots].sort((a, b) => a.y - b.y || a.i - b.i);
  const byScore = [...tracks].sort((a, b) => a.score - b.score);
  const out = new Array(n);
  byTarget.forEach((s, k) => { out[s.i] = byScore[k]; });
  void total;
  return out;
}

export function sequenceCost(seq, { points, weights, targetDur, noSameArtist, dur }) {
  const total = seq.reduce((a, t) => a + dur(t), 0) || 1;
  let fit = 0, t0 = 0;
  for (const t of seq) {
    const mid = (t0 + dur(t) / 2) / total;
    t0 += dur(t);
    fit += ((t.score - curveAt(points, mid)) / 100) ** 2;
  }
  fit /= Math.max(1, seq.length);
  let trans = 0, artist = 0;
  for (let i = 1; i < seq.length; i++) {
    const p = transitionParts(seq[i - 1], seq[i]);
    trans += (weights.seam * p.seam + weights.bpm * p.bpm + weights.key * p.key + weights.timbre * p.timbre + weights.mood * p.mood);
    if (noSameArtist && seq[i].artist && seq[i].artist === seq[i - 1].artist) artist += 1;
  }
  trans /= Math.max(1, seq.length - 1);
  const durPen = targetDur ? ((total - targetDur) / Math.max(600, targetDur * 0.25)) ** 2 : 0;
  return weights.curve * fit * 12 + trans * 0.25 + durPen + artist * 0.5;
}

function describeSet(seq, { points, weights, dur }) {
  const total = seq.reduce((a, t) => a + dur(t), 0);
  let t0 = 0;
  const steps = seq.map((t, i) => {
    const mid = total ? (t0 + dur(t) / 2) / total : 0;
    const startAt = t0;
    t0 += dur(t);
    const parts = i ? transitionParts(seq[i - 1], t) : null;
    return {
      ...t, position: i + 1, startAt, target: Math.round(curveAt(points, mid) * 10) / 10,
      transition: parts ? { ...parts, fluidity: fluidity(parts, weights) } : null,
    };
  });
  const tr = steps.filter((s) => s.transition);
  const fit = steps.length ? Math.sqrt(steps.reduce((a, s) => a + (s.score - s.target) ** 2, 0) / steps.length) : 0;
  return {
    steps,
    stats: {
      count: steps.length,
      duration: total,
      curveError: Math.round(fit * 10) / 10,
      meanFluidity: tr.length ? Math.round(tr.reduce((a, s) => a + s.transition.fluidity, 0) / tr.length) : 100,
      rough: tr.filter((s) => s.transition.fluidity < 55).length,
    },
  };
}

function emptyResult() {
  return { steps: [], stats: { count: 0, duration: 0, curveError: 0, meanFluidity: 100, rough: 0 } };
}

/**
 * Splits tracks into n playlists by a key: "stage" (intensity), "mood"
 * (valence), or a group map (timbre clusters). Returns [{ label, ids }].
 */
export function splitTracks(items, by, n = 4, groupsMap = null) {
  if (by === "groups" && groupsMap) {
    const out = new Map();
    for (const t of items) {
      const g = groupsMap.get(t.id);
      if (g == null) continue;
      if (!out.has(g)) out.set(g, []);
      out.get(g).push(t);
    }
    return [...out.values()].map((list, i) => ({ label: `Groupe ${i + 1}`, ids: list.sort((a, b) => a.score - b.score).map((t) => t.id), items: list }));
  }
  const val = (t) => (by === "mood" ? t.valence : t.score);
  const sorted = items.filter((t) => val(t) != null).sort((a, b) => val(a) - val(b));
  const out = [];
  for (let k = 0; k < n; k++) {
    const part = sorted.slice(Math.floor((k * sorted.length) / n), Math.floor(((k + 1) * sorted.length) / n));
    if (!part.length) continue;
    out.push({ ids: part.map((t) => t.id), items: part, range: [val(part[0]), val(part.at(-1))] });
  }
  return out;
}
