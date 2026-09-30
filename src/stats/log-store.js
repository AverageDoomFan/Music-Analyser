// Persistence of the listening log (IndexedDB store "listens") and of the
// friends' profiles for the duel (settings key "stats.friends").

import { db } from "../storage/db.js";
import { state } from "../app/store.js";
import { cleanListens } from "./listening.js";

const listeners = new Set();
let cache = null;

/** Called with no argument whenever the log changes. */
export const onListensChanged = (fn) => listeners.add(fn);

/** Every listen, oldest first. */
export async function getListens() {
  if (!cache) cache = cleanListens(await db.getAllListens().catch(() => []));
  return cache;
}

/**
 * Appends a listen reported by the follow mode (Follower's onListen):
 * { track, at, endedAt, heardSeconds, coverage, score, draft, kept }.
 */
export async function recordListen(l) {
  const recordId = `spotify:${l.track.id}`;
  const rec = state.records.get(recordId);
  const entry = {
    at: l.at, endedAt: l.endedAt, recordId, trackId: l.track.id,
    name: rec?.name ?? `${l.track.artists?.join(", ") || "?"} - ${l.track.name}`,
    heardSeconds: l.heardSeconds, coverage: l.coverage,
    // an unchanged earlier analysis keeps its score
    score: l.score ?? rec?.finalScore ?? null,
    draft: !!(l.kept ? l.draft : rec?.draft),
  };
  if (l.track.demo) entry.demo = true;
  entry.id = await db.addListen(entry);
  if (cache) cache = cleanListens([...cache, entry]);
  for (const fn of listeners) fn();
  return entry;
}

/** Test / demo helper: replaces nothing, adds entries in one transaction. */
export async function addListens(entries) {
  await db.putListens(entries);
  cache = null;
  for (const fn of listeners) fn();
}

export async function clearListens() {
  await db.clearListens();
  cache = null;
  for (const fn of listeners) fn();
}

// ---------- friends' profiles ----------

const FRIENDS_KEY = "stats.friends";

export async function getFriends() {
  return (await db.getSetting(FRIENDS_KEY).catch(() => null)) ?? [];
}

export async function saveFriends(list) {
  await db.setSetting(FRIENDS_KEY, list.slice(-8));
}
