// Compact shapes of what goes to the shared database (pure, tested in Node).
//
// Everything here is about keeping the database small: one shared track is a
// ~1 KB metadata doc plus a few KB of packed measures, whatever the number of
// users who have it. No audio, no lyrics, no cover art is ever stored: only
// numbers measured by the app, the title and artist (to search), and ids.

/** Dotted version → integer that sorts the same way ("1.8" → 10800, "1.10" → 11000). */
export function versionCode(v) {
  const [a = 0, b = 0, c = 0] = String(v ?? "0").split(".").map((x) => Number.parseInt(x, 10) || 0);
  return a * 10000 + Math.min(99, b) * 100 + Math.min(99, c);
}

/** Lower case, no accents, letters and digits only. */
export function normalizeText(s) {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const STOP = new Set(["the", "a", "an", "of", "and", "le", "la", "les", "de", "des", "du", "et", "feat", "ft", "remastered", "remaster", "version", "edit", "radio", "mix"]);

/** Search words of a track: unique words of the title and the artist (24 at most). */
export function keywords(title, artist) {
  const words = normalizeText(`${title ?? ""} ${artist ?? ""}`).split(" ").filter((w) => w.length >= 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 24);
}

/** The words of a query, longest first (the longest one narrows the database query best). */
export function queryWords(q) {
  return [...new Set(normalizeText(q).split(" ").filter((w) => w.length >= 2 && !STOP.has(w)))].sort((a, b) => b.length - a.length);
}

/** True when every query word is a prefix of one of the track's words. */
export function matchesQuery(kw, words) {
  return words.every((w) => kw.some((k) => k.startsWith(w)));
}

/** Mean of the votes (null without votes). */
export const communityMean = (vs, vc) => (vc > 0 && Number.isFinite(vs) ? Math.round((vs / vc) * 10) / 10 : null);

/** A vote is an integer score (the counters stay exact integers). */
export const voteValue = (score) => (Number.isFinite(score) ? Math.max(0, Math.min(1000, Math.round(score))) : null);

/**
 * Change of the track's counters when my vote goes from `before` to `after`
 * (null = no vote): { dc, ds } or null when nothing changes.
 */
export function voteDelta(before, after) {
  if (before === after) return null;
  return {
    dc: (after != null ? 1 : 0) - (before != null ? 1 : 0),
    ds: (after ?? 0) - (before ?? 0),
  };
}

// ---------- packed measures ----------

const MAGIC = 0x4d454131; // "MEA1"
const NULL_Q = 65535;
const STEPS = 65534;

const sig4 = (x) => (x === 0 ? 0 : Number(x.toPrecision(4)));

/**
 * Packs a features object: the timeline's columns become 16-bit integers
 * (each column scaled between its own min and max: error below 1/65534 of its
 * range), everything else stays JSON; the whole is gzipped.
 * @returns {Promise<Uint8Array>}
 */
export async function packFeatures(features) {
  const tl = features.timeline;
  const series = tl?.series ?? {};
  const keys = Object.keys(series).filter((k) => Array.isArray(series[k]) || ArrayBuffer.isView(series[k]));
  const n = tl?.times?.length ?? 0;
  const cols = keys.map((k) => {
    const arr = Array.from(series[k], (v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
    let lo = Infinity, hi = -Infinity;
    for (const v of arr) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (lo === Infinity) { lo = 0; hi = 0; }
    return { k, lo, hi, arr };
  });
  const head = { ...features };
  if (tl) {
    head.timeline = { ...tl, times: undefined, series: undefined, n, cols: cols.map(({ k, lo, hi }) => [k, lo, hi]) };
  }
  const json = new TextEncoder().encode(JSON.stringify(head));
  const size = 8 + json.length + (json.length % 4 ? 4 - (json.length % 4) : 0) + n * 4 + cols.length * n * 2;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC);
  view.setUint32(4, json.length);
  new Uint8Array(buf, 8, json.length).set(json);
  let o = 8 + json.length + (json.length % 4 ? 4 - (json.length % 4) : 0);
  for (let i = 0; i < n; i++, o += 4) view.setFloat32(o, tl.times[i], true);
  // high bytes of every value, then the low bytes: gzip finds more repeats
  const plane = cols.length * n;
  let j = 0;
  for (const c of cols) {
    const span = c.hi - c.lo;
    for (let i = 0; i < n; i++, j++) {
      const v = c.arr[i];
      const q = v == null ? NULL_Q : span > 0 ? Math.round(((v - c.lo) / span) * STEPS) : 0;
      view.setUint8(o + j, q >> 8);
      view.setUint8(o + plane + j, q & 255);
    }
  }
  return gzip(new Uint8Array(buf));
}

/** Inverse of packFeatures. */
export async function unpackFeatures(bytes) {
  const raw = await gunzip(bytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0) !== MAGIC) throw new Error("Unknown packed features.");
  const len = view.getUint32(4);
  const head = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + len)));
  const tl = head.timeline;
  if (!tl?.cols) return head;
  const n = tl.n;
  let o = 8 + len + (len % 4 ? 4 - (len % 4) : 0);
  const times = [];
  for (let i = 0; i < n; i++, o += 4) times.push(sig4(view.getFloat32(o, true)));
  const series = {};
  const plane = tl.cols.length * n;
  let j = 0;
  for (const [k, lo, hi] of tl.cols) {
    const out = new Array(n);
    const span = hi - lo;
    for (let i = 0; i < n; i++, j++) {
      const q = (raw[o + j] << 8) | raw[o + plane + j];
      out[i] = q === NULL_Q ? null : sig4(lo + (span * q) / STEPS);
    }
    series[k] = out;
  }
  const { cols, n: _n, ...rest } = tl;
  head.timeline = { ...rest, times, series };
  return head;
}

