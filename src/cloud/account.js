// Online account: sign-in (email + password, or Google), the profile (name,
// public / private), the friend code, and account deletion.
//
// State, observed with onAccount(fn):
//   { status: "off" | "loading" | "signed-out" | "needs-profile" | "ready" | "error",
//     user: { uid, email, provider } | null, profile, code, error }
// "off": no Firebase project configured (the app stays fully local).

import { firebase, cloudConfigured } from "./firebase.js";
import { randomCode, cleanName } from "./pack.js";
import { t } from "../i18n/index.js";

const listeners = new Set();
export const acc = { status: cloudConfigured() ? "loading" : "off", user: null, profile: null, code: null, error: null };

export function onAccount(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) {
    try { fn(acc); } catch (err) { console.error(err); }
  }
}

export const isSignedIn = () => acc.status === "ready";
export const myUid = () => acc.user?.uid ?? null;

/** Starts listening to the sign-in state (once, at startup). */
export async function initAccount() {
  if (!cloudConfigured()) return;
  try {
    const { auth, A } = await firebase();
    // back from a Google sign-in redirect (popup blocked)
    A.getRedirectResult(auth).catch((err) => console.warn("sign-in redirect", err));
    A.onAuthStateChanged(auth, (user) => { loadUser(user).catch(fail); });
  } catch (err) {
    fail(err);
  }
}

function fail(err) {
  console.error(err);
  acc.status = "error";
  acc.error = readable(err);
  emit();
}

async function loadUser(user) {
  if (!user) {
    Object.assign(acc, { status: "signed-out", user: null, profile: null, code: null, error: null });
    return emit();
  }
  acc.user = { uid: user.uid, email: user.email ?? null, provider: user.providerData?.[0]?.providerId ?? "password", name: user.displayName ?? null };
  acc.status = "loading";
  emit();
  const { db, F } = await firebase();
  const [p, priv] = await Promise.all([
    F.getDoc(F.doc(db, "profiles", user.uid)),
    F.getDoc(F.doc(db, "private", user.uid)),
  ]);
  acc.profile = p.exists() ? p.data() : null;
  acc.code = priv.exists() ? priv.data().code ?? null : null;
  acc.status = acc.profile ? "ready" : "needs-profile";
  acc.error = null;
  emit();
}

/** Readable message for a Firebase error. */
export function readable(err) {
  const code = err?.code ?? "";
  const map = {
    "auth/invalid-email": t("This email address is not valid."),
    "auth/missing-password": t("Type a password."),
    "auth/weak-password": t("Password too short: 8 characters at least."),
    "auth/email-already-in-use": t("An account already uses this email: sign in instead."),
    "auth/invalid-credential": t("Wrong email or password."),
    "auth/wrong-password": t("Wrong email or password."),
    "auth/user-not-found": t("Wrong email or password."),
    "auth/too-many-requests": t("Too many attempts: wait a few minutes."),
    "auth/popup-closed-by-user": t("Sign-in window closed."),
    "auth/network-request-failed": t("Network error: check your connection."),
    "auth/requires-recent-login": t("For safety, sign in again, then retry."),
    "auth/unauthorized-domain": t("This site is not allowed to sign in (Firebase › Authentication › Authorized domains)."),
    "auth/operation-not-allowed": t("This sign-in method is not turned on in the Firebase project."),
    "permission-denied": t("Refused by the database rules."),
    "unavailable": t("The database cannot be reached: check your connection."),
  };
  return map[code] ?? err?.message ?? String(err);
}

// ---------- sign in / out ----------

export async function signUp(email, password) {
  if (String(password ?? "").length < 8) throw new Error(t("Password too short: 8 characters at least."));
  const { auth, A } = await firebase();
  try {
    await A.createUserWithEmailAndPassword(auth, String(email).trim(), password);
  } catch (err) {
    throw new Error(readable(err));
  }
}

export async function signIn(email, password) {
  const { auth, A } = await firebase();
  try {
    await A.signInWithEmailAndPassword(auth, String(email).trim(), password);
  } catch (err) {
    throw new Error(readable(err));
  }
}

export async function signInGoogle() {
  const { auth, A } = await firebase();
  const provider = new A.GoogleAuthProvider();
  try {
    await A.signInWithPopup(auth, provider);
  } catch (err) {
    if (err?.code === "auth/popup-blocked") return A.signInWithRedirect(auth, provider);
    throw new Error(readable(err));
  }
}

export async function resetPassword(email) {
  const { auth, A } = await firebase();
  try {
    await A.sendPasswordResetEmail(auth, String(email).trim());
  } catch (err) {
    throw new Error(readable(err));
  }
}

export async function signOut() {
  const { auth, A } = await firebase();
  await A.signOut(auth);
}

// ---------- profile ----------

/** Creates the profile after the first sign-in: name, public or private, and a friend code. */
export async function createProfile({ name, isPublic }) {
  const clean = cleanName(name);
  if (!clean) throw new Error(t("Name: 2 to 30 characters."));
  const { db, F } = await firebase();
  const uid = myUid();
  const now = F.serverTimestamp();
  const profile = { name: clean, nameLower: clean.toLowerCase(), public: !!isPublic, createdAt: now, updatedAt: now };
  const code = await claimCode(uid);
  const batch = F.writeBatch(db);
  batch.set(F.doc(db, "profiles", uid), profile);
  batch.set(F.doc(db, "private", uid), { code, logAt: now }, { merge: true });
  try {
    await batch.commit();
  } catch (err) {
    throw new Error(readable(err));
  }
  await loadUser((await firebase()).auth.currentUser);
}

