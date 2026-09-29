// Spotify Web API calls used by the app (playlists, and playback control for the live scan). Paths renamed in
// 2026 (/items instead of /tracks, /me/playlists for creation) are tried
// first, with a fallback to the older ones.

import { accessToken } from "./auth.js";
import { t } from "../i18n/index.js";

const BASE = "https://api.spotify.com/v1";

export class SpotifyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const PLAYLIST_HINT = { 403: t(" (account not allowed in the app's dashboard, or a playlist you neither own nor collaborate on)") };
const PLAYER_HINT = {
  403: t(" (playback control refused: Spotify Premium required, or log in again to allow playback control)"),
  404: t(" (no active Spotify device: open the Spotify app on this PC and play a track once)"),
};

async function request(method, url, body, attempt = 0, hints = PLAYLIST_HINT) {
  const token = await accessToken({ force: attempt === 1 });
  const res = await fetch(url.startsWith("http") ? url : BASE + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && attempt === 0) return request(method, url, body, 1, hints);
  if (res.status === 429 && attempt < 3) {
    const wait = Math.min(15, Number(res.headers.get("Retry-After")) || 2);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return request(method, url, body, attempt + 1, hints);
  }
  if (res.status === 204 || res.status === 202) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText || "erreur";
    const hint = hints[res.status] ?? "";
    throw new SpotifyError(`Spotify ${res.status} : ${msg}${hint}`, res.status);
  }
  return json;
}

/** Tries the current path, then the pre-2026 one when the first does not exist. */
async function withFallback(method, paths, body) {
  let last;
  for (const p of paths) {
    try {
      return await request(method, p, body);
    } catch (err) {
      last = err;
      if (![404, 405].includes(err.status)) throw err;
    }
  }
  throw last;
}

async function allPages(firstUrl, map) {
  const out = [];
  let url = firstUrl;
  while (url) {
    const page = await request("GET", url);
    for (const it of page.items ?? []) {
      const v = map(it);
      if (v) out.push(v);
    }
    url = page.next;
  }
  return out;
}

export const me = () => request("GET", "/me");

/** Playlists of the user; `editable` = owned or collaborative (the only ones whose items can be read in development mode). */
export async function myPlaylists(userId) {
  return allPages("/me/playlists?limit=50", (p) => p && ({
    id: p.id,
    name: p.name,
    owner: p.owner?.display_name ?? p.owner?.id,
    count: p.items?.total ?? p.tracks?.total ?? null,
    editable: p.owner?.id === userId || !!p.collaborative,
    url: p.external_urls?.spotify,
  }));
}

/** Our track shape, from a Spotify track object. */
function toTrack(t, addedAt = null) {
  if (!t || (t.type && t.type !== "track")) return null;
  return {
    id: t.id ?? `local:${t.uri}`,
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).filter(Boolean),
    artistIds: (t.artists ?? []).map((a) => a.id).filter(Boolean),
    album: t.album?.name ?? null,
    durationMs: t.duration_ms ?? null,
    isrc: t.external_ids?.isrc ?? null,
    url: t.external_urls?.spotify ?? null,
    isLocal: !!t.is_local,
    image: t.album?.images?.at(-1)?.url ?? null,
    imageLarge: t.album?.images?.[0]?.url ?? null,
    addedAt,
  };
}

/** Tracks of a playlist (episodes skipped). */
export async function playlistTracks(id) {
  const entryTrack = (entry) => toTrack(entry?.item ?? entry?.track, entry?.added_at ?? null);
  try {
    return await allPages(`/playlists/${id}/items?limit=50`, entryTrack);
  } catch (err) {
    if (![404, 405].includes(err.status)) throw err;
    return allPages(`/playlists/${id}/tracks?limit=50`, entryTrack);
  }
}

