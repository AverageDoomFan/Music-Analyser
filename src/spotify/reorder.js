// Sorting an existing Spotify playlist in place, in progression order: the
// tracks are moved inside the playlist (Spotify's "reorder items"), so no new
// playlist is created and nothing is removed, re-added or re-dated.

import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import * as api from "./api.js";
import { matchPlaylist } from "./match.js";
import { planMoves, progressionOrder } from "../playlist/inplace.js";

/** trackId → analysed record (captures and matched files; drafts do not count). */
export async function recordMatcher(tracks) {
  const records = [...state.records.values()].filter((r) => r.finalScore != null && !r.draft);
  const manual = (await ctl.spotifyStore.get("matches").catch(() => null)) ?? {};
  const unique = [...new Map(tracks.filter((t) => t.id != null).map((t) => [t.id, t])).values()];
  const m = matchPlaylist(unique, records, manual);
  return (trackId) => {
    const hit = trackId != null ? m.get(trackId) : null;
    return hit ? state.records.get(hit.recordId) ?? null : null;
  };
}

/**
 * Reads the playlist, computes the progression order and applies it on Spotify.
 * @returns {Promise<{ moves:number, sorted:number, rest:number, total:number, undo:function|null }>}
 */
export async function sortPlaylistInPlace(playlistId, { tolerance = 6, byStyle = false, onProgress = () => {} } = {}) {
  // every position, episodes and unavailable items included: the moves count them
  const tracks = await api.playlistEntries(playlistId);
  const recordOf = await recordMatcher(tracks);
  const { order, sorted, rest } = progressionOrder(tracks, recordOf,
    (ids) => ctl.orderRecords(ids, tolerance, { byStyle }).steps.map((s) => s.id));
  const moves = planMoves(order);
  await run(playlistId, moves, onProgress);
  // the way back: where each entry came from, as seen from the new order
  const back = new Array(order.length);
  order.forEach((from, to) => { back[from] = to; });
  const undo = moves.length ? (progress = () => {}) => run(playlistId, planMoves(back), progress) : null;
  return { moves: moves.length, sorted, rest, total: tracks.length, undo };
}

async function run(playlistId, moves, onProgress) {
  let snapshot = (await api.playlistInfo(playlistId))?.snapshot_id ?? null;
  for (let i = 0; i < moves.length; i++) {
    onProgress(i, moves.length);
    snapshot = (await api.moveItems(playlistId, { ...moves[i], snapshot })) ?? snapshot;
  }
  onProgress(moves.length, moves.length);
}