/** Reserves a new unused friend code (codes/{code} → my uid). */
async function claimCode(uid) {
  const { db, F } = await firebase();
  for (let i = 0; i < 6; i++) {
    const code = randomCode();
    try {
      // creating an existing code counts as an update: refused by the rules
      await F.setDoc(F.doc(db, "codes", code), { uid, at: F.serverTimestamp() });
      return code;
    } catch (err) {
      if (err?.code !== "permission-denied") throw new Error(readable(err));
    }
  }
  throw new Error(t("Could not create a friend code: try again."));
}

/** Changes the name and / or the public flag. */
export async function updateProfile({ name, isPublic } = {}) {
  const { db, F } = await firebase();
  const p = acc.profile;
  const clean = name != null ? cleanName(name) : p.name;
  if (!clean) throw new Error(t("Name: 2 to 30 characters."));
  const next = { name: clean, nameLower: clean.toLowerCase(), public: isPublic != null ? !!isPublic : p.public, updatedAt: F.serverTimestamp() };
  try {
    await F.updateDoc(F.doc(db, "profiles", myUid()), next);
  } catch (err) {
    throw new Error(readable(err));
  }
  acc.profile = { ...p, ...next };
  emit();
}

/** Writes the summaries shown on my account page (library and listening cards). */
export async function publishSummary({ lib, lis }) {
  if (!isSignedIn()) return;
  const { db, F } = await firebase();
  await F.updateDoc(F.doc(db, "profiles", myUid()), { lib: lib ?? null, lis: lis ?? null, updatedAt: F.serverTimestamp() });
  acc.profile = { ...acc.profile, lib, lis };
}

/** A new friend code; the old one stops working (existing friends stay friends). */
export async function newFriendCode() {
  const { db, F } = await firebase();
  const uid = myUid();
  const code = await claimCode(uid);
  const batch = F.writeBatch(db);
  if (acc.code) batch.delete(F.doc(db, "codes", acc.code));
  batch.set(F.doc(db, "private", uid), { code, logAt: F.serverTimestamp() }, { merge: true });
  await batch.commit();
  acc.code = code;
  emit();
  return code;
}

// ---------- deletion ----------

/**
 * Deletes everything of mine: votes (the tracks' counters go down), leaderboard
 * entries, friendships (both sides), library, private data, friend code,
 * profile, then the sign-in account itself. Shared analyses I uploaded stay
 * (they hold measures of a Spotify track, nothing about me but an opaque id).
 */
export async function deleteAccount({ password = "", onProgress = () => {} } = {}) {
  const { db, F, auth, A } = await firebase();
  const uid = myUid();
  if (!uid) return;
  // Firebase only deletes a recently signed-in account: confirm the identity
  // first, before anything is deleted
  try {
    const user = auth.currentUser;
    if (acc.user.provider === "google.com") await A.reauthenticateWithPopup(user, new A.GoogleAuthProvider());
    else await A.reauthenticateWithCredential(user, A.EmailAuthProvider.credential(user.email, password));
  } catch (err) {
    throw new Error(readable(err));
  }
  onProgress(t("Removing your votes…"));
  const votes = await F.getDocs(F.query(F.collectionGroup(db, "votes"), F.where("u", "==", uid)));
  for (const v of votes.docs) {
    const track = v.ref.parent.parent;
    await F.runTransaction(db, async (tx) => {
      const tr = await tx.get(track);
      const vote = await tx.get(v.ref);
      if (!tr.exists() || !vote.exists()) return;
      tx.update(track, { vs: tr.data().vs - vote.data().s, vc: tr.data().vc - 1 });
      tx.delete(v.ref);
    });
  }
  onProgress(t("Removing your leaderboard entries…"));
  const entries = await F.getDocs(F.query(F.collectionGroup(db, "entries"), F.where("u", "==", uid)));
  for (const e of entries.docs) await F.deleteDoc(e.ref);
  onProgress(t("Removing your friendships…"));
  const friends = await F.getDocs(F.collection(db, "profiles", uid, "friends"));
  for (const f of friends.docs) {
    const batch = F.writeBatch(db);
    batch.delete(f.ref);
    batch.delete(F.doc(db, "profiles", f.id, "friends", uid));
    await batch.commit();
  }
  onProgress(t("Removing what you shared with the developer…"));
  for (const sub of ["duels", "reports"]) {
    const docs = (await F.getDocs(F.collection(db, "users", uid, sub))).docs;
    for (let i = 0; i < docs.length; i += 400) {
      const b = F.writeBatch(db);
      for (const d of docs.slice(i, i + 400)) b.delete(d.ref);
      await b.commit();
    }
  }
  await F.deleteDoc(F.doc(db, "users", uid));
  onProgress(t("Removing your profile…"));
  const batch = F.writeBatch(db);
  if (acc.code) batch.delete(F.doc(db, "codes", acc.code));
  batch.delete(F.doc(db, "libraries", uid));
  batch.delete(F.doc(db, "private", uid));
  batch.delete(F.doc(db, "profiles", uid));
  await batch.commit();
  try {
    await A.deleteUser(auth.currentUser);
  } catch (err) {
    throw new Error(readable(err));
  }
}

