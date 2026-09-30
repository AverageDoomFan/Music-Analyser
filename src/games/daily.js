// Rules of the "Daily track" game (pure, tested in Node): one Spotify track a
// day, drawn from a date-seeded search, the same for everyone on that date.

/** Local calendar date as "YYYY-MM-DD". */
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The day before / after a "YYYY-MM-DD" key (computed in UTC: no DST surprises). */
export function shiftDay(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** 32-bit FNV-1a hash of a string. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded generator (mulberry32): same seed, same sequence, values in [0, 1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Common words found in titles of every genre: the search seeds. */
export const DAILY_WORDS = [
  "love", "night", "fire", "heart", "dream", "time", "life", "light", "dance", "world",
  "rain", "blue", "gold", "sun", "moon", "star", "home", "wild", "run", "baby",
  "girl", "boy", "summer", "city", "road", "river", "sky", "ocean", "king", "queen",
  "black", "red", "green", "storm", "thunder", "ghost", "angel", "devil", "fever", "high",
  "down", "free", "young", "money", "party", "shadow", "echo", "wave", "electric", "rock",
  "soul", "blood", "dust", "glass", "neon", "velvet", "paradise", "tonight", "forever", "hello",
];

/** Spotify caps the search offset; results beyond a few hundred get obscure. */
export const MAX_OFFSET = 300;

/**
 * Search of the day. `attempt` > 0 gives the fallbacks (another word, another
 * offset) used when a search returns no suitable track.
 * @returns {{q: string, offset: number}}
 */
export function dailyQuery(key, attempt = 0) {
  const rand = seededRandom(hashString(`${key}#${attempt}`));
  const q = DAILY_WORDS[Math.floor(rand() * DAILY_WORDS.length)];
  const offset = Math.floor(rand() * (MAX_OFFSET / (attempt + 1)));
  return { q, offset };
}

/** A track the scan can play and analyse: a real Spotify track of 1.5 to 8 minutes. */
export const eligible = (t) =>
  !!t && !t.isLocal && typeof t.uri === "string" && t.uri.startsWith("spotify:track:") &&
  t.durationMs >= 90_000 && t.durationMs <= 8 * 60_000;

/**
 * The track of the day among search results: sorted by id first, so the pick
 * does not depend on the order Spotify returns them in.
 */
export function pickDaily(results, key) {
  const list = (results ?? []).filter(eligible).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!list.length) return null;
  const rand = seededRandom(hashString(`${key}/pick`));
  return list[Math.floor(rand() * list.length)];
}

/** Points of a guess: 100 on the dot, 0 from 25 away. */
export const dailyPoints = (guess, score) => Math.max(0, Math.round(100 - 4 * Math.abs(guess - score)));

/** How close a guess is: "bullseye" (≤ 2), "spot" (≤ 5), "close" (≤ 12) or "far". */
export function verdictOf(guess, score) {
  const err = Math.abs(guess - score);
  return err <= 2 ? "bullseye" : err <= 5 ? "spot" : err <= 12 ? "close" : "far";
}

/**
 * Consecutive days played, ending today (or yesterday when today is not played
 * yet: the streak is still alive until midnight).
 * @param {Record<string, object>} results  date key -> result
 */
export function dailyStreak(results, today) {
  let day = results?.[today] ? today : shiftDay(today, -1);
  let n = 0;
  while (results?.[day]) {
    n++;
    day = shiftDay(day, -1);
  }
  return n;
}

/** Longest run of consecutive days ever played. */
export function bestStreak(results) {
  const days = Object.keys(results ?? {}).sort();
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    run = prev && shiftDay(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/**
 * Share of a track scan already heard (0..1): excerpts heard over the planned
 * ones, the final analysis counting for the last 8 %.
 * @param {object|null} cur  the scanner's current track status
 */
export function scanProgress(cur) {
  if (!cur) return 0;
  if (cur.final) return 1;
  if (cur.finalizing) return 0.94;
  const plan = cur.plan ?? [];
  const total = plan.reduce((a, s) => a + (s.len ?? 0), 0);
  if (!total) return 0.02;
  const heard = plan.reduce((a, s) => a + (s.state === "done" ? s.len ?? 0 : s.state === "recording" ? s.filled ?? 0 : 0), 0);
  // adaptive scans add focused excerpts after the probes: keep room for them
  const onlyProbes = plan.every((s) => s.kind === "probe");
  return Math.min(0.92, (heard / total) * (onlyProbes ? 0.45 : 0.92));
}

/** One-line result to paste anywhere (emoji squares like the word games). */
export function shareLine(key, { guess, score, points }, streak = 0) {
  const err = Math.abs(guess - score);
  const blocks = Math.max(0, Math.min(5, Math.round(points / 20)));
  const bar = "🟩".repeat(blocks) + "⬛".repeat(5 - blocks);
  const icon = { bullseye: "🎯", spot: "✨", close: "👌", far: "🎲" }[verdictOf(guess, score)];
  return `Music Energy daily ${key} ${icon} ${bar} ${points} pts (±${Math.round(err)})${streak > 1 ? ` 🔥${streak}` : ""}`;
}
