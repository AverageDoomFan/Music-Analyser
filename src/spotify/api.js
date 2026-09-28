// Spotify Web API calls used by the app (playlists only). Paths renamed in
// 2026 (/items instead of /tracks, /me/playlists for creation) are tried
// first, with a fallback to the older ones.

import { accessToken } from "./auth.js";

const BASE = "https://api.spotify.com/v1";

export class SpotifyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body, attempt = 0) {
  const token = await accessToken({ force: attempt === 1 });
  const res = await fetch(url.startsWith("http") ? url : BASE + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && attempt === 0) return request(method, url, body, 1);
  if (res.status === 429 && attempt < 3) {
    const wait = Math.min(15, Number(res.headers.get("Retry-After")) || 2);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return request(method, url, body, attempt + 1);
  }
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText || "erreur";
    const hint = res.status === 403 ? " (compte non autorisé dans le tableau de bord de l'application, ou playlist dont tu n'es ni propriétaire ni collaborateur)" : "";
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

/** Tracks of a playlist (episodes skipped). */
export async function playlistTracks(id) {
  const toTrack = (entry) => {
    const t = entry?.item ?? entry?.track;
    if (!t || (t.type && t.type !== "track")) return null;
    return {
      id: t.id ?? `local:${t.uri}`,
      uri: t.uri,
      name: t.name,
      artists: (t.artists ?? []).map((a) => a.name).filter(Boolean),
      album: t.album?.name ?? null,
      durationMs: t.duration_ms ?? null,
      isrc: t.external_ids?.isrc ?? null,
      url: t.external_urls?.spotify ?? null,
      isLocal: !!t.is_local,
    };
  };
  try {
    return await allPages(`/playlists/${id}/items?limit=50`, toTrack);
  } catch (err) {
    if (![404, 405].includes(err.status)) throw err;
    return allPages(`/playlists/${id}/tracks?limit=50`, toTrack);
  }
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
