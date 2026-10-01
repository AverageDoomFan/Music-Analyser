// Firebase project of the app (accounts, shared track database, leaderboards).
//
// These values are NOT secrets: every Firebase web app ships them to the
// browser, and anyone can read them here on GitHub. What keeps the data safe:
//   1. firebase/firestore.rules (deployed to the project): every read and
//      write is checked there, field by field;
//   2. Authentication › Settings › Authorized domains: only the GitHub Pages
//      domain (and localhost) can sign users in;
//   3. the API key restricted to that domain in Google Cloud console
//      (APIs & Services › Credentials);
//   4. optionally App Check (reCAPTCHA v3): requests must come from the real
//      site, not from a script. Put the reCAPTCHA site key in appCheckSiteKey.
// See "Online account (Firebase)" in the README for the setup steps.
//
// While apiKey is empty the app works exactly as before, offline, and the
// account page says the online features are not set up.

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDWMMIDl8FTTdJ1gRRk7gTEXJVM1uT76jM",
  authDomain: "music-analyser-385a1.firebaseapp.com",
  projectId: "music-analyser-385a1",
  storageBucket: "music-analyser-385a1.firebasestorage.app",
  messagingSenderId: "945881913184",
  appId: "1:945881913184:web:306e27f68b1d1cdd2ef005",
};

/** reCAPTCHA v3 site key for App Check (empty: App Check off). */
export const APP_CHECK_SITE_KEY = "";

/** Firebase JS SDK version loaded from Google's CDN. */
export const FIREBASE_SDK_VERSION = "12.19.0";
