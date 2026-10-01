// Loads the Firebase SDK (from Google's CDN, only when the project is set up)
// and exposes the app, auth and Firestore handles plus the SDK functions.
//
// Local testing against the Firebase emulators: in the browser console,
//   localStorage.setItem("mea.firebase.dev", JSON.stringify({ projectId: "demo-mea", host: "127.0.0.1" }))
// then reload. This only changes that browser.

import { FIREBASE_CONFIG, APP_CHECK_SITE_KEY, FIREBASE_SDK_VERSION } from "./config.js";

const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

function devSettings() {
  try {
    const d = JSON.parse(localStorage.getItem("mea.firebase.dev") || "null");
    return d?.projectId ? d : null;
  } catch {
    return null;
  }
}

/** True when the app has a Firebase project to talk to. */
export const cloudConfigured = () => !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId) || !!devSettings();

let loading = null;

/**
 * { app, auth, db, A (auth functions), F (Firestore functions) }, loaded once.
 * Rejects when the project is not set up or the CDN cannot be reached.
 */
export function firebase() {
  if (loading) return loading;
  loading = (async () => {
    if (!cloudConfigured()) throw new Error("Online features are not set up.");
    const dev = devSettings();
    const [appMod, A, F] = await Promise.all([
      import(`${CDN}/firebase-app.js`),
      import(`${CDN}/firebase-auth.js`),
      import(`${CDN}/firebase-firestore.js`),
    ]);
    const config = dev ? { apiKey: "demo-key", authDomain: "localhost", projectId: dev.projectId } : FIREBASE_CONFIG;
    const app = appMod.initializeApp(config);
    if (APP_CHECK_SITE_KEY && !dev) {
      // App Check must start before the first Firestore / Auth request
      const C = await import(`${CDN}/firebase-app-check.js`);
      C.initializeAppCheck(app, { provider: new C.ReCaptchaV3Provider(APP_CHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
    }
    const auth = A.initializeAuth(app, {
      persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence],
      popupRedirectResolver: A.browserPopupRedirectResolver,
    });
    // local cache: what was read once is not read (and billed) again for nothing
    let db;
    try {
      db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
    } catch {
      db = F.getFirestore(app);
    }
    if (dev) {
      const host = dev.host || "127.0.0.1";
      A.connectAuthEmulator(auth, `http://${host}:${dev.authPort ?? 9099}`, { disableWarnings: true });
      F.connectFirestoreEmulator(db, host, dev.firestorePort ?? 8080);
    }
    return { app, auth, db, A, F };
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** Same as firebase(): the name the admin panel and the developer sharing use. */
export const loadCloud = firebase;

/** The signed-in Firebase user, or null (waits for the saved session to load). */
export async function currentUser() {
  if (!cloudConfigured()) return null;
  const { auth } = await firebase();
  await auth.authStateReady();
  return auth.currentUser;
}

export async function onUserChange(fn) {
  if (!cloudConfigured()) return;
  const { auth, A } = await firebase();
  A.onAuthStateChanged(auth, fn);
}

/** Google sign-in for the admin page (the app itself signs in from the Account tab). */
export async function signIn() {
  const { auth, A } = await firebase();
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return (await A.signInWithPopup(auth, provider)).user;
}

const adminCache = new Map();

export async function signOut() {
  const { auth, A } = await firebase();
  adminCache.clear();
  await A.signOut(auth);
}

/**
 * Whether the signed-in user is an admin: a document admins/{uid} that only the
 * project owner can create, in the Firebase console. The rules let a user read
 * only their own; this answer decides what the interface shows, the rules
 * decide what can be read.
 */
export async function isAdmin() {
  const user = await currentUser();
  if (!user) return false;
  if (adminCache.has(user.uid)) return adminCache.get(user.uid);
  const { db, F } = await firebase();
  const yes = (await F.getDoc(F.doc(db, "admins", user.uid)).catch(() => null))?.exists() ?? false;
  adminCache.set(user.uid, yes);
  return yes;
}
