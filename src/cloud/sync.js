// Glue between the local app and the online account, once signed in:
//   - a track captured here is shared (unless turned off in the settings);
//   - a playlist's tracks already in the shared database are loaded instead of
//     analysed again (importKnown);
//   - my score changes become votes, and the community score comes back;
//   - my library (Spotify ids + duel profile), my page's summaries and my
//     listening log are kept online, a little after each change;
//   - the games post to the leaderboards.
// Everything here fails quietly (the app keeps working offline).

import { state, subscribe } from "../app/store.js";
import { FEATURE_VERSION } from "../config.js";
import * as ctl from "../app/controller.js";
import { db } from "../storage/db.js";
import { setUseCommunity } from "../core/track.js";
import { firebase } from "./firebase.js";
import { acc, onAccount, isSignedIn, myUid, publishSummary, initAccount } from "./account.js";
import { lookup, fetchFeatures, usable, publish, setVote, sidOf, validSid, FV } from "./tracks.js";
import { postScores } from "./social.js";
import { voteValue, gzipJson, gunzipJson, duelTracks, libraryCard, listeningCard, dayBoard, boardValues } from "./pack.js";
import { libraryProfile, profileRecords } from "../stats/library.js";
import { listeningTotals, heatmapBins } from "../stats/listening.js";
import { getListens, onListensChanged, addListens } from "../stats/log-store.js";
import { genrePath, SEP } from "../scoring/genres.js";

const prefs = { share: true, community: true };
const listeners = new Set();
/** Called when the settings or the sync status change. */
export const onSync = (fn) => listeners.add(fn);
const changed = () => { for (const fn of listeners) fn(); };

export const syncPrefs = () => ({ ...prefs });
export const syncStatus = { busy: 0, last: null, error: null };

export async function initSync() {
  prefs.share = (await db.getSetting("cloud.share").catch(() => null)) ?? true;
  prefs.community = (await db.getSetting("cloud.community").catch(() => null)) ?? true;
  setUseCommunity(prefs.community);
  ctl.events.addEventListener("analysed", (e) => queue(() => shareRecord(e.detail.id)));
  ctl.events.addEventListener("user-score", (e) => queue(() => syncVote(e.detail.id)));
  ctl.events.addEventListener("removed", (e) => queue(() => dropVote(e.detail.record)));
  subscribe(() => scheduleLibrary());
  onListensChanged(() => scheduleListening());
  onAccount((a) => { if (a.status === "ready") onSignedIn(); });
  await initAccount();
}

export async function setSyncPrefs(next) {
  if (next.share != null) { prefs.share = !!next.share; await db.setSetting("cloud.share", prefs.share); if (prefs.share) queue(shareAll); }
  if (next.community != null) {
    prefs.community = !!next.community;
    await db.setSetting("cloud.community", prefs.community);
    setUseCommunity(prefs.community);
    await ctl.refreshFinals();
  }
  changed();
}

// ---------- one background task at a time ----------

let chain = Promise.resolve();
function queue(task) {
  if (!isSignedIn()) return chain;
  syncStatus.busy++;
  changed();
  chain = chain.then(task).catch((err) => {
    console.warn("sync", err);
    syncStatus.error = err.message;
  }).finally(() => {
    syncStatus.busy--;
    syncStatus.last = Date.now();
    changed();
  });
  return chain;
}

let signedInFor = null;
function onSignedIn() {
  if (signedInFor === myUid()) return;
  signedInFor = myUid();
  queue(restoreListening);
  queue(refreshCommunity);
  queue(shareAll);
  queue(syncAllVotes);
  scheduleLibrary(2000);
  scheduleListening(5000);
}

// ---------- sharing analyses ----------

async function shareRecord(id) {
  const r = state.records.get(id);
  if (!prefs.share || !r || !sidOf(r) || r.cloud?.shared === FV) return;
  const res = await publish(r);
  if (res === "skipped") return;
  // "kept": the shared entry is as good as mine; mine stays here
  await ctl.setCloudInfo(id, { shared: FV });
}

