// Turning a curve (one value per analysis window) into a single number.
// Scores can be assigned with any of the AGGREGATIONS; the other statistics
// (start, end, variability) are kept for sorting and playlist transitions.

import { AGGREGATIONS } from "../config.js";

const PEAK_SMOOTHING = 3; // windows (6 s, hop 3 s) -> "peak" is sustained over ~12 s

export function aggregate(values, mode, times = null) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return 0;
  switch (mode) {
    case "mean": return mean(v);
    case "median": return quantile([...v].sort((a, b) => a - b), 0.5);
    case "peak": return Math.max(...movingAverage(v, PEAK_SMOOTHING));
    case "topMean": {
      const sorted = [...v].sort((a, b) => b - a);
      return mean(sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.25))));
    }
    case "perceptual": {
      // power mean (p = 3) on 0..100 values: intense passages weigh more
      const p = 3;
      return 100 * mean(v.map((x) => Math.max(0, x / 100) ** p)) ** (1 / p);
    }
    case "start": return edge(v, times, "start");
    case "end": return edge(v, times, "end");
    case "variability": {
      const sorted = [...v].sort((a, b) => a - b);
      return quantile(sorted, 0.9) - quantile(sorted, 0.1);
    }
    default: throw new Error(`Unknown aggregation ${mode}`);
  }
}

/** Every statistic of a curve, rounded to 0.01 (display rounds once, not twice). */
export function aggregateAll(values, times) {
  const out = {};
  for (const key of [...AGGREGATIONS.map((a) => a.key), "start", "end", "variability"]) out[key] = round2(aggregate(values, key, times));
  return out;
}

const EDGE_SECONDS = 20;

function edge(v, times, which) {
  if (!times || times.length !== v.length) {
    const n = Math.max(1, Math.round(v.length * 0.15));
    return mean(which === "start" ? v.slice(0, n) : v.slice(-n));
  }
  if (which === "start") {
    const limit = times[0] + EDGE_SECONDS;
    return mean(v.filter((_, i) => times[i] <= limit));
  }
  const limit = times.at(-1) - EDGE_SECONDS;
  return mean(v.filter((_, i) => times[i] >= limit));
}

function movingAverage(v, k) {
  if (v.length <= k) return [mean(v)];
  const out = [];
  for (let i = 0; i + k <= v.length; i++) out.push(mean(v.slice(i, i + k)));
  return out;
}

function mean(a) { return a.reduce((x, y) => x + y, 0) / Math.max(1, a.length); }
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function round2(x) { return Math.round(x * 100) / 100; }
