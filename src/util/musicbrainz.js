// Genres from MusicBrainz (musicbrainz.org), the open music database. It
// answers browsers directly (CORS), needs no key, and allows 1 request per
// second per client, so every call goes through one shared rate queue.
//
// Per track: one recording search (by ISRC when known, else artist + title),
// then the genres of its release group (album) and of its artist, both
// cached by id since many tracks share them. Sent: ISRC, or artist + title.
// Votes from the three levels are merged, most specific first.
//
// The parsing and merging functions are pure (tested in tests/musicbrainz.test.mjs).

import { createRateQueue } from "./rate-queue.js";
import { similarity } from "../spotify/match.js";
import { familyOf } from "../scoring/genre-map.js";

export const MB_ROOT = "https://musicbrainz.org/ws/2";

/** Weights of the three levels when votes are merged. */
export const LEVEL_WEIGHTS = { recording: 3, releaseGroup: 2, artist: 1 };

// ------------------------------------------------------------------ queries

const quote = (s) => `"${String(s).replace(/["\\]/g, "\\$&")}"`;

/** Title without the decorations streaming services add ("- Remastered 2011", "(feat. X)"). */
export function cleanTitle(title) {
  return String(title ?? "")
    .replace(/\s*[([](?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]/gi, "")
    .replace(/\s[-–—]\s.*\b(?:remaster(?:ed)?|version|edit|live|mono|stereo)\b.*$/i, "")
    .trim();
}

/** First artist of "A, B feat. C" (names with "&" are kept whole: "Mumford & Sons"). */
export function primaryArtist(artist) {
  return String(artist ?? "").split(/,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim();
}

/** Search URL for a recording: exact ISRC, or artist + title. null without enough data. */
export function recordingSearchUrl({ isrc, artist, title }) {
  let query;
  if (isrc) query = `isrc:${String(isrc).replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`;
  else if (artist && title) query = `recording:${quote(cleanTitle(title))} AND artist:${quote(primaryArtist(artist))}`;
  else return null;
  return `${MB_ROOT}/recording?query=${encodeURIComponent(query)}&limit=10&fmt=json`;
}

export const artistUrl = (id) => `${MB_ROOT}/artist/${id}?inc=genres+tags&fmt=json`;
export const releaseGroupUrl = (id) => `${MB_ROOT}/release-group/${id}?inc=genres+tags&fmt=json`;

// ------------------------------------------------------------------ parsing

/** [{name, count}] with positive votes only, lowercase names. */
function votes(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => x?.name && (x.count ?? 1) > 0)
    .map((x) => ({ name: String(x.name).toLowerCase().trim(), count: x.count ?? 1 }));
}

/** Genres and tags of any MusicBrainz entity (recording, release group, artist). */
export function entityVotes(entity) {
  return { genres: votes(entity?.genres), tags: votes(entity?.tags) };
}

/** The most common release group among a recording's releases (albums first). */
function mainReleaseGroup(releases) {
  const count = new Map();
  for (const rel of releases ?? []) {
    const rg = rel["release-group"];
    if (!rg?.id) continue;
    const type = (rg["primary-type"] ?? "").toLowerCase();
    const w = (type === "album" ? 3 : type === "single" || type === "ep" ? 2 : 1) * (rel.status && rel.status !== "Official" ? 0.5 : 1)
      * ((rg["secondary-types"] ?? []).length ? 0.4 : 1); // compilations, soundtracks, live
    count.set(rg.id, (count.get(rg.id) ?? 0) + w);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Best recording of a search response.
 * With an ISRC every hit is the same song: the one with most tags / releases wins.
 * Otherwise hits must match the title and artist, and the length when known.
 * @returns {null | {id, title, score, artistIds:string[], releaseGroupId:string|null, votes:{genres,tags}}}
 */
export function pickRecording(json, { isrc = null, artist = "", title = "", durationSec = null } = {}) {
  const hits = Array.isArray(json?.recordings) ? json.recordings : [];
  const scored = hits.map((rec) => {
    const credit = rec["artist-credit"] ?? [];
    const names = credit.map((c) => c.name ?? c.artist?.name ?? "").join(" ");
    let fit = 1;
    if (!isrc) {
      const tSim = Math.max(similarity(rec.title, title), similarity(rec.title, cleanTitle(title)));
      const aSim = Math.max(similarity(names, artist), similarity(names, primaryArtist(artist)), ...credit.map((c) => similarity(c.artist?.name ?? c.name, primaryArtist(artist))));
      if (tSim < 0.7 || aSim < 0.6 || (rec.score ?? 100) < 60) return null;
      fit = 0.6 * tSim + 0.4 * aSim;
      if (durationSec && rec.length) {
        const d = Math.abs(rec.length / 1000 - durationSec);
        if (d > 20) return null;
        fit *= d <= 5 ? 1 : 0.9;
      }
    }
    // the canonical entry has more releases and more votes
    const richness = votes(rec.tags).length + Math.min(5, rec.releases?.length ?? 0) * 0.5;
    return { rec, rank: fit * 100 + richness };
  }).filter(Boolean).sort((a, b) => b.rank - a.rank);
  const best = scored[0]?.rec;
  if (!best) return null;
  // with an ISRC, several recording entries may share it: pool their tags
  const pool = isrc ? scored.map((s) => s.rec) : [best];
  const tags = new Map();
  for (const r of pool) for (const v of votes(r.tags)) tags.set(v.name, (tags.get(v.name) ?? 0) + v.count);
  return {
    id: best.id,
    title: best.title,
    score: best.score ?? null,
    artistIds: (best["artist-credit"] ?? []).map((c) => c.artist?.id).filter(Boolean),
    releaseGroupId: mainReleaseGroup(pool.flatMap((r) => r.releases ?? [])),
    // search results carry tags only; MusicBrainz genres are the tags on its genre list
    votes: { genres: votes(best.genres), tags: [...tags].map(([name, count]) => ({ name, count })) },
  };
}

// ------------------------------------------------------------------ merging

/** A tag that reads as a genre for the app (the genre map recognises it). */
export const isGenreTag = (name) => familyOf(name) != null;

/**
 * Merges the votes of several levels into one ranked list of genres.
 * Each level is normalised by its own top vote so a famous artist with
 * hundreds of votes does not drown the track's own tags. Curated genres count
 * fully; free tags only when they read as a genre, at half weight.
 * @param {{weight:number, genres:{name,count}[], tags:{name,count}[]}[]} levels
 * @returns {{genres:string[], weights:number[]}} best first, weights 0..1
 */
export function mergeGenreVotes(levels, max = 6) {
  const score = new Map();
  for (const lv of levels) {
    if (!lv) continue;
    const genres = lv.genres ?? [];
    const genreNames = new Set(genres.map((g) => g.name));
    const tags = (lv.tags ?? []).filter((x) => !genreNames.has(x.name) && isGenreTag(x.name));
    const top = Math.max(1, ...genres.map((g) => g.count), ...tags.map((g) => g.count));
    for (const g of genres) score.set(g.name, (score.get(g.name) ?? 0) + lv.weight * g.count / top);
    for (const g of tags) score.set(g.name, (score.get(g.name) ?? 0) + 0.5 * lv.weight * g.count / top);
  }
  const ranked = [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const best = ranked[0]?.[1] ?? 0;
  const kept = ranked.filter(([name, s]) => s >= 0.25 * best && name !== "instrumental").slice(0, max);
  return { genres: kept.map(([n]) => n), weights: kept.map(([, s]) => Math.round((s / best) * 100) / 100) };
}

/** Tagged "instrumental" on the recording or its album (the artist level is too broad). */
export function isInstrumental(...levels) {
  return levels.some((lv) => [...(lv?.genres ?? []), ...(lv?.tags ?? [])].some((x) => x.name === "instrumental"));
}

// ------------------------------------------------------------------ network

const queue = createRateQueue({ intervalMs: 1100 });

/** GET through the queue; retries "slow down" answers. null on 404. */
async function get(url, tries = 3) {
  for (let i = 0; ; i++) {
    const res = await queue(() => fetch(url, { headers: { Accept: "application/json" } }));
    if (res.status === 404 || res.status === 400) return null;
    if ((res.status === 503 || res.status === 429) && i < tries) { queue.backoff(2000 * (i + 1)); continue; }
    if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
    return res.json();
  }
}

const MONTH = 30 * 24 * 3600e3;
const fresh = (e) => e && Date.now() - e.at < MONTH;

/**
 * Genres of one track.
 * @param {{isrc?:string, artist?:string, title?:string, durationSec?:number}} meta
 * @param {{artists:object, releaseGroups:object}} cache  id -> {genres, tags, at}; filled in place
 * @returns {Promise<{found:boolean, mbid?:string, genres:string[], weights:number[], instrumental:boolean}>}
 */
export async function lookupTrackGenres(meta, cache) {
  let rec = null;
  if (meta.isrc) rec = pickRecording(await get(recordingSearchUrl({ isrc: meta.isrc })), { isrc: meta.isrc });
  if (!rec && meta.artist && meta.title) rec = pickRecording(await get(recordingSearchUrl({ artist: meta.artist, title: meta.title })), meta);
  if (!rec) return { found: false, genres: [], weights: [], instrumental: false };
  const entity = async (store, id, url) => {
    if (!id) return null;
    if (!fresh(store[id])) store[id] = { ...entityVotes(await get(url(id))), at: Date.now() };
    return store[id];
  };
  const rg = await entity(cache.releaseGroups, rec.releaseGroupId, releaseGroupUrl);
  const ar = await entity(cache.artists, rec.artistIds[0], artistUrl);
  const merged = mergeGenreVotes([
    { weight: LEVEL_WEIGHTS.recording, ...rec.votes },
    rg && { weight: LEVEL_WEIGHTS.releaseGroup, ...rg },
    ar && { weight: LEVEL_WEIGHTS.artist, ...ar },
  ]);
  return { found: true, mbid: rec.id, ...merged, instrumental: isInstrumental(rec.votes, rg) };
}
