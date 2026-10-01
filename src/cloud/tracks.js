// Shared track database: one entry per Spotify track, analysed once for
// everyone. tracks/{id} holds the metadata, the automatic score (default
// weights) and the vote counters; features/{id} the packed measures, from
// which every user rescores the track with their own settings.

import { firebase } from "./firebase.js";
import { myUid, isSignedIn, readable } from "./account.js";
import { versionCode, keywords, queryWords, matchesQuery, packFeatures, unpackFeatures, voteDelta, communityMean } from "./pack.js";
import { FEATURE_VERSION, ALGORITHM_VERSION, DEFAULT_WEIGHTS, DEFAULT_AGGREGATION } from "../config.js";
import { scoreFeatures } from "../scoring/index.js";

const SID = /^[0-9A-Za-z]{22}$/;
export const validSid = (id) => SID.test(String(id ?? ""));
export const FV = versionCode(FEATURE_VERSION);

/** Spotify id of a record that can be shared (a captured Spotify track), else null. */
export function sidOf(record) {
  if (record?.source?.kind !== "spotify") return null;
  const id = record.source.trackId ?? String(record.id).replace(/^spotify:/, "");
  return validSid(id) ? id : null;
}

/** Shared metadata of some Spotify ids: Map id → { ...doc, mean } (missing ids are absent). */
export async function lookup(ids) {
  const { db, F } = await firebase();
  const list = [...new Set(ids)].filter(validSid);
  const out = new Map();
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    const snap = await F.getDocs(F.query(F.collection(db, "tracks"), F.where(F.documentId(), "in", chunk)));
    for (const d of snap.docs) out.set(d.id, withMean(d.id, d.data()));
  }
  return out;
}

const withMean = (id, d) => ({ id, ...d, mean: communityMean(d.vs, d.vc) });

/** Packed measures of a shared track (null when absent). */
export async function fetchFeatures(sid) {
  const { db, F } = await firebase();
  const snap = await F.getDoc(F.doc(db, "features", sid));
  if (!snap.exists()) return null;
  return unpackFeatures(snap.data().z.toUint8Array());
}

/** Can a shared entry stand in for an analysis on this app version? */
export const usable = (meta) => meta?.fv === FV;

/**
 * Shares a record's analysis. Creates the entry, or replaces it when mine
 * comes from a newer extractor or heard clearly more of the track (the rules
 * check the same). Returns "created" | "updated" | "kept" (the shared one is as good).
 */
export async function publish(record) {
  const sid = sidOf(record);
  if (!sid || !record.features || record.featureVersion !== FEATURE_VERSION || record.draft) return "skipped";
  const { db, F } = await firebase();
  const f = record.features;
  const tags = record.tags ?? {};
  const auto = scoreFeatures(f, DEFAULT_WEIGHTS, DEFAULT_AGGREGATION);
  const cov = Math.max(0, Math.min(1, record.source?.coverage ?? 1));
  const meta = {
    t: String(tags.title || record.name || "?").slice(0, 200),
    a: String(tags.artist ?? "").slice(0, 300),
    kw: keywords(tags.title || record.name, tags.artist),
    d: Math.round(f.duration ?? record.duration ?? 0),
    isrc: tags.isrc ? String(tags.isrc).slice(0, 15) : null,
    v: FEATURE_VERSION, fv: FV, alg: ALGORITHM_VERSION,
    s: Math.round(auto.score * 10) / 10,
    sub: Object.fromEntries(Object.entries(auto.subscores ?? {}).map(([k, v]) => [k, Math.round(v)])),
    bpm: Number.isFinite(auto.music?.tempo?.bpm) ? Math.round(auto.music.tempo.bpm * 10) / 10 : null,
    key: auto.music?.key?.name ?? null,
    cov: Math.round(cov * 1000) / 1000,
    mode: record.source?.mode ? String(record.source.mode).slice(0, 20) : null,
    by: myUid(),
    at: F.serverTimestamp(),
  };
  const z = F.Bytes.fromUint8Array(await packFeatures(f));
  const trackRef = F.doc(db, "tracks", sid), featRef = F.doc(db, "features", sid);
  try {
    return await F.runTransaction(db, async (tx) => {
      const cur = await tx.get(trackRef);
      if (cur.exists()) {
        const c = cur.data();
        if (!(FV > c.fv || (FV === c.fv && meta.cov > c.cov + 0.05))) return "kept";
        tx.set(trackRef, { ...meta, vs: c.vs, vc: c.vc });
      } else {
        tx.set(trackRef, { ...meta, vs: 0, vc: 0 });
      }
      tx.set(featRef, { v: FEATURE_VERSION, fv: FV, z, by: meta.by, at: meta.at });
      return cur.exists() ? "updated" : "created";
    });
  } catch (err) {
    throw new Error(readable(err));
  }
}

/** My vote on a track (integer or null), as stored. */
export async function myVote(sid) {
  const { db, F } = await firebase();
  const snap = await F.getDoc(F.doc(db, "tracks", sid, "votes", myUid()));
  return snap.exists() ? snap.data().s : null;
}

/**
 * Sets (integer score) or removes (null) my vote; the track's counters change
 * in the same transaction. Returns the track's new { vs, vc, mean }.
 */
export async function setVote(sid, value) {
  const { db, F } = await firebase();
  const uid = myUid();
  const trackRef = F.doc(db, "tracks", sid);
  const voteRef = F.doc(db, "tracks", sid, "votes", uid);
  try {
    return await F.runTransaction(db, async (tx) => {
      const tr = await tx.get(trackRef);
      if (!tr.exists()) throw new Error("not shared");
      const v = await tx.get(voteRef);
      const before = v.exists() ? v.data().s : null;
      const d = voteDelta(before, value);
      const { vs, vc } = tr.data();
      if (!d) return { vs, vc, mean: communityMean(vs, vc) };
      if (value == null) tx.delete(voteRef);
      else tx.set(voteRef, { s: value, u: uid, at: F.serverTimestamp() });
      tx.update(trackRef, { vs: vs + d.ds, vc: vc + d.dc });
      return { vs: vs + d.ds, vc: vc + d.dc, mean: communityMean(vs + d.ds, vc + d.dc) };
    });
  } catch (err) {
    throw new Error(err.message === "not shared" ? err.message : readable(err));
  }
}

/**
 * Database search: tracks whose title or artist has every word of the query
 * (the longest word must be whole, the others can be the start of a word).
 * Most voted first. [{ id, t, a, s, mean, vc, ... }]
 */
export async function search(q, limit = 40) {
  const words = queryWords(q);
  if (!words.length || !isSignedIn()) return [];
  const { db, F } = await firebase();
  const snap = await F.getDocs(F.query(F.collection(db, "tracks"), F.where("kw", "array-contains", words[0]), F.limit(limit * 2)));
  return snap.docs.map((d) => withMean(d.id, d.data()))
    .filter((x) => matchesQuery(x.kw ?? [], words))
    .sort((a, b) => b.vc - a.vc || a.t.localeCompare(b.t))
    .slice(0, limit);
}
