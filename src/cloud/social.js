// Friends (by friend code), user search, other users' pages, the duel
// profiles shared between friends, and the public leaderboards.

import { firebase } from "./firebase.js";
import { acc, myUid, isSignedIn, readable } from "./account.js";
import { cleanCode, normalizeText, gunzipJson, BOARDS } from "./pack.js";
import { t } from "../i18n/index.js";

// ---------- friends ----------

/** Adds a friend from their code: one doc on each side, written together. Returns their profile. */
export async function addFriend(typed) {
  const code = cleanCode(typed);
  if (!code) throw new Error(t("A friend code has 8 letters and digits."));
  if (code === acc.code) throw new Error(t("This is your own code."));
  const { db, F } = await firebase();
  const me = myUid();
  const owner = await F.getDoc(F.doc(db, "codes", code)).catch(() => null);
  if (!owner?.exists()) throw new Error(t("No one has this friend code."));
  const them = owner.data().uid;
  const batch = F.writeBatch(db);
  const now = F.serverTimestamp();
  batch.set(F.doc(db, "profiles", me, "friends", them), { at: now, via: code });
  batch.set(F.doc(db, "profiles", them, "friends", me), { at: now, via: code });
  try {
    await batch.commit();
  } catch (err) {
    throw new Error(readable(err));
  }
  return profileOf(them);
}

/** Ends a friendship on both sides. */
export async function removeFriend(uid) {
  const { db, F } = await firebase();
  const me = myUid();
  const batch = F.writeBatch(db);
  batch.delete(F.doc(db, "profiles", me, "friends", uid));
  batch.delete(F.doc(db, "profiles", uid, "friends", me));
  await batch.commit();
}

/** My friends with their profiles: [{ uid, name, public, since, profile }]. */
export async function friends() {
  if (!isSignedIn()) return [];
  const { db, F } = await firebase();
  const snap = await F.getDocs(F.collection(db, "profiles", myUid(), "friends"));
  const list = await Promise.all(snap.docs.map(async (d) => {
    const p = await profileOf(d.id);
    return { uid: d.id, since: d.data().at?.toMillis?.() ?? null, profile: p, name: p?.name ?? t("Deleted account") };
  }));
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- profiles ----------

/** Someone's profile if I may see it (public, mine, or a friend's), else null. */
export async function profileOf(uid) {
  const { db, F } = await firebase();
  try {
    const snap = await F.getDoc(F.doc(db, "profiles", uid));
    return snap.exists() ? { uid, ...snap.data() } : null;
  } catch {
    return null; // private
  }
}

/** Public profiles whose name starts with the query. */
export async function searchUsers(q) {
  const s = normalizeText(q) ? String(q).trim().toLowerCase() : "";
  if (!s) return [];
  const { db, F } = await firebase();
  const snap = await F.getDocs(F.query(F.collection(db, "profiles"),
    F.where("public", "==", true), F.where("nameLower", ">=", s), F.where("nameLower", "<", `${s}`),
    F.orderBy("nameLower"), F.limit(20)));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

/** Someone's library (Spotify ids + duel profile), if I may see it, else null. */
export async function libraryOf(uid) {
  const { db, F } = await firebase();
  try {
    const snap = await F.getDoc(F.doc(db, "libraries", uid));
    if (!snap.exists()) return null;
    const d = snap.data();
    return { ids: d.ids ?? [], n: d.n ?? 0, at: d.at?.toMillis?.() ?? null, duel: d.duel ? await gunzipJson(d.duel.toUint8Array()) : null };
  } catch {
    return null;
  }
}

// ---------- leaderboards ----------

/** Posts my values ({ board: { v, x } }); boards that only go up keep the best. */
export async function postScores(values) {
  if (!isSignedIn()) return;
  const { db, F } = await firebase();
  const me = myUid();
  for (const [board, { v, x }] of Object.entries(values)) {
    if (!Number.isFinite(v) || v <= 0) continue;
    const ref = F.doc(db, "boards", board, "entries", me);
    try {
      await F.runTransaction(db, async (tx) => {
        const cur = await tx.get(ref);
        if (cur.exists() && (BOARDS.includes(board) ? cur.data().v >= v && (cur.data().x ?? 0) >= (x ?? 0) : true)) return;
        const keepV = cur.exists() ? Math.max(cur.data().v, v) : v;
        tx.set(ref, { v: keepV, x: Number.isFinite(x) ? x : null, u: me, at: F.serverTimestamp() });
      });
    } catch (err) {
      console.warn("leaderboard", board, err);
    }
  }
}

/**
 * Top of a board with names: [{ uid, v, x, name, private, me }] and my own
 * rank when I am further down. Private accounts show as "private user".
 */
export async function board(boardId, n = 20) {
  const { db, F } = await firebase();
  const col = F.collection(db, "boards", boardId, "entries");
  const snap = await F.getDocs(F.query(col, F.orderBy("v", "desc"), F.limit(n)));
  const me = myUid();
  const rows = await Promise.all(snap.docs.map(async (d, i) => {
    const p = d.id === me ? acc.profile : await profileOf(d.id);
    const pub = p?.public === true;
    return { rank: i + 1, uid: d.id, v: d.data().v, x: d.data().x ?? null, name: d.id === me ? p?.name ?? "?" : pub ? p.name : null, private: !pub, me: d.id === me };
  }));
  let mine = null;
  if (me && !rows.some((r) => r.me)) {
    const own = await F.getDoc(F.doc(col, me)).catch(() => null);
    if (own?.exists()) {
      const above = await F.getCountFromServer(F.query(col, F.where("v", ">", own.data().v))).catch(() => null);
      mine = { rank: above ? above.data().count + 1 : null, uid: me, v: own.data().v, x: own.data().x ?? null, name: acc.profile?.name, me: true };
    }
  }
  return { rows, mine };
}
