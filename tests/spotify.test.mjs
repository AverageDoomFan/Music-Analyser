import { test } from "node:test";
import assert from "node:assert/strict";
import { s256, SCOPES } from "../src/spotify/auth.js";
import { normalize, similarity, matchScore, matchPlaylist, candidatesFor, localInfo } from "../src/spotify/match.js";
import { readTags, parseFileName } from "../src/util/tags.js";

test("PKCE S256 challenge matches the RFC 7636 example", async () => {
  assert.equal(await s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const allowed = ["user-read-playback-state", "user-modify-playback-state"];
  assert.ok(SCOPES.every((s) => s.startsWith("playlist-") || allowed.includes(s)), "playlist + playback control scopes only");
});

test("title normalisation ignores decorations", () => {
  assert.equal(normalize("Déjà Vu (feat. Someone) - 2011 Remaster"), "deja vu");
  assert.equal(normalize("Song [Radio Edit]"), "song");
  assert.equal(normalize("Rock & Roll"), "rock and roll");
  assert.ok(similarity("Bohemian Rhapsody", "Bohemian Rhapsody - Remastered 2011") === 1);
  assert.ok(similarity("Numb", "Faint") < 0.3);
});

const rec = (id, name, tags, duration) => ({ id, name, tags, duration });
const records = [
  rec("a", "01 - Linkin Park - Numb.mp3", { title: "Numb", artist: "Linkin Park" }, 185.6),
  rec("b", "track02.mp3", { title: "In the End", artist: "Linkin Park", isrc: "USWB10002407" }, 216.9),
  rec("c", "Daft Punk - One More Time.flac", null, 320.4),
  rec("d", "Numb (Live).mp3", { title: "Numb", artist: "Linkin Park" }, 250),
];
const tracks = [
  { id: "t1", uri: "spotify:track:1", name: "Numb", artists: ["Linkin Park"], durationMs: 185000, isrc: null },
  { id: "t2", uri: "spotify:track:2", name: "In the End", artists: ["Linkin Park"], durationMs: 216000, isrc: "USWB10002407" },
  { id: "t3", uri: "spotify:track:3", name: "One More Time", artists: ["Daft Punk"], durationMs: 320000, isrc: null },
  { id: "t4", uri: "spotify:track:4", name: "Harder, Better, Faster, Stronger", artists: ["Daft Punk"], durationMs: 224000, isrc: null },
];

test("match score: ISRC, tags, file name, duration", () => {
  assert.equal(matchScore(tracks[1], localInfo(records[1])), 1, "same ISRC");
  assert.ok(matchScore(tracks[0], localInfo(records[0])) > 0.9);
  assert.ok(matchScore(tracks[2], localInfo(records[2])) > 0.8, "from file name");
  assert.ok(matchScore(tracks[0], localInfo(records[3])) < matchScore(tracks[0], localInfo(records[0])), "duration disambiguates the live version");
  assert.ok(matchScore(tracks[3], localInfo(records[2])) < 0.55);
});

test("one-to-one assignment with manual overrides", () => {
  const m = matchPlaylist(tracks, records);
  assert.equal(m.get("t1").recordId, "a");
  assert.equal(m.get("t2").recordId, "b");
  assert.equal(m.get("t3").recordId, "c");
  assert.ok(!m.has("t4"), "no file for t4");
  const ids = [...m.values()].map((v) => v.recordId);
  assert.equal(new Set(ids).size, ids.length);
  const manual = matchPlaylist(tracks, records, { t1: "d", t3: null });
  assert.equal(manual.get("t1").recordId, "d");
  assert.ok(manual.get("t1").manual);
  assert.ok(!manual.has("t3"), "explicitly unmatched");
  assert.equal(candidatesFor(tracks[0], records, 2)[0].id, "a");
});

function id3(frames, version = 3) {
  const enc = (s) => [...new TextEncoder().encode(s)];
  const body = [];
  for (const [id, text, e = 3] of frames) {
    const data = e === 1 ? [1, 0xff, 0xfe, ...[...text].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])] : [3, ...enc(text)];
    const n = data.length;
    const size = version === 4 ? [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    body.push(...enc(id), ...size, 0, 0, ...data);
  }
  const n = body.length;
  return new Uint8Array(["I".charCodeAt(0), "D".charCodeAt(0), "3".charCodeAt(0), version, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127, ...body, 0xff, 0xfb]).buffer;
}

