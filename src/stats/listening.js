// Listening log of the Live follow mode: pure aggregation (no DOM, no storage).
//
// Entry shape (one per followed track heard long enough):
//   { id?, at, endedAt, recordId, trackId?, name, heardSeconds, coverage, score, draft, kept?, genre? }
//   at / endedAt: ms timestamps (start of the listen, when the track changed)
//   score: intensity of the track (null when unknown); genre is filled in by the UI.
// Times are read in the browser's local time zone.

import { STAGES } from "../config.js";

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/** Monday = 0 … Sunday = 6. */
export const weekday = (date) => (date.getDay() + 6) % 7;

/** "YYYY-MM" of a timestamp (local time). */
export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" of a timestamp (local time). */
export function dayKey(ts) {
  const d = new Date(ts);
  return `${monthKey(ts)}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Start / end (ms) of a month key. */
export function monthRange(key) {
  const [y, m] = key.split("-").map(Number);
  return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
}

export const previousMonth = (key) => {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 2, 15).getTime());
};

/** Index of the stage of a score in STAGES (0..). */
export function stageIndex(score) {
  let k = 0;
  STAGES.forEach((s, i) => { if (score >= s.min) k = i; });
  return k;
}

/** Keeps well-formed entries, with sane numbers. */
export function cleanListens(list) {
  return (list ?? [])
    .filter((e) => e && Number.isFinite(e.at) && e.heardSeconds > 0)
    .map((e) => ({
      ...e,
      endedAt: Number.isFinite(e.endedAt) && e.endedAt >= e.at ? e.endedAt : e.at + e.heardSeconds * 1000,
      score: Number.isFinite(e.score) ? e.score : null,
    }))
    .sort((a, b) => a.at - b.at);
}

/**
 * Splits a listen over the wall-clock hours it spans: [{ start, seconds }],
 * the heard seconds shared in proportion of the time spent in each hour.
 */
export function splitByHour(e) {
  const heard = e.heardSeconds;
  let from = e.at;
  // the listen cannot be shorter than what was heard
  const to = Math.max(e.endedAt ?? from, from + heard * 1000);
  const span = to - from;
  const out = [];
  while (from < to) {
    const d = new Date(from);
    const next = Math.min(to, new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime());
    out.push({ start: from, seconds: (heard * (next - from)) / span });
    from = next;
  }
  if (!out.length) out.push({ start: e.at, seconds: heard });
  return out;
}

/**
 * Days-of-week × hours heatmap: grid[day][hour] = { seconds, avg (time-weighted
 * intensity, null without scores), count }. Also the totals by hour and day.
 */
export function heatmapBins(listens) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ seconds: 0, scored: 0, sum: 0, count: 0 })));
  for (const e of listens) {
    for (const part of splitByHour(e)) {
      const d = new Date(part.start);
      const c = grid[weekday(d)][d.getHours()];
      c.seconds += part.seconds;
      c.count++;
      if (e.score != null) { c.scored += part.seconds; c.sum += part.seconds * e.score; }
    }
  }
  let max = 0;
  const cells = grid.map((row) => row.map((c) => {
    max = Math.max(max, c.seconds);
    return { seconds: c.seconds, count: c.count, avg: c.scored > 0 ? c.sum / c.scored : null };
  }));
  const byHour = Array.from({ length: 24 }, (_, h) => cells.reduce((a, row) => a + row[h].seconds, 0));
  const byDay = cells.map((row) => row.reduce((a, c) => a + c.seconds, 0));
  return { cells, max, byHour, byDay };
}

/** Months with listens, most recent first. */
export function listenMonths(listens) {
  return [...new Set(listens.map((e) => monthKey(e.at)))].sort().reverse();
}

/** Time-weighted average intensity of listens (null when none is scored). */
export function weightedIntensity(listens) {
  let w = 0, s = 0;
  for (const e of listens) if (e.score != null) { w += e.heardSeconds; s += e.heardSeconds * e.score; }
  return w > 0 ? s / w : null;
}

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);

/**
 * "Wrapped"-style summary of one month:
 *   minutes, listens, uniqueTracks, activeDays, avg (intensity), over100 (share of time),
 *   hardest (most intense track heard), hardestDay { day, avg, minutes }, peakHour { hour, minutes },
 *   stages [seconds per STAGES entry], genres [{ genre, minutes }], topTracks [{ name, recordId, plays, minutes, score }],
 *   days [{ day, minutes, avg }] (every day of the month), previous { minutes, avg } (month before).
 * A listen counts in the month it started.
 */
export function monthlySummary(allListens, month) {
  const [from, to] = monthRange(month);
  const listens = allListens.filter((e) => e.at >= from && e.at < to);
  const seconds = listens.reduce((a, e) => a + e.heardSeconds, 0);
  const tracks = new Map();
  const genres = new Map();
  const stages = STAGES.map(() => 0);
  const days = new Map();
  const hours = Array(24).fill(0);
  let hardest = null;
  let over = 0, scoredTime = 0;
  for (const e of listens) {
    const key = e.recordId ?? e.name;
    const t = tracks.get(key) ?? { name: e.name, recordId: e.recordId ?? null, plays: 0, seconds: 0, score: e.score };
    t.plays++;
    t.seconds += e.heardSeconds;
    if (e.score != null) t.score = e.score;
    tracks.set(key, t);
    if (e.genre) genres.set(e.genre, (genres.get(e.genre) ?? 0) + e.heardSeconds);
    if (e.score != null) {
      stages[stageIndex(e.score)] += e.heardSeconds;
      scoredTime += e.heardSeconds;
      if (e.score > 100) over += e.heardSeconds;
      if (!hardest || e.score > hardest.score) hardest = { name: e.name, recordId: e.recordId ?? null, score: e.score, at: e.at };
    }
    const dk = dayKey(e.at);
    const d = days.get(dk) ?? { list: [] };
    d.list.push(e);
    days.set(dk, d);
    for (const part of splitByHour(e)) hours[new Date(part.start).getHours()] += part.seconds;
  }
  // every day of the month, for the per-day chart
  const dayList = [];
  const [y, mo] = month.split("-").map(Number);
  for (let n = 1; new Date(y, mo - 1, n).getMonth() === mo - 1; n++) {
    const dk = dayKey(new Date(y, mo - 1, n).getTime());
    const list = days.get(dk)?.list ?? [];
    dayList.push({ day: dk, minutes: list.reduce((a, e) => a + e.heardSeconds, 0) / 60, avg: weightedIntensity(list) });
  }
  // the most intense day: highest average among days with at least 5 minutes (else any day)
  const candidates = dayList.filter((d) => d.avg != null);
  const solid = candidates.filter((d) => d.minutes >= 5);
  const hardestDay = (solid.length ? solid : candidates).reduce((b, d) => (!b || d.avg > b.avg ? d : b), null);
  const peak = hours.reduce((b, s, h) => (s > b.seconds ? { hour: h, seconds: s } : b), { hour: null, seconds: 0 });
  const prevList = allListens.filter((e) => monthKey(e.at) === previousMonth(month));
  return {
    month,
    minutes: seconds / 60,
    listens: listens.length,
    uniqueTracks: tracks.size,
    activeDays: days.size,
    avg: weightedIntensity(listens),
    over100: scoredTime > 0 ? over / scoredTime : 0,
    hardest,
    hardestDay,
    peakHour: peak.hour == null ? null : { hour: peak.hour, minutes: peak.seconds / 60 },
    stages,
    genres: top(genres, 5).map(([genre, s]) => ({ genre, minutes: s / 60 })),
    topTracks: [...tracks.values()].sort((a, b) => b.plays - a.plays || b.seconds - a.seconds).slice(0, 5)
      .map((t) => ({ ...t, minutes: t.seconds / 60 })),
    days: dayList,
    previous: prevList.length ? { minutes: prevList.reduce((a, e) => a + e.heardSeconds, 0) / 60, avg: weightedIntensity(prevList) } : null,
  };
}

/** All-time totals: { minutes, listens, uniqueTracks, activeDays, avg, streak (longest run of consecutive days) }. */
export function listeningTotals(listens) {
  const days = [...new Set(listens.map((e) => dayKey(e.at)))].sort();
  let streak = 0, run = 0, prev = null;
  for (const d of days) {
    const ts = new Date(`${d}T12:00:00`).getTime();
    run = prev != null && Math.round((ts - prev) / DAY) === 1 ? run + 1 : 1;
    streak = Math.max(streak, run);
    prev = ts;
  }
  return {
    minutes: listens.reduce((a, e) => a + e.heardSeconds, 0) / 60,
    listens: listens.length,
    uniqueTracks: new Set(listens.map((e) => e.recordId ?? e.name)).size,
    activeDays: days.length,
    avg: weightedIntensity(listens),
    streak,
  };
}

/** Most recent listens grouped by day: [{ day, items }] (newest first). */
export function recentByDay(listens, limit = 40) {
  const recent = [...listens].sort((a, b) => b.at - a.at).slice(0, limit);
  const groups = [];
  for (const e of recent) {
    const day = dayKey(e.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1).items.push(e);
  }
  return groups;
}
