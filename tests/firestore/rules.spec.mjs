// Firestore security rules, run against the local emulator:
//   npm run test:rules
// (needs Java and the dev dependencies: npm install)
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, deleteDoc, collection, collectionGroup, getDocs, Timestamp } from "firebase/firestore";

let env;
const user = { name: "Alice", email: "a@x.io", lastSync: Timestamp.now(), counts: { duels: 1 } };
const duel = { a: "spotify:1", b: "spotify:2", aName: "A", bName: "B", winner: "tie", at: 1, source: "game", scores: [40, 50], algorithm: "2.4.1" };
const report = { trackId: "spotify:1", name: "A", at: "2026-10-01T10:00:00Z", expected: 20, finalScore: 40, comment: "too high", algorithm: "2.4.1", extractor: "1.6", data: "{}" };

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-mea",
    firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "admins/boss"), { note: "set in the console" });
    await setDoc(doc(db, "users/bob"), { ...user, name: "Bob" });
    await setDoc(doc(db, "users/bob/duels/d1"), duel);
    await setDoc(doc(db, "users/bob/reports/r1"), report);
  });
});

const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

test("a user writes and reads their own data", async () => {
  const db = as("alice");
  await assertSucceeds(setDoc(doc(db, "users/alice"), user));
  await assertSucceeds(setDoc(doc(db, "users/alice/duels/d1"), duel));
  await assertSucceeds(setDoc(doc(db, "users/alice/reports/r1"), report));
  await assertSucceeds(getDoc(doc(db, "users/alice")));
  await assertSucceeds(getDocs(collection(db, "users/alice/duels")));
  await assertSucceeds(deleteDoc(doc(db, "users/alice/duels/d1")));
});

test("a user cannot read or write someone else's data", async () => {
  const db = as("alice");
  await assertFails(getDoc(doc(db, "users/bob")));
  await assertFails(getDocs(collection(db, "users/bob/duels")));
  await assertFails(getDoc(doc(db, "users/bob/reports/r1")));
  await assertFails(setDoc(doc(db, "users/bob/duels/x"), duel));
  await assertFails(deleteDoc(doc(db, "users/bob")));
  await assertFails(getDocs(collection(db, "users")));
  await assertFails(getDocs(collectionGroup(db, "duels")));
  await assertFails(getDocs(collectionGroup(db, "reports")));
});

test("signed-out visitors get nothing", async () => {
  const db = anon();
  await assertFails(getDoc(doc(db, "users/bob")));
  await assertFails(getDocs(collectionGroup(db, "duels")));
  await assertFails(setDoc(doc(db, "users/bob"), user));
  await assertFails(getDoc(doc(db, "admins/boss")));
});

test("nobody can make themselves admin", async () => {
  await assertFails(setDoc(doc(as("alice"), "admins/alice"), { x: 1 }));
  await assertFails(setDoc(doc(as("boss"), "admins/alice"), { x: 1 }));
  await assertFails(getDocs(collection(as("boss"), "admins")));
  await assertSucceeds(getDoc(doc(as("alice"), "admins/alice"))); // reads "not admin"
  await assertFails(getDoc(doc(as("alice"), "admins/boss")));
});

test("an admin reads everything but writes nothing of others", async () => {
  const db = as("boss");
  await assertSucceeds(getDocs(collection(db, "users")));
  await assertSucceeds(getDoc(doc(db, "users/bob")));
  await assertSucceeds(getDocs(collectionGroup(db, "duels")));
  await assertSucceeds(getDocs(collectionGroup(db, "reports")));
  await assertFails(setDoc(doc(db, "users/bob/duels/x"), duel));
  await assertFails(deleteDoc(doc(db, "users/bob")));
});

test("malformed or oversized documents are refused", async () => {
  const db = as("alice");
  await assertFails(setDoc(doc(db, "users/alice"), { ...user, role: "admin" }));
  await assertFails(setDoc(doc(db, "users/alice"), { name: "no lastSync" }));
  await assertFails(setDoc(doc(db, "users/alice/duels/x"), { ...duel, winner: "maybe" }));
  await assertFails(setDoc(doc(db, "users/alice/duels/x"), { ...duel, extra: 1 }));
  await assertFails(setDoc(doc(db, "users/alice/reports/x"), { ...report, comment: "x".repeat(2001) }));
  await assertFails(setDoc(doc(db, "users/alice/reports/x"), { ...report, data: 42 }));
});
