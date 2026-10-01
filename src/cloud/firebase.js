// Firebase, loaded on demand from Google's CDN (no build step) only when a
// project is configured in config.js. Google sign-in; the admin role is a
// document admins/{uid} that only the project owner can create (console).

import { FIREBASE_CONFIG, EMULATORS } from "./config.js";
import { t } from "../i18n/index.js";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0";
let loading = null;
const adminCache = new Map();

export const cloudConfigured = () => !!FIREBASE_CONFIG?.apiKey && !!FIREBASE_CONFIG?.projectId;

/** { app, auth, db, A (auth module), F (firestore module) } once loaded. */
export function loadCloud() {
  if (!cloudConfigured()) return Promise.reject(new Error(t("Cloud is not set up in this copy of the app.")));
  loading ??= (async () => {
    const [appM, A, F] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const app = appM.initializeApp(FIREBASE_CONFIG);
    const auth = A.getAuth(app);
    const db = F.getFirestore(app);
    if (EMULATORS) {
      A.connectAuthEmulator(auth, EMULATORS.auth, { disableWarnings: true });
      F.connectFirestoreEmulator(db, EMULATORS.firestoreHost, EMULATORS.firestorePort);
    }
    await auth.authStateReady();
    return { app, auth, db, A, F };
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

export async function currentUser() {
  if (!cloudConfigured()) return null;
  const { auth } = await loadCloud();
  return auth.currentUser;
}

export async function onUserChange(fn) {
  if (!cloudConfigured()) return;
  const { auth, A } = await loadCloud();
  A.onAuthStateChanged(auth, fn);
}

export async function signIn() {
  const { auth, A } = await loadCloud();
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return (await A.signInWithPopup(auth, provider)).user;
}

export async function signOut() {
  const { auth, A } = await loadCloud();
  adminCache.clear();
  await A.signOut(auth);
}

/**
 * Whether the signed-in user is an admin. The security rules let a user read
 * only their own admins/{uid} document, and nobody can write it from the app:
 * this answer decides what the interface shows, the rules decide what can be read.
 */
export async function isAdmin() {
  const user = await currentUser();
  if (!user) return false;
  if (adminCache.has(user.uid)) return adminCache.get(user.uid);
  const { db, F } = await loadCloud();
  const yes = (await F.getDoc(F.doc(db, "admins", user.uid)).catch(() => null))?.exists() ?? false;
  adminCache.set(user.uid, yes);
  return yes;
}
