// Matching Spotify tracks with local files (pure functions).
// Priority: identical ISRC (from the file's tags) → certain match. Otherwise
// a similarity of normalised titles and artists, adjusted by how close the
// durations are. Assignment is one-to-one, best pairs first; manual choices
// always win.

import { parseFileName } from "../util/tags.js";

const MIN_SCORE = 0.55;

/** Lowercase, no accents, no "feat." / remaster / version decorations, no punctuation. */
export function normalize(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([](?:[^)\]]*\b(?:feat|ft|featuring|remaster(?:ed)?|version|edit|radio|mono|stereo|explicit|bonus|deluxe)\b[^)\]]*)[)\]]/g, " ")
    .replace(/\s[-–—]\s.*\b(?:remaster(?:ed)?|version|edit|mix|live)\b.*$/g, " ")
    .replace(/\b(?:feat|ft|featuring)\b\.?.*$/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Sørensen–Dice on character bigrams (robust to small spelling differences). */
export function similarity(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => {
    const m = new Map();
    const t = ` ${s} `;
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = grams(x), B = grams(y);
  let inter = 0, total = 0;
  for (const [g, n] of A) { inter += Math.min(n, B.get(g) ?? 0); total += n; }
  for (const n of B.values()) total += n;
  return (2 * inter) / total;
}

/** What we know about a local file for matching. */
export function localInfo(record) {
  const fromName = parseFileName(record.name ?? "");
  const tags = record.tags ?? {};
  return {
    title: tags.title || fromName.title || record.name,
    artist: tags.artist || fromName.artist || "",
    isrc: tags.isrc || null,
    durationMs: record.duration ? record.duration * 1000 : null,
    name: record.name ?? "",
    spotifyId: record.source?.kind === "spotify" ? record.source.trackId : null,
  };
}

/** 0..1 confidence that a Spotify track and a local file are the same recording. */
export function matchScore(track, local) {
  if (local.spotifyId) {
    // captured from Spotify: exact identity, or the same recording under another id (other album, relinked)
    if (local.spotifyId === track.id) return 1;
    return track.isrc && local.isrc && track.isrc.toUpperCase() === local.isrc.toUpperCase() ? 0.99 : 0;
  }
  if (track.isrc && local.isrc && track.isrc.toUpperCase() === local.isrc.toUpperCase()) return 1;
  const title = Math.max(similarity(track.name, local.title), 0.9 * similarity(track.name, local.name));
  const artists = track.artists?.length ? track.artists : [""];
  let artist = local.artist ? Math.max(...artists.map((a) => similarity(a, local.artist))) : 0;
  // no artist tag: the artist may appear in the file name
  if (!local.artist) artist = Math.max(...artists.map((a) => (normalize(local.name).includes(normalize(a)) && normalize(a) ? 0.9 : 0)));
  let score = 0.62 * title + 0.28 * artist;
  if (track.durationMs && local.durationMs) {
    const d = Math.abs(track.durationMs - local.durationMs) / 1000;
    score += d <= 2 ? 0.12 : d <= 5 ? 0.06 : d > 20 ? -0.25 : 0;
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * One-to-one assignment.
 * @param {object[]} tracks Spotify tracks
 * @param {object[]} records local records
 * @param {Object<string, string|null>} manual trackId → recordId (null = explicitly none)
 * @returns {Map<string, {recordId:string, score:number, manual:boolean}>}
 */
export function matchPlaylist(tracks, records, manual = {}) {
  const result = new Map();
  const usedRecords = new Set();
  for (const t of tracks) {
    if (!(t.id in manual)) continue;
    const rid = manual[t.id];
    if (rid && records.some((r) => r.id === rid)) {
      result.set(t.id, { recordId: rid, score: 1, manual: true });
      usedRecords.add(rid);
    } else {
      result.set(t.id, null); // explicitly unmatched
    }
  }
  const infos = records.map((r) => ({ r, info: localInfo(r) }));
  const pairs = [];
  for (const t of tracks) {
    if (result.has(t.id) || t.isLocal) continue;
    for (const { r, info } of infos) {
      if (usedRecords.has(r.id)) continue;
      const s = matchScore(t, info);
      if (s >= MIN_SCORE) pairs.push({ t: t.id, r: r.id, s, file: !info.spotifyId });
    }
  }
  // equal confidence: a local file (full analysis) wins over a capture
  pairs.sort((a, b) => b.s - a.s || b.file - a.file);
  for (const p of pairs) {
    if (result.has(p.t) || usedRecords.has(p.r)) continue;
    result.set(p.t, { recordId: p.r, score: p.s, manual: false });
    usedRecords.add(p.r);
  }
  for (const [k, v] of result) if (v === null) result.delete(k);
  return result;
}

/** Best local candidates for one track (for the manual picker). */
export function candidatesFor(track, records, limit = 8) {
  return records
    .map((r) => ({ id: r.id, name: r.name, score: matchScore(track, localInfo(r)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