/** Track search (the whole Spotify catalogue). */
export async function searchTracks(query, limit = 10) {
  const page = await request("GET", `/search?type=track&limit=${limit}&q=${encodeURIComponent(query)}`);
  return (page.tracks?.items ?? []).map((t) => toTrack(t)).filter(Boolean);
}

export async function playlistInfo(id) {
  return request("GET", `/playlists/${id}?fields=id,name,snapshot_id,owner(id,display_name),external_urls`);
}

/** Creates a new playlist in the user's account (never modifies an existing one). */
export async function createPlaylist(userId, name, description) {
  const body = { name, description, public: false };
  return withFallback("POST", ["/me/playlists", `/users/${encodeURIComponent(userId)}/playlists`], body);
}

export async function addTracks(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    await withFallback("POST", [`/playlists/${playlistId}/items`, `/playlists/${playlistId}/tracks`], { uris: chunk });
  }
}

// ---------- playback control (live scan) ----------

const player = (method, path, body) => request(method, path, body, 0, PLAYER_HINT);
const withDevice = (path, deviceId) => (deviceId ? `${path}${path.includes("?") ? "&" : "?"}device_id=${encodeURIComponent(deviceId)}` : path);

export async function devices() {
  const res = await player("GET", "/me/player/devices");
  return (res?.devices ?? []).map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active, restricted: d.is_restricted, volume: d.volume_percent }));
}

/** { itemId, isPlaying, progressMs, deviceId, name } or null when nothing is playing. */
export async function playbackState() {
  const res = await player("GET", "/me/player?additional_types=track");
  if (!res) return null;
  return {
    itemId: res.item?.id ?? null, name: res.item?.name ?? null, isPlaying: !!res.is_playing,
    progressMs: res.progress_ms ?? 0, deviceId: res.device?.id ?? null, deviceName: res.device?.name ?? null,
    shuffle: res.shuffle_state, repeat: res.repeat_state,
  };
}

export const transferPlayback = (deviceId) => player("PUT", "/me/player", { device_ids: [deviceId], play: false });
export const play = (deviceId, uri, positionMs = 0) => player("PUT", withDevice("/me/player/play", deviceId), { uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) });
export async function pause(deviceId) {
  try {
    await player("PUT", withDevice("/me/player/pause", deviceId));
  } catch (err) {
    // already paused → 403 "Restriction violated" on some clients
    if (err.status !== 403 && err.status !== 404) throw err;
  }
}
export const setRepeat = (deviceId, mode = "off") => player("PUT", withDevice(`/me/player/repeat?state=${mode}`, deviceId));

// ---------- artist genres ----------

/**
 * Genres of artists (Spotify attaches genres to artists, not tracks).
 * Uses the batch endpoint, then single requests if it is not available.
 * @returns {Promise<{genres: Map<string,string[]>, fieldMissing: boolean}>}
 *   fieldMissing = Spotify returned artists without any "genres" field
 */
export async function artistGenres(ids, onProgress = () => {}) {
  const out = new Map();
  let missing = 0, seen = 0;
  const take = (a) => {
    if (!a?.id) return;
    seen++;
    if (!Array.isArray(a.genres)) missing++;
    out.set(a.id, Array.isArray(a.genres) ? a.genres : []);
  };
  const uniq = [...new Set(ids)];
  let batch = true;
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    if (batch) {
      try {
        const res = await request("GET", `/artists?ids=${chunk.join(",")}`);
        (res?.artists ?? []).forEach(take);
        onProgress(Math.min(uniq.length, i + 50), uniq.length);
        continue;
      } catch (err) {
        if (![403, 404, 405].includes(err.status)) throw err;
        batch = false; // batch endpoint closed for this app: one by one
      }
    }
    for (const [k, id] of chunk.entries()) {
      try { take(await request("GET", `/artists/${id}`)); } catch (err) { if (err.status !== 404) throw err; }
      onProgress(i + k + 1, uniq.length);
    }
  }
  return { genres: out, fieldMissing: seen > 0 && missing === seen };
}