test("tags: ID3v2.3 / v2.4 (UTF-8, UTF-16), FLAC, file name", () => {
  const t = readTags(id3([["TIT2", "Numb"], ["TPE1", "Linkin Park", 1], ["TSRC", "US-WB1-00-02407"]]), "x.mp3");
  assert.deepEqual([t.title, t.artist, t.isrc, t.source], ["Numb", "Linkin Park", "USWB10002407", "tags"]);
  const t4 = readTags(id3([["TIT2", "Été"], ["TPE1", "Artiste"]], 4), "x.mp3");
  assert.deepEqual([t4.title, t4.artist], ["Été", "Artiste"]);
  // FLAC: "fLaC" + VORBIS_COMMENT block (last)
  const comments = ["TITLE=One More Time", "ARTIST=Daft Punk"].map((c) => new TextEncoder().encode(c));
  const vendor = new TextEncoder().encode("test");
  const len = 4 + vendor.length + 4 + comments.reduce((a, c) => a + 4 + c.length, 0);
  const buf = new Uint8Array(8 + len);
  buf.set([0x66, 0x4c, 0x61, 0x43, 0x84, (len >> 16) & 255, (len >> 8) & 255, len & 255]);
  const dv = new DataView(buf.buffer);
  let p = 8;
  dv.setUint32(p, vendor.length, true); p += 4; buf.set(vendor, p); p += vendor.length;
  dv.setUint32(p, comments.length, true); p += 4;
  for (const c of comments) { dv.setUint32(p, c.length, true); p += 4; buf.set(c, p); p += c.length; }
  const f = readTags(buf.buffer, "x.flac");
  assert.deepEqual([f.title, f.artist], ["One More Time", "Daft Punk"]);
  const n = readTags(new ArrayBuffer(16), "03 - Daft Punk - Aerodynamic.mp3");
  assert.deepEqual([n.artist, n.title, n.source], ["Daft Punk", "Aerodynamic", "filename"]);
  assert.deepEqual(parseFileName("Title only.wav"), { artist: null, title: "Title only" });
});

test("a captured record matches its own Spotify track only", () => {
  const rec = { id: "spotify:t1", name: "A - B", duration: 200, source: { kind: "spotify", trackId: "t1" } };
  const t1 = { id: "t1", name: "B", artists: ["A"], durationMs: 200000 };
  const t2 = { id: "t2", name: "B", artists: ["A"], durationMs: 200000 };
  assert.equal(matchScore(t1, localInfo(rec)), 1);
  assert.equal(matchScore(t2, localInfo(rec)), 0);
  // a local file with the same confidence wins over the capture
  const file = { id: "f", name: "A - B.mp3", duration: 200, tags: { isrc: "X1" } };
  const m = matchPlaylist([{ ...t1, isrc: "X1" }], [rec, file]);
  assert.equal(m.get("t1").recordId, "f");
});

test("the Spotify device falls back to the one that is online (Web Player or app)", async () => {
  const { pickDevice } = await import("../src/spotify/devices.js");
  const web = { id: "web", name: "Web Player (Chrome)", type: "Computer", active: false, restricted: false };
  const app = { id: "app", name: "PC", type: "Computer", active: false, restricted: false };
  const phone = { id: "phone", name: "Phone", type: "Smartphone", active: true, restricted: false };
  // the desktop app chosen earlier is closed: the Web Player takes over
  assert.equal(pickDevice([web], "app").id, "web");
  assert.equal(pickDevice([web, app], "app").id, "app");
  assert.equal(pickDevice([app, { ...web, active: true }], null).id, "web");
  assert.equal(pickDevice([phone, web], null).id, "phone");
  assert.equal(pickDevice([{ ...web, restricted: true }], "web"), null);
  assert.equal(pickDevice([], "app"), null);
});
