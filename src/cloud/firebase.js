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
