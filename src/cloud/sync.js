// Opt-in upload of the user's duels and reports (and a small profile) to
// Firestore, so the project owner can look at them in the admin panel.
// Nothing leaves the browser unless the user signs in AND turns sharing on.

import { ALGORITHM_VERSION, FEATURE_VERSION } from "../config.js";
import { state } from "../app/store.js";
import { db as localDb } from "../storage/db.js";
import * as ctl from "../app/controller.js";
import { getLang } from "../i18n/index.js";
import { loadCloud, currentUser, cloudConfigured } from "./firebase.js";
import { duelDoc, reportDoc, userDoc, duelId, reportId } from "./docs.js";

const KEY = "cloud";
const BATCH = 400;
const listeners = new Set();
let timer = 0;
let running = null;
export const status = { syncing: false, lastSync: null, error: null };

export async function cloudSettings() {
  return { share: false, marks: {}, ...((await localDb.getSetting(KEY).catch(() => null)) ?? {}) };
}
/** What was already uploaded, per account: { duelsAt, reportsAt }. */
const marksOf = (settings, uid) => ({ duelsAt: 0, reportsAt: "", ...settings.marks?.[uid] });
async function saveSettings(patch) {
  const next = { ...(await cloudSettings()), ...patch };
  await localDb.setSetting(KEY, next);
  return next;
}

export function onSyncChange(fn) { listeners.add(fn); }
const changed = () => { for (const fn of listeners) fn(status); };

export async function setShare(on) {
  await saveSettings({ share: !!on });
  if (on) return syncNow();
  return null;
}

/** Called after each new duel / report: sync a few seconds later if sharing is on. */
export function scheduleSync() {
  if (!cloudConfigured()) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const s = await cloudSettings();
    if (s.share && (await currentUser())) syncNow().catch(() => {});
  }, 4000);
}

/** Uploads what changed since the last sync (duels and reports newer than the watermarks). */
export function syncNow() {
  running ??= doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  const user = await currentUser();
  if (!user) throw new Error("Not signed in.");
  const settings = await cloudSettings();
  if (!settings.share) return { duels: 0, reports: 0 };
  const marks = marksOf(settings, user.uid);
  Object.assign(status, { syncing: true, error: null });
  changed();
  try {
    const { db, F } = await loadCloud();
    const names = new Map([...state.records.values()].map((r) => [r.id, r.name]));
    const duels = (await ctl.getComparisons()).filter((d) => (d.at ?? 0) > marks.duelsAt);
    const reports = (await ctl.getReports()).filter((r) => String(r.at) > marks.reportsAt);
    const writes = [
      ...duels.map((d) => [F.doc(db, "users", user.uid, "duels", duelId(d)), duelDoc(d, names)]),
      ...reports.map((r) => [F.doc(db, "users", user.uid, "reports", reportId(r)), reportDoc(r)]),
    ];
    // reports are big: fewer per batch (a batch is limited to 10 MiB)
    for (let i = 0; i < writes.length;) {
      const batch = F.writeBatch(db);
      let n = 0, bytes = 0;
      while (i < writes.length && n < BATCH && bytes < 8e6) {
        const [ref, data] = writes[i++];
        batch.set(ref, data);
        n++;
        bytes += data.data?.length ?? 300;
      }
      await batch.commit();
    }
    const allDuels = await ctl.getComparisons();
    const allReports = await ctl.getReports();
    await F.setDoc(F.doc(db, "users", user.uid), userDoc({
      user, records: [...state.records.values()], duels: allDuels.length, reports: allReports.length,
      app: { algorithm: ALGORITHM_VERSION, extractor: FEATURE_VERSION, lang: getLang() },
    }, F.serverTimestamp()));
    await saveSettings({
      marks: {
        ...settings.marks,
        [user.uid]: {
          duelsAt: Math.max(marks.duelsAt, ...duels.map((d) => d.at ?? 0)),
          reportsAt: [marks.reportsAt, ...reports.map((r) => String(r.at))].sort().at(-1) ?? "",
        },
      },
    });
    status.lastSync = Date.now();
    return { duels: duels.length, reports: reports.length };
  } catch (err) {
    status.error = err.message;
    throw err;
  } finally {
    status.syncing = false;
    changed();
  }
}

/** Deletes everything this user put in the cloud and turns sharing off. */
export async function deleteMyCloudData() {
  const user = await currentUser();
  if (!user) throw new Error("Not signed in.");
  const { db, F } = await loadCloud();
  for (const sub of ["duels", "reports"]) {
    const snap = await F.getDocs(F.collection(db, "users", user.uid, sub));
    for (let i = 0; i < snap.docs.length; i += BATCH) {
      const batch = F.writeBatch(db);
      for (const d of snap.docs.slice(i, i + BATCH)) batch.delete(d.ref);
      await batch.commit();
    }
  }
  await F.deleteDoc(F.doc(db, "users", user.uid));
  const settings = await cloudSettings();
  const { [user.uid]: _gone, ...marks } = settings.marks ?? {};
  await saveSettings({ share: false, marks });
  changed();
}