// ---------- gzip (CompressionStream: browsers and Node 18+) ----------

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
export const gzip = (bytes) => pipe(bytes, new CompressionStream("gzip"));
export const gunzip = (bytes) => pipe(bytes, new DecompressionStream("gzip"));
export const gzipJson = (value) => gzip(new TextEncoder().encode(JSON.stringify(value)));
export const gunzipJson = async (bytes) => JSON.parse(new TextDecoder().decode(await gunzip(bytes)));

// ---------- friend codes ----------

/** Letters and digits that cannot be mistaken for one another (no I, O, 0, 1). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random 8-character friend code (crypto random). */
export function randomCode(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const b = rand(8);
  return Array.from(b, (x) => CODE_ALPHABET[x % 32]).join("");
}

/** Typed code → canonical form (spaces, dashes and case ignored), or null. */
export function cleanCode(s) {
  const c = String(s ?? "").toUpperCase().replace(/[\s-]+/g, "");
  return /^[A-HJ-NP-Z2-9]{8}$/.test(c) ? c : null;
}

/** "ABCD-EFGH": easier to read out. */
export const showCode = (c) => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : "");

// ---------- user names ----------

/** A valid display name (2 to 30 characters, trimmed, inner spaces collapsed) or null. */
export function cleanName(s) {
  const n = String(s ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return n.length >= 2 && n.length <= 30 ? n : null;
}

// ---------- leaderboards ----------

export const BOARDS = ["daily", "trivia", "compare", "hunt"];
export const dayBoard = (dateKey) => `day-${dateKey}`;

/**
 * Leaderboard values from the games' local stats: { board: { v, x } }.
 *   daily: total points of the daily tracks (x: best streak), trivia: total
 *   points (x: best streak), compare: agreements with the model (x: duels),
 *   hunt: bullseyes (x: hunts).
 */
export function boardValues(stats, dailyResults = {}, bestDailyStreak = 0) {
  const results = Object.values(dailyResults ?? {});
  return {
    daily: { v: results.reduce((a, r) => a + (Number.isFinite(r?.points) ? r.points : 0), 0), x: bestDailyStreak },
    trivia: { v: stats?.points ?? 0, x: stats?.bestStreak ?? 0 },
    compare: { v: stats?.agree ?? 0, x: stats?.duels ?? 0 },
    hunt: { v: stats?.bullseyes ?? 0, x: stats?.hunts ?? 0 },
  };
}

// ---------- profile summaries (shown on the account page to others) ----------

const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** Library profile (stats/library.js) without record ids, rounded. */
export function libraryCard(p) {
  if (!p?.count) return null;
  const item = (x) => ({ name: String(x.name ?? "").slice(0, 120), score: r1(x.score) });
  return {
    count: p.count, avg: r1(p.avg), median: r1(p.median), over100: r1(p.over100 * 1000) / 1000,
    stages: p.stages, bpm: p.bpm, bpmKnown: p.bpmKnown, modes: p.modes,
    keys: p.keys, genres: p.genres, genreKnown: p.genreKnown,
    subscores: p.subscores ? Object.fromEntries(Object.entries(p.subscores).map(([k, v]) => [k, r1(v)])) : null,
    top: p.top.map(item), bottom: p.bottom.map(item),
  };
}

/** Listening totals and the day × hour heatmap (seconds and intensity per cell). */
export function listeningCard(totals, heat) {
  if (!totals?.listens) return null;
  return {
    minutes: Math.round(totals.minutes), listens: totals.listens, uniqueTracks: totals.uniqueTracks,
    activeDays: totals.activeDays, avg: r1(totals.avg), streak: totals.streak,
    // 7 × 24 cells: [seconds, intensity]; Firestore has no nested arrays, hence the flat list
    heat: heat ? heat.cells.flat().map((c) => [Math.round(c.seconds), c.avg == null ? -1 : Math.round(c.avg)]).flat() : null,
  };
}

/** The heatmap's bins (stats/listening.js heatmapBins shape) from a listening card. */
export function heatFromCard(card) {
  const flat = card?.heat;
  if (!Array.isArray(flat) || flat.length !== 7 * 24 * 2) return null;
  const cells = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => {
    const i = (d * 24 + h) * 2;
    return { seconds: flat[i], count: flat[i] ? 1 : 0, avg: flat[i + 1] < 0 ? null : flat[i + 1] };
  }));
  let max = 0;
  for (const row of cells) for (const c of row) max = Math.max(max, c.seconds);
  return {
    cells, max,
    byHour: Array.from({ length: 24 }, (_, h) => cells.reduce((a, row) => a + row[h].seconds, 0)),
    byDay: cells.map((row) => row.reduce((a, c) => a + c.seconds, 0)),
  };
}

/** Diagnostic tracks cut down to what the duel uses (see stats/duel.js). */
const DUEL_F = ["plr", "src", "cr", "cen", "bass", "flat", "bpm", "on", "xr"];
export function duelTracks(diagTracks) {
  return (diagTracks ?? []).filter((x) => !String(x.src ?? "").startsWith("test") && !x.d).map((x) => ({
    n: x.n, ...(x.sid ? { sid: x.sid } : {}), src: x.src, s: x.s, a: x.a, g: x.g ?? null, k: x.k ?? null,
    u: x.u ?? {}, sub: x.sub ?? {},
    f: Object.fromEntries(DUEL_F.filter((k) => x.f?.[k] != null).map((k) => [k, x.f[k]])),
  }));
}
