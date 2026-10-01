// Firebase project of this copy of the app (cloud sync + admin panel).
//
// Leave FIREBASE_CONFIG as null to keep the app 100 % local: no cloud
// feature is shown. To turn the cloud on, paste the web app config from the
// Firebase console (Project settings › Your apps › Web app). These values are
// public by design: access is controlled by Firebase Authentication and the
// Firestore security rules (firestore.rules), never by hiding this file.
// Setup steps: FIREBASE.md.

export const FIREBASE_CONFIG = null;
// e.g.
// export const FIREBASE_CONFIG = {
//   apiKey: "AIza…",
//   authDomain: "my-project.firebaseapp.com",
//   projectId: "my-project",
//   appId: "1:123:web:abc",
// };

/** Local emulators for development (firebase emulators:start), or null. */
export const EMULATORS = null;
// e.g. { auth: "http://127.0.0.1:9099", firestoreHost: "127.0.0.1", firestorePort: 8080 }
