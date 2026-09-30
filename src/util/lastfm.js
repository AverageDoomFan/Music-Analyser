// Optional second genre source: Last.fm top tags (last.fm). Denser than
// MusicBrainz for popular tracks, but needs the user's own free API key
// (last.fm/api/account/create). Used only when MusicBrainz finds no genre.
// Sent: artist, title and the key.

import { createRateQueue } from "./rate-queue.js";
import { isGenreTag, cleanTitle, primaryArtist } from "./musicbrainz.js";

const ROOT = "https://ws.audioscrobbler.com/2.0/";
const queue = createRateQueue({ intervalMs: 250 });

/**
 * Genres from a track.getTopTags / artist.getTopTags response: tags that read
 * as genres, best first, weights relative to the top tag.
 * @returns {{genres:string[], weights:number[]}}
 */
export function parseTopTags(json, max = 6) {
  const list = json?.toptags?.tag;
  const tags = (Array.isArray(list) ? list : list ? [list] : [])
    .map((x) => ({ name: String(x?.name ?? "").toLowerCase().trim(), count: Number(x?.count) || 0 }))
    .filter((x) => x.name && x.count > 0 && isGenreTag(x.name) && x.name !== "instrumental");
  const top = Math.max(1, ...tags.map((x) => x.count));
  const kept = tags.sort((a, b) => b.count - a.count).filter((x) => x.count >= 0.2 * top).slice(0, max);
  return { genres: kept.map((x) => x.name), weights: kept.map((x) => Math.round((x.count / top) * 100) / 100) };
}

async function call(params, key) {
  const url = `${ROOT}?${new URLSearchParams({ ...params, api_key: key, format: "json", autocorrect: "1" })}`;
  const res = await queue(() => fetch(url));
  const json = await res.json().catch(() => null);
  if (json?.error === 10 || json?.error === 26) throw new Error("Last.fm: invalid API key");
  if (!res.ok && !json) throw new Error(`Last.fm ${res.status}`);
  return json;
}

/** Track tags, else the artist's. @returns {Promise<{found, genres, weights, level?}>} */
export async function lastfmGenres({ artist, title }, key) {
  if (!key || !artist) return { found: false, genres: [], weights: [] };
  const a = primaryArtist(artist);
  if (title) {
    const tr = parseTopTags(await call({ method: "track.gettoptags", artist: a, track: cleanTitle(title) }, key));
    if (tr.genres.length) return { found: true, level: "track", ...tr };
  }
  const ar = parseTopTags(await call({ method: "artist.gettoptags", artist: a }, key));
  return { found: ar.genres.length > 0, level: "artist", ...ar };
}