/** Shares every captured track not shared yet with this extractor. */
async function shareAll() {
  if (!prefs.share) return;
  const todo = [...state.records.values()].filter((r) => sidOf(r) && !r.draft && r.features && r.cloud?.shared !== FV && r.featureVersion === FEATURE_VERSION);
  for (const r of todo) await shareRecord(r.id);
}

// ---------- loading analyses from the database ----------

/**
 * Before a scan: the tracks someone already analysed with this extractor are
 * loaded from the shared database instead (no capture needed). Returns how
 * many were loaded.
 */
export async function importKnown(tracks) {
  if (!isSignedIn()) return 0;
  const want = tracks.filter((tk) => tk && !tk.isLocal && !tk.demo && validSid(tk.id) && !ctl.capturedRecord(tk));
  if (!want.length) return 0;
  let metas;
  try {
    metas = await lookup(want.map((tk) => tk.id));
  } catch (err) {
    console.warn("shared lookup", err);
    return 0;
  }
  let n = 0;
  const hits = want.filter((tk) => usable(metas.get(tk.id)));
  // a few downloads at a time
  for (let i = 0; i < hits.length; i += 6) {
    await Promise.all(hits.slice(i, i + 6).map(async (tk) => {
      try {
        const f = await fetchFeatures(tk.id);
        if (!f) return;
        await ctl.saveShared(tk, f, metas.get(tk.id));
        n++;
      } catch (err) {
        console.warn("shared features", tk.id, err);
      }
    }));
  }
  return n;
}

/** Adds a track found in the database search to my library. */
export async function addShared(meta) {
  const f = await fetchFeatures(meta.id);
  if (!f) throw new Error("Measures missing.");
  return ctl.saveShared(null, f, meta);
}

/** Community scores of my shared tracks (when last read over 12 hours ago, or `force`). */
export async function refreshCommunity({ force = false, ids = null } = {}) {
  const stale = Date.now() - 12 * 3600e3;
  const recs = [...state.records.values()].filter((r) => sidOf(r) && (ids ? ids.includes(r.id) : force || !(r.cloud?.at > stale)));
  if (!recs.length) return;
  const metas = await lookup(recs.map(sidOf));
  for (const r of recs) {
    const m = metas.get(sidOf(r));
    const community = m?.vc ? { mean: m.mean, n: m.vc } : null;
    const same = JSON.stringify(community) === JSON.stringify(r.cloud?.community ?? null);
    if (!same || !(r.cloud?.at > stale)) await ctl.setCloudInfo(r.id, { community, ...(m ? {} : { shared: null }) });
  }
}

// ---------- votes ----------

/** The vote a record stands for: my corrected or manual score, or the score I agreed with. */
export function desiredVote(r) {
  if (r.manual || r.correction) return voteValue(r.finalScore);
  if (r.cloud?.validated != null) return voteValue(r.cloud.validated);
  return null;
}

async function syncVote(id) {
  const r = state.records.get(id);
  const sid = sidOf(r);
  if (!sid) return;
  const want = desiredVote(r);
  if (want === (r.cloud?.vote ?? null)) return;
  // the track must be in the database before it can get votes
  if (r.cloud?.shared == null) {
    if (!r.features || r.featureVersion !== FEATURE_VERSION) return;
    await publish(r);
  }
  const res = await setVote(sid, want);
  await ctl.setCloudInfo(id, { vote: want, shared: r.cloud?.shared ?? FV, community: res.vc ? { mean: res.mean, n: res.vc } : null });
}

async function dropVote(record) {
  const sid = sidOf(record);
  if (sid) await setVote(sid, null).catch(() => {});
}

async function syncAllVotes() {
  for (const r of [...state.records.values()]) {
    if (sidOf(r) && desiredVote(r) !== (r.cloud?.vote ?? null)) await syncVote(r.id);
  }
}

// ---------- library, page summaries ----------

let libTimer = 0, libHash = "";
function scheduleLibrary(delay = 15000) {
  if (!isSignedIn()) return;
  clearTimeout(libTimer);
  libTimer = setTimeout(() => queue(syncLibrary), delay);
}

