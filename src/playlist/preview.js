// Drop preview of a progression: a few seconds of each track, from just
// before its biggest drop (the most intense landing), else its most intense
// passage. Pure functions, used by the Progression tab.

import { detectDrops } from "../ui/concert-logic.js";

export const PREVIEW_SECONDS = 8;
const LEAD = 1.5; // s of build-up heard before the drop lands

const finite = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * Where to preview a record: { start, len, drop } (drop = a detected drop,
 * false = the most intense passage, null = no curve: from 40 % of the track).
 */
export function previewWindow(r, len = PREVIEW_SECONDS) {
  const c = r?.auto?.curves;
  const duration = [r?.duration, r?.features?.duration].find((x) => finite(x) && x > 0) ?? null;
  const span = duration != null ? Math.min(len, duration) : len;
  // ends half a second before the track does (the end of a track stops the player)
  const fit = (t) => Math.max(0, duration != null ? Math.min(t, duration - span - 0.5) : t);
  const times = c?.times;
  if (!times?.length || !c.intensity?.length) {
    return { start: fit((duration ?? 0) * 0.4), len: span, drop: null };
  }
  const intensity = c.intensity.map((v) => (finite(v) ? v : 0));
  const sections = (r.auto?.music?.sections ?? r.features?.sections ?? []).filter((s) => finite(s?.start));
  const drops = detectDrops(times, intensity, sections);
  if (drops.length) {
    const best = drops.reduce((a, d) => (d.to > a.to || (d.to === a.to && d.rise > a.rise) ? d : a));
    return { start: fit(best.time - LEAD), len: span, drop: true };
  }
  // no drop: the window of the most intense moment (times are window centres)
  let k = 0;
  for (let i = 1; i < intensity.length; i++) if (intensity[i] > intensity[k]) k = i;
  return { start: fit(times[k] - span / 2), len: span, drop: false };
}
