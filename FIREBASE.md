# Cloud sharing and admin panel (Firebase)

Optional. Without it the app stays 100 % local and no cloud feature is shown.

With it:
- users can sign in with Google and **opt in** to share their duels (> < =), their reports for analysis and a small profile (name, e-mail, counters);
- accounts with the **admin** role read everything in the admin panel (`admin.html`): overview, users, duels, disputed tracks, reports, dataset export.

## Security model

| Who | Can |
|---|---|
| Signed-out visitor | nothing |
| Signed-in user | read, write and delete **only** `users/{their uid}` and its `duels` / `reports` |
| Admin | read every user, duel and report; write nothing of other users |
| Anyone, from the app | **never** write `admins/…` |

- The admin role is a document `admins/{uid}` that only you create, by hand, in the Firebase console. The console bypasses the rules; the app cannot.
- Everything is enforced by `firestore.rules`, on Google's servers. The checks in the app only decide what to show: a visitor who edits the page's JavaScript still gets "permission denied".
- The rules also check every document's shape and size (unknown fields, a `role` field or oversized documents are refused).
- The web config (`apiKey`, `projectId`…) is public by design: it identifies the project, it grants nothing.
- Tested against the Firestore emulator: `npm install`, then `npm run test:rules` (needs Java).

## Setup (about 10 minutes)

1. **Create the project**: [console.firebase.google.com](https://console.firebase.google.com) › Add project (Google Analytics not needed).
2. **Authentication** › Get started › Sign-in method › **Google** › Enable.
   Then Authentication › Settings › **Authorized domains** › add `averagedoomfan.github.io` (and `127.0.0.1` for local tests).
3. **Firestore Database** › Create database › **production mode** › pick a region (e.g. `eur3`).
4. **Rules**: Firestore › Rules › replace everything with the content of [`firestore.rules`](firestore.rules) › Publish.
   (Or with the CLI: `npx firebase login`, `npx firebase use --add`, `npx firebase deploy --only firestore:rules`.)
5. **Web app**: Project settings › General › Your apps › `</>` (Web) › register (no hosting). Copy the `firebaseConfig` values into [`src/cloud/config.js`](src/cloud/config.js):
   ```js
   export const FIREBASE_CONFIG = {
     apiKey: "…",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     appId: "…",
   };
   ```
   Commit and deploy (GitHub Pages).
6. **Become admin**:
   1. In the app: Settings › Share with the developer › Sign in with Google. Your **uid** is shown there; copy it.
   2. Firebase console › Firestore › Start collection `admins` › Document ID = your uid › any field (e.g. `note: "me"`) › Save.
   3. Reload: Settings shows "Open the admin panel" (or go to `/admin.html`).

To remove an admin, delete their `admins/{uid}` document.

## Optional hardening

- **App Check** (reCAPTCHA v3) limits requests to your site: Firebase console › App Check.
- **Budget alert** in Google Cloud billing (the free Spark plan has no billing at all; its daily quotas — 50k reads, 20k writes — are far above this use).

## What is stored

```
admins/{uid}                 (you, by hand)
users/{uid}                  name, email, lastSync, counts, app (versions, language), library (4 numbers)
users/{uid}/duels/{id}       a, b, aName, bName, winner, at, source, scores at the time, algorithm
users/{uid}/reports/{id}     trackId, name, at, expected, finalScore, comment, algorithm, extractor,
                             data (the full report as JSON text: measures, curves, sub-scores)
```

Never audio or file paths. A user can delete everything they shared (Settings › Delete my cloud data).

## Local development with the emulators

```sh
npm install
npx firebase emulators:start --only firestore,auth --project demo-mea
```
In `src/cloud/config.js`, use a `demo-…` project id and
`EMULATORS = { auth: "http://127.0.0.1:9099", firestoreHost: "127.0.0.1", firestorePort: 8080 }` (don't commit that).