const genreOf = (r) => {
  const label = ctl.genreInfo(r).label;
  return label ? genrePath(label).slice(0, 2).join(SEP) : null;
};

async function syncLibrary() {
  const recs = profileRecords(state.records.values());
  const hash = recs.map((r) => `${r.id}:${Math.round(r.finalScore)}:${r.genre?.label ?? r.extGenres?.at ?? ""}`).sort().join("|");
  if (hash === libHash) return;
  const { db: fdb, F } = await firebase();
  const diag = await ctl.diagnosticData({ full: false });
  const ids = [...new Set(recs.map(sidOf).filter(Boolean))];
  const duel = { algorithm: diag.algorithm, extractor: diag.extractor, aggregation: diag.aggregation, exportedAt: diag.exportedAt, tracks: duelTracks(diag.tracks) };
  let z = await gzipJson(duel);
  // very large libraries: the duel keeps the tracks it can, most intense first
  if (z.length > 850000) {
    duel.tracks = [...duel.tracks].sort((a, b) => b.s - a.s).slice(0, Math.floor(duel.tracks.length * (850000 / z.length) * 0.9));
    z = await gzipJson(duel);
  }
  await F.setDoc(F.doc(fdb, "libraries", myUid()), { ids: ids.slice(0, 20000), n: recs.length, at: F.serverTimestamp(), duel: F.Bytes.fromUint8Array(z) });
  await publishSummary({ lib: libraryCard(libraryProfile(state.records.values(), { genreOf })), lis: acc.profile?.lis ?? null });
  libHash = hash;
}

// ---------- listening log ----------

let lisTimer = 0;
function scheduleListening(delay = 60000) {
  if (!isSignedIn()) return;
  clearTimeout(lisTimer);
  lisTimer = setTimeout(() => queue(syncListening), delay);
}

const LOG_FIELDS = ["at", "endedAt", "recordId", "trackId", "name", "heardSeconds", "coverage", "score", "draft", "demo"];
const listenKey = (e) => `${e.at}|${e.trackId ?? e.name}`;

async function syncListening() {
  const listens = (await getListens()).filter((e) => !e.demo);
  const { db: fdb, F } = await firebase();
  let log = listens.slice(-20000).map((e) => Object.fromEntries(LOG_FIELDS.filter((k) => e[k] != null).map((k) => [k, e[k]])));
  let z = await gzipJson(log);
  while (z.length > 850000 && log.length > 100) {
    log = log.slice(Math.floor(log.length / 4));
    z = await gzipJson(log);
  }
  await F.setDoc(F.doc(fdb, "private", myUid()), { log: F.Bytes.fromUint8Array(z), logCount: log.length, logAt: F.serverTimestamp() }, { merge: true });
  const scored = listens.map((e) => ({ ...e, score: state.records.get(e.recordId)?.finalScore ?? e.score }));
  await publishSummary({ lib: acc.profile?.lib ?? null, lis: listeningCard(listeningTotals(scored), heatmapBins(scored)) });
}

/** Listens saved online from another browser are added to this one's log. */
async function restoreListening() {
  const { db: fdb, F } = await firebase();
  const snap = await F.getDoc(F.doc(fdb, "private", myUid()));
  const z = snap.exists() ? snap.data().log : null;
  if (!z) return;
  const remote = await gunzipJson(z.toUint8Array());
  const have = new Set((await getListens()).map(listenKey));
  const missing = remote.filter((e) => !have.has(listenKey(e)));
  if (missing.length) await addListens(missing);
}

// ---------- games ----------

/** Posts the games' totals (and today's daily result) to the leaderboards. */
export function postGames({ stats, dailyResults, bestDailyStreak, today }) {
  if (!isSignedIn()) return;
  const values = boardValues(stats, dailyResults, bestDailyStreak);
  const day = today && dailyResults?.[today];
  if (day && Number.isFinite(day.points)) values[dayBoard(today)] = { v: day.points, x: null };
  queue(() => postScores(values));
}

