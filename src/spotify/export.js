// Creating Spotify playlists from library records: a captured record knows
// its Spotify track; a local file is found through the imported playlists'
// matching (ISRC, title / artist / duration).

import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import * as auth from "./auth.js";
import * as api from "./api.js";
import { matchPlaylist } from "./match.js";

/** recordId → spotify:track URI, for every record we can place on Spotify. */
export async function recordUris() {
  const out = new Map();
  for (const r of state.records.values()) if (r.source?.kind === "spotify" && r.source.uri) out.set(r.id, r.source.uri);
  const playlists = await ctl.importedPlaylists();
  const manual = (await ctl.spotifyStore.get("matches").catch(() => null)) ?? {};
  const files = [...state.records.values()].filter((r) => r.source?.kind !== "spotify");
  for (const pl of playlists) {
    const m = matchPlaylist(pl.tracks, files, manual);
    for (const t of pl.tracks) {
      const hit = m.get(t.id);
      if (hit && t.uri?.startsWith("spotify:track:") && !out.has(hit.recordId)) out.set(hit.recordId, t.uri);
    }
  }
  return out;
}

/**
 * Creates a private playlist with the given records (in order).
 * @returns {Promise<{url:string|null, added:number, missing:number}>}
 */
export async function createFromRecords(name, ids, description = "") {
  if (!auth.isLoggedIn()) throw new Error("Connecte d'abord ton compte Spotify (onglet Spotify).");
  const uris = await recordUris();
  const list = ids.map((id) => uris.get(id)).filter(Boolean);
  if (!list.length) throw new Error("Aucun de ces morceaux n'est associé à un titre Spotify.");
  const me = await api.me();
  const created = await api.createPlaylist(me.id, name, description);
  await api.addTracks(created.id, list);
  return { url: created.external_urls?.spotify ?? null, added: list.length, missing: ids.length - list.length };
}
