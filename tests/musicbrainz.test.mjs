import test from "node:test";
import assert from "node:assert/strict";
import { createRateQueue } from "../src/util/rate-queue.js";
import {
  recordingSearchUrl, cleanTitle, primaryArtist, pickRecording, entityVotes,
  mergeGenreVotes, isInstrumental, isGenreTag, LEVEL_WEIGHTS,
} from "../src/util/musicbrainz.js";
import { parseTopTags } from "../src/util/lastfm.js";
import { mainGenre, hierarchyOf } from "../src/scoring/genre-map.js";
import { normalizeGenre, genrePath } from "../src/scoring/genres.js";

// ------------------------------------------------------------------ rate queue

function fakeClock() {
  const clock = { t: 1000, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}

test("rate queue: calls start at least intervalMs apart, in order", async () => {
  const c = fakeClock();
  const q = createRateQueue({ intervalMs: 1000, now: c.now, sleep: c.sleep });
  const starts = [];
  const results = await Promise.all([1, 2, 3].map((n) => q(() => { starts.push(c.t); return n * 10; })));
  assert.deepEqual(results, [10, 20, 30]);
  assert.deepEqual(starts, [1000, 2000, 3000]);
});

test("rate queue: no wait when the interval has already passed", async () => {
  const c = fakeClock();
  const q = createRateQueue({ intervalMs: 1000, now: c.now, sleep: c.sleep });
  await q(() => {});
  c.t += 5000;
  await q(() => {});
  assert.deepEqual(c.sleeps, []);
});

test("rate queue: a failing call does not block the next one", async () => {
  const c = fakeClock();
  const q = createRateQueue({ intervalMs: 500, now: c.now, sleep: c.sleep });
  const a = q(() => { throw new Error("boom"); });
  const b = q(() => "ok");
  await assert.rejects(a, /boom/);
  assert.equal(await b, "ok");
});

test("rate queue: backoff pushes the next start back", async () => {
  const c = fakeClock();
  const q = createRateQueue({ intervalMs: 1000, now: c.now, sleep: c.sleep });
  await q(() => {});
  q.backoff(2000);
  let at = null;
  await q(() => { at = c.t; });
  assert.equal(at, 1000 + 2000 + 1000);
});

// ------------------------------------------------------------------ queries

test("search URL: ISRC first, else artist + title; JSON format", () => {
  const u = recordingSearchUrl({ isrc: "us-um7-17-03861", artist: "X", title: "Y" });
  assert.match(u, /^https:\/\/musicbrainz\.org\/ws\/2\/recording\?query=/);
  assert.equal(decodeURIComponent(u.split("query=")[1].split("&")[0]), "isrc:USUM71703861");
  assert.match(u, /fmt=json/);
  const v = decodeURIComponent(recordingSearchUrl({ artist: "Daft Punk, Pharrell Williams", title: "Get Lucky - Radio Edit" }).split("query=")[1].split("&")[0]);
  assert.equal(v, 'recording:"Get Lucky" AND artist:"Daft Punk"');
  assert.equal(recordingSearchUrl({ title: "only a title" }), null);
  assert.match(decodeURIComponent(recordingSearchUrl({ artist: 'A "B"', title: "T" })), /artist:"A \\"B\\""/);
});

test("title and artist clean-up", () => {
  assert.equal(cleanTitle("Blinding Lights (feat. Someone)"), "Blinding Lights");
  assert.equal(cleanTitle("Heroes - 2017 Remaster"), "Heroes");
  assert.equal(cleanTitle("Song - Original Mix"), "Song - Original Mix");
  assert.equal(primaryArtist("Mumford & Sons"), "Mumford & Sons");
  assert.equal(primaryArtist("Calvin Harris feat. Rihanna"), "Calvin Harris");
});

// ------------------------------------------------------------------ parsing

const rel = (rg, type = "Album", extra = {}) => ({ status: "Official", "release-group": { id: rg, "primary-type": type, ...extra } });

test("pickRecording with an ISRC: pools the hits' tags, main release group is the album", () => {
  const json = {
    recordings: [
      { id: "r1", title: "Shape of You", score: 100, "artist-credit": [{ name: "Ed Sheeran", artist: { id: "a1", name: "Ed Sheeran" } }],
        tags: [{ name: "Pop", count: 3 }, { name: "seen live", count: 1 }], releases: [rel("rg-single", "Single"), rel("rg-album"), rel("rg-album")] },
      { id: "r2", title: "Shape of You", score: 100, "artist-credit": [{ name: "Ed Sheeran", artist: { id: "a1" } }],
        tags: [{ name: "pop", count: 1 }, { name: "dancehall", count: 2 }, { name: "bad", count: -2 }], releases: [rel("rg-comp", "Album", { "secondary-types": ["Compilation"] })] },
    ],
  };
  const r = pickRecording(json, { isrc: "GBAHS1600463" });
  assert.equal(r.id, "r1");
  assert.deepEqual(r.artistIds, ["a1"]);
  assert.equal(r.releaseGroupId, "rg-album");
  const tags = Object.fromEntries(r.votes.tags.map((x) => [x.name, x.count]));
  assert.deepEqual(tags, { pop: 4, "seen live": 1, dancehall: 2 });
});

test("pickRecording by artist + title: rejects other songs and wrong lengths", () => {
  const json = {
    recordings: [
      { id: "cover", title: "Hurt", score: 100, length: 218000, "artist-credit": [{ name: "Johnny Cash", artist: { id: "jc" } }] },
      { id: "long", title: "Hurt", score: 98, length: 400000, "artist-credit": [{ name: "Nine Inch Nails", artist: { id: "nin" } }] },
      { id: "good", title: "Hurt", score: 97, length: 373000, "artist-credit": [{ name: "Nine Inch Nails", artist: { id: "nin" } }], releases: [rel("rg1")] },
    ],
  };
  const r = pickRecording(json, { artist: "Nine Inch Nails", title: "Hurt", durationSec: 374 });
  assert.equal(r.id, "good");
  assert.equal(pickRecording(json, { artist: "Nobody", title: "Hurt" }), null);
  assert.equal(pickRecording({}, { artist: "A", title: "B" }), null);
  assert.equal(pickRecording(null, { isrc: "X" }), null);
});

test("entityVotes keeps positive votes, lowercase", () => {
  const v = entityVotes({ genres: [{ name: "Hip Hop", count: 5 }, { name: "trap", count: 0 }], tags: [{ name: "rap", count: 2 }] });
  assert.deepEqual(v, { genres: [{ name: "hip hop", count: 5 }], tags: [{ name: "rap", count: 2 }] });
  assert.deepEqual(entityVotes(null), { genres: [], tags: [] });
});

// ------------------------------------------------------------------ merging

test("mergeGenreVotes: levels normalised, track first, non-genre tags dropped", () => {
  const out = mergeGenreVotes([
    { weight: LEVEL_WEIGHTS.recording, genres: [], tags: [{ name: "drum and bass", count: 2 }, { name: "seen live", count: 9 }] },
    { weight: LEVEL_WEIGHTS.releaseGroup, genres: [{ name: "drum and bass", count: 1 }, { name: "liquid funk", count: 1 }], tags: [] },
    { weight: LEVEL_WEIGHTS.artist, genres: [{ name: "electronic", count: 40 }, { name: "drum and bass", count: 20 }, { name: "pop", count: 2 }], tags: [] },
  ]);
  assert.equal(out.genres[0], "drum and bass");
  assert.ok(out.genres.includes("liquid funk"));
  assert.ok(!out.genres.includes("seen live"));
  assert.ok(!out.genres.includes("pop")); // too few votes next to the rest
  assert.equal(out.weights[0], 1);
  assert.equal(out.genres.length, out.weights.length);
  assert.deepEqual(mergeGenreVotes([]), { genres: [], weights: [] });
  assert.deepEqual(mergeGenreVotes([null, { weight: 1, genres: [{ name: "instrumental", count: 3 }] }]), { genres: [], weights: [] });
});

test("isInstrumental: recording or album tag", () => {
  assert.equal(isInstrumental({ tags: [{ name: "instrumental", count: 1 }] }, null), true);
  assert.equal(isInstrumental({ tags: [] }, { genres: [{ name: "instrumental", count: 2 }] }), true);
  assert.equal(isInstrumental({ tags: [{ name: "rock", count: 1 }] }), false);
});

test("isGenreTag recognises genres, not descriptors", () => {
  for (const g of ["hip hop", "drum and bass", "alternative rock", "synthpop", "hardstyle"]) assert.ok(isGenreTag(g), g);
  for (const g of ["seen live", "british", "female vocalists", "favourites"]) assert.ok(!isGenreTag(g), g);
});

test("Last.fm top tags: genres only, relative weights", () => {
  const json = { toptags: { tag: [{ name: "Hip-Hop", count: 100 }, { name: "seen live", count: 80 }, { name: "rap", count: 60 }, { name: "trap", count: 5 }] } };
  assert.deepEqual(parseTopTags(json), { genres: ["hip-hop", "rap"], weights: [1, 0.6] });
  assert.deepEqual(parseTopTags({ error: 6 }), { genres: [], weights: [] });
  assert.deepEqual(parseTopTags({ toptags: { tag: { name: "techno", count: 10 } } }).genres, ["techno"]);
});

// ------------------------------------------------------------------ into the app's genre tree

test("MusicBrainz genre names land in the app's hierarchy", () => {
  assert.equal(hierarchyOf("hardcore hip hop"), "Rap & hip-hop › Hardcore Hip Hop");
  assert.equal(hierarchyOf("trip hop"), "Electronic › Trip hop");
  assert.equal(hierarchyOf("alternative rock"), "Rock › Alternative Rock");
  const label = mainGenre(["drum and bass", "liquid funk", "electronic"], [1, 0.6, 0.4]);
  assert.equal(label, "Electronic › Drum and bass › Liquid Funk");
  assert.equal(normalizeGenre(label), label);
  assert.deepEqual(genrePath(label), ["Electronic", "Drum and bass", "Liquid Funk"]);
});

test("mainGenre follows the votes when weights are given", () => {
  // without weights: two rock genres outvote one pop genre
  assert.equal(mainGenre(["pop", "rock", "indie rock"]), "Rock › Indie Rock");
  // with weights: pop is by far the most voted
  assert.equal(mainGenre(["pop", "rock", "indie rock"], [1, 0.2, 0.2]), "Pop");
  // a weakly voted, very specific genre does not win its family
  assert.equal(mainGenre(["techno", "minimal techno"], [1, 0.3]), "Electronic › Techno");
});

// ------------------------------------------------------------------ whole lookup, fetch stubbed

test("lookupTrackGenres: ISRC search, album and artist genres, cached by id", async () => {
  const { lookupTrackGenres } = await import("../src/util/musicbrainz.js");
  const calls = [];
  const answers = [
    [/\/recording\?query=isrc%3AUSUM71703861/, { recordings: [{ id: "rec", title: "HUMBLE.", score: 100, tags: [{ name: "hip hop", count: 2 }],
      "artist-credit": [{ name: "Kendrick Lamar", artist: { id: "kdot" } }], releases: [rel("damn")] }] }],
    [/\/release-group\/damn\?inc=genres\+tags/, { genres: [{ name: "conscious hip hop", count: 3 }, { name: "west coast hip hop", count: 2 }], tags: [] }],
    [/\/artist\/kdot\?inc=genres\+tags/, { genres: [{ name: "hip hop", count: 20 }, { name: "west coast hip hop", count: 12 }, { name: "jazz rap", count: 3 }], tags: [] }],
  ];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    const hit = answers.find(([re]) => re.test(url));
    return { ok: true, status: 200, json: async () => hit?.[1] ?? { recordings: [] } };
  };
  try {
    const cache = { artists: {}, releaseGroups: {} };
    const res = await lookupTrackGenres({ isrc: "USUM71703861", artist: "Kendrick Lamar", title: "HUMBLE." }, cache);
    assert.equal(res.found, true);
    assert.equal(res.mbid, "rec");
    assert.equal(res.genres[0], "hip hop");
    assert.ok(res.genres.includes("west coast hip hop"));
    assert.equal(mainGenre(res.genres, res.weights).split(" › ")[0], "Rap & hip-hop");
    assert.equal(calls.length, 3);
    assert.ok(cache.artists.kdot && cache.releaseGroups.damn);
    // same album and artist again: only the recording search is sent
    await lookupTrackGenres({ isrc: "USUM71703861" }, cache);
    assert.equal(calls.length, 4);
    // unknown track: nothing found
    const none = await lookupTrackGenres({ artist: "Nobody", title: "Nothing" }, cache);
    assert.equal(none.found, false);
  } finally {
    globalThis.fetch = saved;
  }
});
