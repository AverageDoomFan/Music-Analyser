// What to listen to in a track, per scan mode. Pure functions (tested in Node).
//
// full      the whole track, in real time
// fixed     N excerpts of L seconds at evenly spaced positions
// adaptive  short probes spaced at most `maxGap` seconds apart (a chorus or a
//           drop lasts longer than that, so at least one probe lands in it),
//           then the remaining budget is spent listening longer around the
//           most intense probes

import { t } from "../i18n/index.js";

export const SCAN_MODES = [
  { key: "adaptive", label: t("Adaptive"), hint: t("Short probes over the whole track, then longer listening around the most intense passages (drops, choruses).") },
  { key: "fixed", label: t("Fixed excerpts"), hint: t("N excerpts of L seconds, evenly spread.") },
  { key: "full", label: t("Whole track"), hint: t("Full real-time listening: the analysis is identical to a file's.") },
];

export const SCAN_DEFAULTS = Object.freeze({
  mode: "adaptive",
  count: 4,          // fixed: number of excerpts
  length: 12,        // fixed: seconds per excerpt
  budget: 75,        // adaptive: maximum listening time per track (s)
  maxGap: 20,        // adaptive: maximum spacing between probes (s)
  probeLength: 3,    // adaptive: seconds per probe
  focusLength: 18,   // adaptive: seconds per focused excerpt
  overhead: 1.2,     // estimated cost of one jump (pause, seek, restart), refined while scanning
});

/** Coverage rank: a track analysed in a better mode is never rescanned in a lesser one. */
export const MODE_RANK = { fixed: 1, adaptive: 2, follow: 2, full: 3 };

const clampPos = (pos, len, duration) => Math.max(0, Math.min(Math.max(0, duration - len - 0.5), pos));

export function fullPlan(duration) {
  return [{ pos: 0, len: Math.max(1, duration - 0.3), kind: "full" }];
}

export function fixedPlan(duration, { count = SCAN_DEFAULTS.count, length = SCAN_DEFAULTS.length } = {}) {
  const len = Math.min(length, duration);
  if (count * len >= duration * 0.9) return fullPlan(duration);
  const out = [];
  for (let i = 0; i < count; i++) {
    const pos = clampPos((duration * (i + 0.5)) / count - len / 2, len, duration);
    out.push({ pos, len, kind: "extract" });
  }
  return out;
}

export function probePlan(duration, { maxGap = SCAN_DEFAULTS.maxGap, probeLength = SCAN_DEFAULTS.probeLength } = {}) {
  const n = Math.max(4, Math.ceil(duration / maxGap));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ pos: clampPos((duration * (i + 0.5)) / n - probeLength / 2, probeLength, duration), len: probeLength, kind: "probe" });
  }
  return out;
}

/**
 * Focused excerpts around the most intense probes.
 * @param {{pos:number,len:number,score:number}[]} probes  scored probes
 * @param {number} budgetLeft seconds still available for this track
 */
export function focusPlan(probes, duration, budgetLeft, {
  focusLength = SCAN_DEFAULTS.focusLength, overhead = SCAN_DEFAULTS.overhead, minLength = 8, margin = 20,
} = {}) {
  const ranked = probes.filter((p) => Number.isFinite(p.score)).sort((a, b) => b.score - a.score);
  if (!ranked.length) return [];
  const best = ranked[0].score;
  const out = [];
  let left = budgetLeft;
  for (const p of ranked) {
    if (p.score < best - margin) break;
    const len = Math.min(focusLength, left - overhead, duration);
    if (len < minLength) break;
    // start a little before the probe: the probe may sit at the start of the passage
    const pos = clampPos(p.pos - 5, len, duration);
    if (out.some((s) => pos < s.pos + s.len && s.pos < pos + len)) continue;
    out.push({ pos, len, kind: "focus", probe: p.pos });
    left -= len + overhead;
  }
  return out;
}

/** Seconds left for focused listening once the probes are done (at least one focused excerpt). */
export function focusBudget(probes, opts = SCAN_DEFAULTS) {
  const o = { ...SCAN_DEFAULTS, ...opts };
  const spent = probes.reduce((a, s) => a + s.len + o.overhead, 0);
  return Math.max(o.budget - spent, o.focusLength + o.overhead);
}

/** Listening time estimate for one track (for the ETA). */
export function estimateTrackSeconds(duration, opts = SCAN_DEFAULTS) {
  const o = { ...SCAN_DEFAULTS, ...opts };
  if (o.mode === "full") return duration + o.overhead;
  if (o.mode === "fixed") return fixedPlan(duration, o).reduce((a, s) => a + s.len + o.overhead, 0);
  const probes = probePlan(duration, o).reduce((a, s) => a + s.len + o.overhead, 0);
  return Math.min(duration + o.overhead, Math.max(probes + o.focusLength + o.overhead, o.budget));
}

/** Seconds of the track covered by a set of excerpts (overlaps counted once). */
export function coveredSeconds(segments) {
  const s = [...segments].sort((a, b) => a.pos - b.pos);
  let total = 0, end = -Infinity;
  for (const g of s) {
    const a = Math.max(g.pos, end);
    const b = g.pos + g.len;
    if (b > a) total += b - a;
    end = Math.max(end, b);
  }
  return total;
}
