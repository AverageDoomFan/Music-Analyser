// Library profile: distributions over the counted records (pure, no DOM).

import { STAGES, DIMENSIONS } from "../config.js";
import { isCounted } from "../core/track.js";
import { stageIndex } from "./listening.js";

/** Records the stats use: analysed, not drafts, not test-bench tracks. */
export const profileRecords = (records) => [...records].filter((r) => isCounted(r) && r.source?.kind !== "test");

export const BPM_BINS = [60, 80, 100, 120, 140, 160, 180, 200, 250];

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {Iterable<object>} records   track records (filtered here)
 * @param {{ genreOf?: (r) => string|null }} [o]   top-level genre of a record
 */
export function libraryProfile(records, { genreOf = () => null } = {}) {
  const list = profileRecords(records);
  const scores = list.map((r) => r.finalScore);
  const stages = STAGES.map(() => 0);
  for (const s of scores) stages[stageIndex(s)]++;
  // BPM: [<60, 60-80, …, 200-250, ≥250]
  const bpm = Array(BPM_BINS.length + 1).fill(0);
  let bpmKnown = 0;
  const keys = new Map();
  const modes = { major: 0, minor: 0 };
  const genres = new Map();
  const sums = Object.fromEntries(DIMENSIONS.map((d) => [d.key, 0]));
  let subN = 0;
  for (const r of list) {
    const m = r.auto?.music ?? {};
    const b = m.tempo?.bpm ?? r.features?.bpm;
    if (Number.isFinite(b) && b > 0) {
      bpmKnown++;
      let i = 0;
      while (i < BPM_BINS.length && b >= BPM_BINS[i]) i++;
      bpm[i]++;
    }
    if (m.key?.name) {
      keys.set(m.key.name, (keys.get(m.key.name) ?? 0) + 1);
      if (m.key.index >= 12) modes.minor++;
      else modes.major++;
    }
    const g = genreOf(r);
    if (g) genres.set(g, (genres.get(g) ?? 0) + 1);
    const sub = { ...(r.auto?.subscores ?? {}), ...(r.correction?.overrides ?? {}) };
    if (r.auto?.subscores) {
      subN++;
      for (const d of DIMENSIONS) sums[d.key] += sub[d.key] ?? 0;
    }
  }
  const byScore = [...list].sort((a, b) => b.finalScore - a.finalScore);
  const item = (r) => ({ id: r.id, name: r.name, score: r.finalScore });
  const sortedCounts = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  return {
    count: list.length,
    avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    median: median(scores),
    over100: scores.length ? scores.filter((s) => s > 100).length / scores.length : 0,
    stages,
    bpm, bpmKnown,
    modes,
    keys: sortedCounts(keys, 6).map(([key, n]) => ({ key, n })),
    genres: sortedCounts(genres, 8).map(([genre, n]) => ({ genre, n })),
    genreKnown: [...genres.values()].reduce((a, b) => a + b, 0),
    subscores: subN ? Object.fromEntries(DIMENSIONS.map((d) => [d.key, sums[d.key] / subN])) : null,
    top: byScore.slice(0, 5).map(item),
    bottom: byScore.slice(-5).reverse().map(item),
  };
}
