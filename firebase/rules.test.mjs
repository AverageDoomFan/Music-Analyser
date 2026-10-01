// Security rules tests, on the Firestore emulator (needs Java):
//   npm i --no-save firebase@12 @firebase/rules-unit-testing firebase-tools
//   npx firebase emulators:exec --only firestore --project demo-mea "node --test firebase/rules.test.mjs"
// Not part of `npm test` (which needs nothing installed).

import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Bytes, collection, query, where, getDocs,
  runTransaction, collectionGroup, Timestamp,
} from "firebase/firestore";

let env;
const SID = "4uLU6hMCjMI75M1A2tKUQC"; // 22 base-62 characters, like a Spotify id
const SID2 = "7ouMYWpwJ422jRcDASZB7P";

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-mea",
    firestore: { rules: readFileSync(new URL("./firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
after(() => env?.cleanup());
beforeEach(() => env.clearFirestore());

const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

function profile(name = "Alice", pub = true) {
  return { name, nameLower: name.toLowerCase(), public: pub, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
}

function trackMeta(uid, over = {}) {
  return {
    t: "Song", a: "Artist", kw: ["song", "artist"], d: 200, isrc: null, v: "1.8", fv: 10800, alg: "2.4.1",
    s: 72.5, sub: { energy: 70 }, bpm: 128, key: "A min", cov: 0.8, mode: "whole", by: uid, at: serverTimestamp(),
    vs: 0, vc: 0, ...over,
  };
}
const feats = (uid, fv = 10800) => ({ v: "1.8", fv, z: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])), by: uid, at: serverTimestamp() });

async function share(db, uid, sid = SID, over = {}) {
  const b = writeBatch(db);
  b.set(doc(db, "tracks", sid), trackMeta(uid, over));
  b.set(doc(db, "features", sid), feats(uid, over.fv ?? 10800));
  return b.commit();
}

async function vote(db, uid, s, sid = SID) {
  return runTransaction(db, async (tx) => {
    const tr = await tx.get(doc(db, "tracks", sid));
    const v = await tx.get(doc(db, "tracks", sid, "votes", uid));
    const before = v.exists() ? v.data().s : null;
    const dc = (s != null ? 1 : 0) - (before != null ? 1 : 0);
    const ds = (s ?? 0) - (before ?? 0);
    if (s == null) tx.delete(v.ref);
    else tx.set(v.ref, { s, u: uid, at: serverTimestamp() });
    tx.update(tr.ref, { vs: tr.data().vs + ds, vc: tr.data().vc + dc });
  });
}

// ---------- profiles ----------

test("profiles: own create; others read only public ones", async () => {
  await assertSucceeds(setDoc(doc(as("alice"), "profiles", "alice"), profile("Alice", true)));
  await assertSucceeds(setDoc(doc(as("bob"), "profiles", "bob"), profile("Bob", false)));
  await assertFails(setDoc(doc(as("bob"), "profiles", "alice"), profile("Mallory")));
  await assertSucceeds(getDoc(doc(anon(), "profiles", "alice")));
  await assertFails(getDoc(doc(as("alice"), "profiles", "bob")));
  await assertSucceeds(getDoc(doc(as("bob"), "profiles", "bob")));
});

test("profiles: invalid fields are refused", async () => {
  const db = as("alice");
  await assertFails(setDoc(doc(db, "profiles", "alice"), { ...profile(), nameLower: "x" }));
  await assertFails(setDoc(doc(db, "profiles", "alice"), { ...profile(), admin: true }));
  await assertFails(setDoc(doc(db, "profiles", "alice"), { ...profile("A") }));
  await assertFails(setDoc(doc(db, "profiles", "alice"), { ...profile(), createdAt: Timestamp.fromMillis(0) }));
});

test("user search lists only public profiles", async () => {
  await setDoc(doc(as("alice"), "profiles", "alice"), profile("Alice", true));
  await setDoc(doc(as("bob"), "profiles", "bob"), profile("Bob", false));
  const db = as("carol");
  const res = await assertSucceeds(getDocs(query(collection(db, "profiles"), where("public", "==", true))));
  if (res.docs.map((d) => d.id).join() !== "alice") throw new Error("search leaked a private profile");
  await assertFails(getDocs(collection(db, "profiles")));
});

// ---------- friend codes and friends ----------

async function setupCodes() {
  await setDoc(doc(as("alice"), "profiles", "alice"), profile("Alice", false));
  await setDoc(doc(as("bob"), "profiles", "bob"), profile("Bob", false));
  await assertSucceeds(setDoc(doc(as("bob"), "codes", "BBBBCCCC"), { uid: "bob", at: serverTimestamp() }));
}

test("friend codes: claimed once, never listed", async () => {
  await setupCodes();
  await assertFails(setDoc(doc(as("alice"), "codes", "BBBBCCCC"), { uid: "alice", at: serverTimestamp() }));
  await assertFails(setDoc(doc(as("alice"), "codes", "AAAA0000"), { uid: "alice", at: serverTimestamp() }));
  await assertFails(setDoc(doc(as("alice"), "codes", "AAAABBBB"), { uid: "bob", at: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(as("alice"), "codes", "BBBBCCCC")));
  await assertFails(getDocs(collection(as("alice"), "codes")));
  await assertFails(getDoc(doc(anon(), "codes", "BBBBCCCC")));
});

test("friends: the right code makes friends on both sides; a wrong one does not", async () => {
  await setupCodes();
  const db = as("alice");
  const bad = writeBatch(db);
  bad.set(doc(db, "profiles", "alice", "friends", "bob"), { at: serverTimestamp(), via: "ZZZZZZZZ" });
  bad.set(doc(db, "profiles", "bob", "friends", "alice"), { at: serverTimestamp(), via: "ZZZZZZZZ" });
  await assertFails(bad.commit());
  const ok = writeBatch(db);
  ok.set(doc(db, "profiles", "alice", "friends", "bob"), { at: serverTimestamp(), via: "BBBBCCCC" });
  ok.set(doc(db, "profiles", "bob", "friends", "alice"), { at: serverTimestamp(), via: "BBBBCCCC" });
  await assertSucceeds(ok.commit());
  // friends see each other's private profile; others do not
  await assertSucceeds(getDoc(doc(as("bob"), "profiles", "alice")));
  await assertSucceeds(getDoc(doc(as("alice"), "profiles", "bob")));
  await assertFails(getDoc(doc(as("carol"), "profiles", "bob")));
  // carol cannot add herself to bob's friends with someone else's code
  await setDoc(doc(as("alice"), "codes", "AAAABBBB"), { uid: "alice", at: serverTimestamp() });
  await assertFails(setDoc(doc(as("carol"), "profiles", "bob", "friends", "carol"), { at: serverTimestamp(), via: "AAAABBBB" }));
  // either side can end it
  await assertSucceeds(deleteDoc(doc(as("bob"), "profiles", "alice", "friends", "bob")));
  await assertFails(deleteDoc(doc(as("carol"), "profiles", "bob", "friends", "alice")));
});

// ---------- private data and libraries ----------

test("private data: owner only", async () => {
  await assertSucceeds(setDoc(doc(as("alice"), "private", "alice"), { code: "AAAABBBB", logAt: serverTimestamp() }));
  await assertFails(getDoc(doc(as("bob"), "private", "alice")));
  await assertFails(setDoc(doc(as("bob"), "private", "alice"), { code: "AAAABBBB", logAt: serverTimestamp() }));
});

test("libraries: readable by the owner, friends, or anyone when the profile is public", async () => {
  await setDoc(doc(as("alice"), "profiles", "alice"), profile("Alice", false));
  const lib = { ids: [SID], n: 1, at: serverTimestamp(), duel: null };
  await assertSucceeds(setDoc(doc(as("alice"), "libraries", "alice"), lib));
  await assertFails(setDoc(doc(as("bob"), "libraries", "alice"), lib));
  await assertFails(getDoc(doc(as("bob"), "libraries", "alice")));
  await updateDoc(doc(as("alice"), "profiles", "alice"), { public: true, updatedAt: serverTimestamp() });
  await assertSucceeds(getDoc(doc(as("bob"), "libraries", "alice")));
});

// ---------- shared tracks ----------

test("tracks: shared with their measures, counters at zero", async () => {
  const db = as("alice");
  await assertFails(setDoc(doc(db, "tracks", SID), trackMeta("alice"))); // without features
  await assertFails(share(db, "alice", SID, { vs: 500, vc: 3 }));
  await assertFails(share(db, "alice", SID, { by: "bob" }));
  await assertFails(share(db, "alice", "not-a-spotify-id"));
  await assertSucceeds(share(db, "alice"));
  await assertFails(getDoc(doc(anon(), "tracks", SID)));
  await assertSucceeds(getDoc(doc(as("bob"), "features", SID)));
});

test("tracks: replaced only by a newer extractor or a clearly fuller capture", async () => {
  await share(as("alice"), "alice");
  await assertFails(share(as("bob"), "bob", SID, { cov: 0.82 }));
  await assertSucceeds(share(as("bob"), "bob", SID, { cov: 1 }));
  await assertFails(share(as("carol"), "carol", SID, { fv: 10700, cov: 1 }));
  await assertSucceeds(share(as("carol"), "carol", SID, { fv: 10900, cov: 0.5 }));
  await assertFails(deleteDoc(doc(as("carol"), "tracks", SID)));
});

test("votes: counters move by exactly my vote; one vote per user", async () => {
  await share(as("alice"), "alice");
  await assertSucceeds(vote(as("bob"), "bob", 80));
  await assertSucceeds(vote(as("carol"), "carol", 60));
  await assertSucceeds(vote(as("bob"), "bob", 90));
  let tr = (await getDoc(doc(as("bob"), "tracks", SID))).data();
  if (tr.vs !== 150 || tr.vc !== 2) throw new Error(`counters ${tr.vs}/${tr.vc}`);
  await assertSucceeds(vote(as("bob"), "bob", null));
  tr = (await getDoc(doc(as("bob"), "tracks", SID))).data();
  if (tr.vs !== 60 || tr.vc !== 1) throw new Error(`counters after removal ${tr.vs}/${tr.vc}`);
  // cheating: counters without a vote, a vote without counters, a vote for someone else
  const db = as("mallory");
  await assertFails(updateDoc(doc(db, "tracks", SID), { vs: 1000, vc: 2 }));
  await assertFails(setDoc(doc(db, "tracks", SID, "votes", "mallory"), { s: 100, u: "mallory", at: serverTimestamp() }));
  const b = writeBatch(db);
  b.set(doc(db, "tracks", SID, "votes", "bob"), { s: 100, u: "bob", at: serverTimestamp() });
  b.update(doc(db, "tracks", SID), { vs: 160, vc: 2 });
  await assertFails(b.commit());
  const b2 = writeBatch(db);
  b2.set(doc(db, "tracks", SID, "votes", "mallory"), { s: 100, u: "mallory", at: serverTimestamp() });
  b2.update(doc(db, "tracks", SID), { vs: 1060, vc: 2 });
  await assertFails(b2.commit());
  const b3 = writeBatch(db);
  b3.set(doc(db, "tracks", SID, "votes", "mallory"), { s: 100.5, u: "mallory", at: serverTimestamp() });
  b3.update(doc(db, "tracks", SID), { vs: 160.5, vc: 2 });
  await assertFails(b3.commit());
  // votes are private
  await assertFails(getDoc(doc(as("mallory"), "tracks", SID, "votes", "carol")));
  await assertSucceeds(getDocs(query(collectionGroup(as("carol"), "votes"), where("u", "==", "carol"))));
  await assertFails(getDocs(query(collectionGroup(as("carol"), "votes"), where("u", "==", "bob"))));
});

// ---------- leaderboards ----------

test("leaderboards: public read; own entry; cumulative boards only go up; a day takes one answer", async () => {
  const db = as("alice");
  const e = (v) => ({ v, x: 3, u: "alice", at: serverTimestamp() });
  await assertSucceeds(setDoc(doc(db, "boards", "trivia", "entries", "alice"), e(120)));
  await assertFails(setDoc(doc(db, "boards", "trivia", "entries", "alice"), e(100)));
  await assertSucceeds(setDoc(doc(db, "boards", "trivia", "entries", "alice"), e(150)));
  await assertFails(setDoc(doc(as("bob"), "boards", "trivia", "entries", "alice"), e(9999)));
  await assertFails(setDoc(doc(db, "boards", "made-up", "entries", "alice"), e(10)));
  await assertSucceeds(setDoc(doc(db, "boards", "day-2026-10-01", "entries", "alice"), e(87)));
  await assertFails(setDoc(doc(db, "boards", "day-2026-10-01", "entries", "alice"), e(95)));
  await assertFails(setDoc(doc(db, "boards", "day-2026-10-02", "entries", "alice"), e(101)));
  await assertSucceeds(getDocs(collection(anon(), "boards", "trivia", "entries")));
});
