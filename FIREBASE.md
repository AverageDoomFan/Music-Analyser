# Cloud sharing and admin panel (Firebase)

Optional. Without it the app stays 100 % local and no cloud feature is shown.

With it:
- signed-in users can **opt in** to share their duels (> < =), their reports for analysis and a small profile (name, e-mail, counters);
- accounts with the **admin** role read everything in the admin panel (`admin.html`): overview, users, duels, disputed tracks, reports, dataset export.

## Security model

| Who | Can |
|---|---|
| Signed-out visitor | nothing |
| Signed-in user | read, write and delete **only** `users/{their uid}` and its `duels` / `reports` |
| Admin | read every user, duel and report; write nothing of other users |
| Anyone, from the app | **never** write `admins/…` |

- The admin role is a document `admins/{uid}` that only you create, by hand, in the Firebase console. The console bypasses the rules; the app cannot.
- Everything is enforced by `firebase/firestore.rules`, on Google's servers. The checks in the app only decide what to show: a visitor who edits the page's JavaScript still gets "permission denied".
- The rules also check every document's shape and size (unknown fields, a `role` field or oversized documents are refused).
- The web config (`apiKey`, `projectId`…) is public by design: it identifies the project, it grants nothing.
- Tested against the Firestore emulator: `npm install`, then `npm run test:rules` (needs Java).

## Setup

The Firebase project, the sign-in methods and `src/cloud/config.js` are the ones of the online account (README, "Online account (Firebase)"). The admin part only adds:

1. **Rules**: the admin collections are in the same file as the rest, [`firebase/firestore.rules`](firebase/firestore.rules). Firestore › Rules › replace everything with its content › Publish (or `npx firebase deploy --only firestore --project <id>`).
2. **Become admin**:
   1. Sign in from the Account tab. Settings › Share with the developer shows your **uid**; copy it.
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

Never audio or file paths. A user can delete everything they shared (Settings › Delete my cloud data); deleting the account deletes it too.

## Local development with the emulators

```sh
npm install
npx firebase emulators:start --only firestore,auth --project demo-mea
```
Then, in the browser console of the app: `localStorage.setItem("mea.firebase.dev", JSON.stringify({ projectId: "demo-mea", host: "127.0.0.1" }))` and reload (only that browser changes).
