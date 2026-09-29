// Use cases: import, cache lookup, analysis, rescoring, corrections, backup.
// UI modules call these functions and re-render from the store.

import { AUDIO_EXTENSIONS, DEFAULT_WEIGHTS, FEATURE_VERSION, ALGORITHM_VERSION, AGGREGATIONS, DEFAULT_AGGREGATION } from "../config.js";
import { state, notify } from "./store.js";
import { db } from "../storage/db.js";
import { buildExport, downloadJson, parseExport, mergeRecord } from "../storage/backup.js";
import { LocalFileSource, TestSource } from "../audio/sources.js";
import { analyzeAudio } from "../audio/analyzer.js";
import { readTags } from "../util/tags.js";
import {
  createRecord, applyFeatures, rescore, commitCorrection, clearCorrection, setManualScore,
  setLyricsRating, setVocals,
} from "../core/track.js";
import { lookupLyrics } from "../util/lyrics.js";
import { parseFileName } from "../util/tags.js";
import { fingerprints, similarTo } from "../scoring/similarity.js";
import { genrePath, normalizeGenre, genreVector, suggestGenres, SEP } from "../scoring/genres.js";
import { mainGenre, hierarchyOf } from "../scoring/genre-map.js";
import { matchPlaylist } from "../spotify/match.js";
import { fitWeights, fitPairwise } from "../scoring/learning.js";
import { buildProgression as buildOrder, buildGroupedProgression as buildGroupedOrder } from "../playlist/progression.js";
import { t } from "../i18n/index.js";

const PIPELINE_CONCURRENCY = 2;
let running = 0;
const pending = [];
let jobSeq = 0;

export async function init() {
  const saved = await db.getSetting("weights");
  if (saved) state.weights = sanitizeWeights(saved);
  const aggregation = await db.getSetting("aggregation");
  if (AGGREGATIONS.some((a) => a.key === aggregation)) state.aggregation = aggregation;
  const records = await db.getAllTracks();
  const changed = [];
  for (const r of records) {
    state.records.set(r.id, r);
    // new algorithm version or new weights: rescore from cached features
    if (rescore(r, scoring(), "migration")) changed.push(r);
  }
  if (changed.length) await db.putTracks(changed);
  notify();
  lookupMissingLyrics();
  return { count: records.length, rescored: changed.length };
}

/** Keeps only known dimensions (a dimension may be renamed between versions). */
function sanitizeWeights(weights) {
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(DEFAULT_WEIGHTS)) if (Number.isFinite(weights?.[k])) out[k] = weights[k];
  return out;
}

function isAudioFile(file) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  return file.type.startsWith("audio/") || AUDIO_EXTENSIONS.includes(ext);
}

/** Queues files for analysis. Returns counts of accepted / rejected files. */
export function importFiles(fileList) {
  const files = [...fileList];
  const accepted = files.filter(isAudioFile);
  for (const file of accepted) enqueue(new LocalFileSource(file));
  return { accepted: accepted.length, rejected: files.length - accepted.length };
}

/** Queues generated test-bench tracks ({file, testId}). */
export function importTestTracks(items) {
  for (const { file, testId } of items) enqueue(new TestSource(file, testId));
}

export async function deleteTestTracks() {
  const ids = [...state.records.values()].filter((r) => r.source?.kind === "test").map((r) => r.id);
  for (const id of ids) {
    state.records.delete(id);
    state.files.delete(id);
    await db.deleteTrack(id);
  }
  notify();
  return ids.length;
}

function enqueue(source, { force = false } = {}) {
  const key = `job-${++jobSeq}`;
  const job = { key, id: null, name: source.file?.name ?? "…", size: source.file?.size ?? null, stage: "queued", progress: 0 };
  state.jobs.set(key, job);
  state.queue.total++;
  notify();
  pending.push(() => processSource(source, job, force).catch((err) => {
    // failures before identification (unreadable file…)
    state.queue.errors++;
    state.queue.done++;
    state.jobs.delete(job.key);
    toastHook(`${job.name}: ${t(err.message || String(err))}`, "error");
    notify();
  }));
  pump();
}

function pump() {
  while (running < PIPELINE_CONCURRENCY && pending.length) {
    const task = pending.shift();
    running++;
    task().finally(() => {
      running--;
      pump();
      if (!running && !pending.length) finishQueue();
    });
  }
}

function finishQueue() {
  const q = state.queue;
  setTimeout(() => {
    if (running || pending.length) return;
    q.total = q.done = q.cached = q.errors = 0;
    notify();
  }, 2500);
}

async function processSource(source, job, force) {
  const meta = await source.getMetadata();
  job.stage = "hash";
  notify();
  const buffer = await source.getArrayBuffer();
  const identity = await source.getIdentity(buffer);
  if (source.file) state.files.set(identity.id, source.file);
  // tags are read before decoding (decodeAudioData detaches the buffer)
  meta.tags = readTags(buffer, meta.name);
  return ingest({ identity, meta, sourceDesc: source.describe(), job, force, analyze: (cb) => analyzeAudio(buffer, cb) });
}

/** Cache lookup, record creation, analysis and persistence, shared by every source. */
async function ingest({ identity, meta, sourceDesc, job, force, analyze }) {
  let record;
  try {
    job.id = identity.id;
    // Duplicate inside the same batch: let the first job handle it.
    const dup = [...state.jobs.values()].find((j) => j !== job && j.id === identity.id);
    if (dup) {
      state.queue.cached++;
      return;
    }

    const existing = state.records.get(identity.id);
    if (existing && existing.features && existing.featureVersion === FEATURE_VERSION && !force) {
      // Cache hit: no decoding, no analysis.
      rescore(existing, scoring());
      if (!existing.name) existing.name = meta.name;
      if (sourceDesc?.kind === "test") existing.source = sourceDesc;
      if (meta.tags && !existing.tags) existing.tags = meta.tags;
      await db.putTrack(existing);
      state.queue.cached++;
      return;
    }

    record = existing ?? createRecord({ ...meta, id: identity.id, hashAlgorithm: identity.algorithm, source: sourceDesc });
    record.source = sourceDesc;
    if (meta.tags) record.tags = meta.tags;
    if (!existing) {
      state.records.set(record.id, record);
      await db.putTrack(record);
    }
    job.stage = "decode";
    notify();
    const features = await analyze((stage, p) => {
      job.stage = stage;
      job.progress = p;
      notify();
    });
    if (features.sourceLoudnessLufs <= -69) throw new Error(t("Silent audio: nothing to analyse."));
    applyFeatures(record, features, scoring());
    await db.putTrack(record);
    lookupMissingLyrics();
  } catch (err) {
    console.error(err);
    state.queue.errors++;
    if (record) {
      record.error = err.message || String(err);
      record.updatedAt = Date.now();
      await db.putTrack(record).catch(() => {});
    } else {
      toastHook(`${job.name}: ${t(err.message || String(err))}`, "error");
    }
  } finally {
    state.queue.done++;
    state.jobs.delete(job.key);
    notify();
  }
}

// UI can register a toast function to surface pipeline errors.
let toastHook = () => {};
export function onToast(fn) { toastHook = fn; }

export function reanalyze(id) {
  const file = state.files.get(id);
  if (!file) return false;
  const r = state.records.get(id);
  enqueue(r?.source?.kind === "test" ? new TestSource(file, r.source.test) : new LocalFileSource(file), { force: true });
  return true;
}

export async function recompute(id) {
  const r = state.records.get(id);
  if (!r) return;
  r.auto = null;
  rescore(r, scoring(), "recompute");
  await save(r);
}

export async function recomputeAll() {
  const changed = [];
  for (const r of state.records.values()) {
    if (!r.features) continue;
    r.auto = null;
    rescore(r, scoring(), "recompute");
    changed.push(r);
  }
  await db.putTracks(changed);
  notify();
  return changed.length;
}

export async function saveCorrection(id, answers) {
  const r = state.records.get(id);
  commitCorrection(r, answers, scoring());
  await save(r);
}

export async function removeCorrection(id) {
  const r = state.records.get(id);
  clearCorrection(r);
  await save(r);
}

export async function setManual(id, value) {
  const r = state.records.get(id);
  setManualScore(r, value);
  await save(r);
}

// ---------- lyrics & vocals ----------

/** User's rating of the lyrics mood ({mood, strength} or null to clear). */
export async function setLyrics(id, rating) {
  const r = state.records.get(id);
  if (!r) return;
  setLyricsRating(r, rating);
  await save(r);
}

export async function setVocalState(id, value) {
  const r = state.records.get(id);
  if (!r) return;
  setVocals(r, value, "user");
  await save(r);
}

/** Artist / title of a record for lookups (tags, then file name). */
function trackMeta(r) {
  const fromName = parseFileName((r.name ?? "").replace(/\.[a-z0-9]{2,4}$/i, ""));
  return {
    artist: r.tags?.artist || fromName.artist || "",
    title: r.tags?.title || fromName.title || r.name,
    durationSec: r.duration ?? null,
  };
}

export const lyricsLookupEnabled = () => db.getSetting("lyricsLookup").then((v) => !!v).catch(() => false);
export async function setLyricsLookup(on) {
  await db.setSetting("lyricsLookup", !!on);
  if (on) lookupMissingLyrics();
}

/** LRCLIB lookup for one record (sends artist / title only). */
export async function lookupLyricsFor(id) {
  const r = state.records.get(id);
  if (!r) return null;
  const meta = trackMeta(r);
  const res = await lookupLyrics(meta);
  r.lyricsHint = { ...res, at: Date.now() };
  // the database only decides when the user has not
  if (res.found && r.vocals?.source !== "user") {
    r.vocals = { state: res.instrumental ? "instrumental" : "vocal", source: "lrclib", at: Date.now() };
  }
  await save(r);
  return res;
}

let lookupRunning = false;
/** Background lookups for records never looked up (when enabled), one every 600 ms. */
export async function lookupMissingLyrics() {
  if (lookupRunning || !(await lyricsLookupEnabled())) return;
  lookupRunning = true;
  try {
    for (const r of [...state.records.values()]) {
      if (r.lyricsHint || !r.auto || r.vocals?.source === "user") continue;
      if (!trackMeta(r).artist) continue;
      try {
        await lookupLyricsFor(r.id);
      } catch (err) {
        console.warn("LRCLIB", err);
        break; // network / CORS problem: stop, retry on next start
      }
      await new Promise((res) => setTimeout(res, 600));
    }
  } finally {
    lookupRunning = false;
  }
}

/** Sung tracks without a lyrics rating (to ask the user). */
export function lyricsToRate() {
  return [...state.records.values()].filter((r) => r.auto && r.vocals?.state === "vocal" && !r.lyrics && !r.manual);
}

// ---------- pairwise judgements ("which one is more intense?") ----------

const DUELS_KEY = "comparisons";
export async function getComparisons() {
  return (await db.getSetting(DUELS_KEY).catch(() => null)) ?? [];
}

export async function addComparison(a, b, winner) {
  const list = await getComparisons();
  list.push({ a, b, winner, at: Date.now() });
  await db.setSetting(DUELS_KEY, list.slice(-500));
  return list.length;
}

export async function clearComparisons() {
  await db.setSetting(DUELS_KEY, []);
}

const windowsOf = (r) => {
  const { times, subscores } = r.auto.curves;
  return { windows: times.map((_, i) => Object.fromEntries(Object.entries(subscores).map(([d, arr]) => [d, arr[i]]))), times, aggregation: state.aggregation };
};

/**
 * Next pair to judge: close scores (the model hesitates), not compared yet,
 * preferably different timbres (the judgement tells more).
 */
export async function nextDuel() {
  const done = new Set((await getComparisons()).map((c) => [c.a, c.b].sort().join("|")));
  const rs = [...state.records.values()].filter((r) => r.auto?.curves && r.finalScore != null);
  if (rs.length < 2) return null;
  const fps = libraryFingerprints();
  let best = null;
  for (let tries = 0; tries < 400; tries++) {
    const a = rs[Math.floor(Math.random() * rs.length)], b = rs[Math.floor(Math.random() * rs.length)];
    if (a === b || done.has([a.id, b.id].sort().join("|"))) continue;
    const gap = Math.abs(a.finalScore - b.finalScore);
    const fa = fps.get(a.id), fb = fps.get(b.id);
    const far = fa && fb ? Math.min(1, Math.hypot(...fa.map((x, i) => x - fb[i])) / Math.sqrt(fa.length) / 1.5) : 0.5;
    const value = -gap / 10 + far + Math.random() * 0.3;
    if (!best || value > best.value) best = { a: a.id, b: b.id, value };
  }
  return best;
}

/** Weights fitted on the duels (not applied). */
export async function proposeFromDuels() {
  const pairs = (await getComparisons())
    .map((c) => ({ a: state.records.get(c.a), b: state.records.get(c.b), winner: c.winner }))
    .filter((p) => p.a?.auto?.curves && p.b?.auto?.curves)
    .map((p) => ({ a: windowsOf(p.a), b: windowsOf(p.b), winner: p.winner }));
  if (pairs.filter((p) => p.winner !== "tie").length < 6) return { error: t("At least 6 decided duels are needed."), n: pairs.length };
  return fitPairwise(pairs, state.weights);
}

// ---------- similarity ----------

let fpCache = { key: "", fps: new Map() };
function libraryFingerprints() {
  const key = [...state.records.values()].map((r) => `${r.id}:${r.featureVersion}`).join("|");
  if (key !== fpCache.key) fpCache = { key, fps: fingerprints([...state.records.values()]) };
  return fpCache.fps;
}
export const similarTracks = (id, k = 5) => similarTo(id, libraryFingerprints(), k);

// ---------- personal genres ----------

/** Sets (or clears) the user's genre label; the user's label always wins. */
export async function setGenre(id, label) {
  const r = state.records.get(id);
  if (!r) return;
  const norm = normalizeGenre(label);
  r.genre = norm ? { label: norm, source: "user", at: Date.now() } : null;
  r.updatedAt = Date.now();
  genreCache.key = "";
  await save(r);
}

/** Every label in use (user labels, then model predictions), most used first. */
export function allGenres() {
  const count = new Map();
  for (const r of state.records.values()) {
    const g = r.genre?.label ?? spotifyMain(r);
    if (!g) continue;
    const path = genrePath(g);
    for (let i = 1; i <= path.length; i++) {
      const k = path.slice(0, i).join(SEP);
      count.set(k, (count.get(k) ?? 0) + (i === path.length ? 1 : 0.001));
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

const genreCache = { key: "", map: new Map() };
/** kNN suggestions for every unlabelled record (recomputed when labels or analyses change). */
function genreSuggestions() {
  const key = [...state.records.values()].map((r) => `${r.id}:${r.genre?.label ?? ""}:${r.extGenres?.at ?? ""}:${r.featureVersion}:${Math.round(r.finalScore ?? -1)}`).join("|");
  if (key === genreCache.key) return genreCache.map;
  const fps = libraryFingerprints();
  const vecs = new Map();
  for (const r of state.records.values()) {
    const v = genreVector(r, fps.get(r.id));
    if (v) vecs.set(r.id, v);
  }
  const labelled = [...state.records.values()]
    .map((r) => ({ id: r.id, label: r.genre?.label ?? spotifyMain(r), vec: vecs.get(r.id) }))
    .filter((l) => l.label && l.vec);
  const map = new Map();
  for (const [id, v] of vecs) {
    const others = labelled.filter((l) => l.id !== id);
    if (others.length) map.set(id, suggestGenres(v, others));
  }
  genreCache.key = key;
  genreCache.map = map;
  return map;
}

/**
 * Genre of a record: { label, source: "user" | "spotify" | "musicbrainz" | "neighbours", confidence, suggestions, spotify }.
 * Only the user's label is certain; the others are shown as suggestions.
 */
export function genreInfo(r) {
  const spotify = (r.extGenres?.genres ?? []).map((g) => ({ label: hierarchyOf(g), raw: g }));
  // neighbours only matter for tracks without their own Spotify genres
  const suggestions = spotify.length ? [] : genreSuggestions().get(r.id) ?? [];
  const base = { suggestions, spotify };
  if (r.genre?.label) return { ...base, label: r.genre.label, source: "user", confidence: 1 };
  const sp = spotifyMain(r);
  if (sp) return { ...base, label: sp, source: r.extGenres.source ?? "spotify", confidence: 0.9 };
  if (suggestions[0] && suggestions[0].confidence >= 0.45) return { ...base, label: suggestions[0].label, source: "neighbours", confidence: suggestions[0].confidence };
  return { ...base, label: null, source: null, confidence: 0 };
}

/** Main hierarchical label from the track's Spotify artist genres. */
function spotifyMain(r) {
  return r.extGenres?.genres?.length ? mainGenre(r.extGenres.genres) : null;
}

// ---------- Spotify artist genres ----------

const artistCache = () => spotifyStore.get("artistGenres").then((c) => c ?? {}).catch(() => ({}));

/** Genres of the track's artists (primary artist first), from the cache. */
function genresFor(artistIds, cache) {
  const out = [];
  for (const id of artistIds ?? []) for (const g of cache[id]?.genres ?? []) if (!out.includes(g)) out.push(g);
  return out;
}

/**
 * Fetches the artist genres of every imported playlist and of every captured
 * track, and attaches them to the records (captured tracks and associated files).
 * @returns {Promise<{tracks:number, artists:number, fieldMissing:boolean}>}
 */
export async function fetchSpotifyGenres(onProgress = () => {}) {
  const api = await import("../spotify/api.js");
  const playlists = await importedPlaylists();
  // playlists imported before artist ids were kept: read them again
  for (const pl of playlists) {
    if (pl.tracks.some((t) => !t.isLocal && !t.artistIds)) {
      pl.tracks = await api.playlistTracks(pl.id);
      await rememberPlaylist(pl);
      const cur = await spotifyStore.get("playlist").catch(() => null);
      if (cur?.id === pl.id) await spotifyStore.set("playlist", pl);
    }
  }
  const records = [...state.records.values()];
  const captured = records.filter((r) => r.source?.kind === "spotify" && r.source.artistIds?.length);
  const cache = await artistCache();
  const month = 30 * 24 * 3600e3;
  const ids = [...new Set([
    ...playlists.flatMap((pl) => pl.tracks.flatMap((t) => t.artistIds ?? [])),
    ...captured.flatMap((r) => r.source.artistIds),
  ])];
  const todo = ids.filter((id) => !cache[id] || Date.now() - cache[id].at > month);
  let fieldMissing = false;
  if (todo.length) {
    const res = await api.artistGenres(todo, onProgress);
    fieldMissing = res.fieldMissing;
    for (const [id, genres] of res.genres) cache[id] = { genres, at: Date.now() };
    await spotifyStore.set("artistGenres", cache);
  }
  // attach to records: the capture itself, and the file matched to each playlist track
  const manual = (await spotifyStore.get("matches").catch(() => null)) ?? {};
  const changed = new Set();
  const attach = (r, artistIds) => {
    const genres = genresFor(artistIds, cache);
    if (!r || !genres.length || r.extGenres?.source === "user") return;
    r.extGenres = { source: "spotify", genres, artists: artistIds, at: Date.now() };
    changed.add(r);
  };
  for (const r of captured) attach(r, r.source.artistIds);
  for (const pl of playlists) {
    const m = matchPlaylist(pl.tracks, records, manual);
    for (const t of pl.tracks) {
      attach(state.records.get(m.get(t.id)?.recordId), t.artistIds);
      attach(state.records.get(capturedId(t)), t.artistIds);
    }
  }
  if (changed.size) await db.putTracks([...changed]);
  const withGenres = records.filter((r) => r.extGenres?.genres?.length).length;
  await spotifyStore.set("genresRun", { at: Date.now(), tracks: changed.size, artists: ids.length, fieldMissing, withGenres });
  genreCache.key = "";
  notify();
  return { tracks: changed.size, artists: ids.length, fieldMissing };
}

/** Automatic genre fetch at startup: once a day, or when tracks still lack genres. */
export async function autoFetchGenres() {
  const run = await spotifyStore.get("genresRun").catch(() => null);
  const missing = [...state.records.values()].some((r) => r.auto && !r.extGenres?.genres?.length && r.source?.kind === "spotify");
  if (run && Date.now() - run.at < 24 * 3600e3 && !(missing && !run.fieldMissing && Date.now() - run.at > 3600e3)) return null;
  return fetchSpotifyGenres();
}

/** Where the genres come from, for the status lines of the library / home / Spotify tab. */
export async function genreStatus() {
  const analysed = [...state.records.values()].filter((r) => r.auto);
  const count = (src) => analysed.filter((r) => r.extGenres?.source === src && r.extGenres.genres?.length).length;
  return {
    analysed: analysed.length,
    spotify: count("spotify"),
    musicbrainz: count("musicbrainz"),
    user: analysed.filter((r) => r.genre?.label).length,
    labelled: analysed.filter((r) => genreInfo(r).label).length,
    run: await spotifyStore.get("genresRun").catch(() => null),
  };
}

/**
 * Fallback when Spotify gives no genres: artist tags from MusicBrainz, an
 * open music database. Only the artist name is sent; one request per second
 * (their rate limit); results cached. Never overrides Spotify genres.
 */
export async function fetchMusicBrainzGenres(onProgress = () => {}) {
  const cache = (await db.getSetting("mbArtistTags").catch(() => null)) ?? {};
  const artistOf = (r) => (r.tags?.artist || trackMeta(r).artist || "").split(/,\s*|\s+feat\.?\s+|\s+&\s+/i)[0].trim();
  const targets = [...state.records.values()].filter((r) => r.auto && !r.extGenres?.genres?.length && artistOf(r));
  const names = [...new Set(targets.map((r) => artistOf(r).toLowerCase()))].filter((n) => !cache[n]);
  let done = 0;
  for (const name of names) {
    onProgress(done, names.length);
    try {
      const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&limit=1&fmt=json`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 503) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      const data = await res.json();
      const a = data.artists?.[0];
      const tags = a && a.score >= 90 ? (a.tags ?? []).filter((x) => x.count > 0).sort((x, y) => y.count - x.count).slice(0, 6).map((x) => x.name) : [];
      cache[name] = { tags, at: Date.now() };
    } catch {
      cache[name] = { tags: [], at: Date.now(), error: true };
    }
    done++;
    if (done % 10 === 0) await db.setSetting("mbArtistTags", cache);
    await new Promise((r) => setTimeout(r, 1100));
  }
  await db.setSetting("mbArtistTags", cache);
  const changed = [];
  for (const r of targets) {
    const tags = cache[artistOf(r).toLowerCase()]?.tags ?? [];
    if (!tags.length) continue;
    r.extGenres = { source: "musicbrainz", genres: tags, artists: [artistOf(r)], at: Date.now() };
    changed.push(r);
  }
  if (changed.length) await db.putTracks(changed);
  genreCache.key = "";
  notify();
  return { tracks: changed.length, artists: names.length };
}

async function attachCachedGenres(record, artistIds) {
  const genres = genresFor(artistIds, await artistCache());
  if (genres.length) record.extGenres = { source: "spotify", genres, artists: artistIds, at: Date.now() };
}

/** Stores a track's rhythm map (lanes, notes, parameters, selection). */
export async function saveRhythm(id, rhythm) {
  const r = state.records.get(id);
  if (!r) return;
  r.rhythm = rhythm;
  await db.putTrack(r);
}

export async function deleteTrack(id) {
  state.records.delete(id);
  state.files.delete(id);
  await db.deleteTrack(id);
  notify();
}

async function save(r) {
  await db.putTrack(r);
  notify();
}

// ---------- weights ----------

export async function setWeights(weights) {
  state.weights = sanitizeWeights(weights);
  await db.setSetting("weights", state.weights);
  const changed = [];
  for (const r of state.records.values()) if (rescore(r, scoring(), "weights")) changed.push(r);
  await db.putTracks(changed);
  notify();
}

/** Current scoring settings. */
export const scoring = () => ({ weights: state.weights, aggregation: state.aggregation });

/** Chooses how intensity curves become scores; rescoring uses cached curves' features only. */
export async function setAggregation(aggregation) {
  if (!AGGREGATIONS.some((a) => a.key === aggregation)) return;
  state.aggregation = aggregation;
  await db.setSetting("aggregation", aggregation);
  const changed = [];
  for (const r of state.records.values()) if (rescore(r, scoring(), "aggregation")) changed.push(r);
  await db.putTracks(changed);
  notify();
}

export function correctionSamples() {
  return [...state.records.values()]
    .filter((r) => r.auto?.curves && (r.correction || r.manual))
    .map((r) => {
      const { times, subscores } = r.auto.curves;
      const windows = times.map((_, i) => Object.fromEntries(Object.entries(subscores).map(([d, arr]) => [d, arr[i]])));
      return { windows, times, aggregation: state.aggregation, target: r.finalScore };
    });
}

/** Proposes weights fitted on the user's corrections (not applied). */
export function proposeWeights() {
  const samples = correctionSamples();
  if (samples.length < 3) return { error: t("At least 3 corrected tracks are needed."), n: samples.length };
  return fitWeights(samples, state.weights);
}

// ---------- diagnostic export (compact, to tune the model on a real library) ----------

/**
 * @param {{full?: boolean}} [o]  full: also every measure as stored (with
 *   their curves over time), the sub-score components and the intensity curve,
 *   so that the model can be refitted exactly (bigger file, no rescan needed).
 */
export async function exportDiagnostic({ full = false } = {}) {
  const r3 = (x) => (Number.isFinite(x) ? Number(x.toPrecision(3)) : null);
  const deep = (v) => (typeof v === "number" ? r3(v)
    : ArrayBuffer.isView(v) ? Array.from(v, r3)
    : Array.isArray(v) ? v.map(deep)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
    : v);
  const db10 = (x) => (Number.isFinite(x) ? r3(10 * Math.log10(Math.max(x, 1e-12))) : null);
  const recs = [...state.records.values()].filter((r) => r.auto && r.features);
  const index = new Map(recs.map((r, i) => [r.id, i]));
  const tracks = recs.map((r) => {
    const f = r.features;
    const src = r.source ?? {};
    return {
      n: r.name,
      g: genreInfo(r).label,
      sg: (r.extGenres?.genres ?? []).slice(0, 5),
      src: src.kind === "spotify" || src.kind === "test" ? `${src.kind}:${src.mode ?? "file"}:${Math.round((src.coverage ?? 1) * 100)}` : src.kind ?? "local",
      s: r3(r.finalScore), a: r3(r.auto.score),
      u: {
        ...(r.manual ? { m: r.manual.score } : {}),
        ...(r.correction ? { c: r3(r.correction.score), q: r.correction.answers } : {}),
        ...(r.lyrics ? { ly: `${r.lyrics.mood}:${r.lyrics.strength}` } : {}),
        ...(r.vocals ? { vo: r.vocals.state } : {}),
      },
      sub: Object.fromEntries(Object.entries(r.auto.subscores).map(([k, v]) => [k, Math.round(v)])),
      st: { top: r3(r.auto.stats?.topMean), mean: r3(r.auto.stats?.mean), var: r3(r.auto.stats?.variability) },
      f: {
        bpm: r3(f.bpm), bc: r3(f.bpmConfidence), on: r3(f.onsetRate), oe: r3(f.onsetEnvMean), io: r3(f.ioiCv),
        lr: r3(f.loudnessRange), plr: r3(f.plrDb), cr: r3(f.crestDb), clip: r3(f.clippingRatio), src: r3(f.sourceLoudnessLufs),
        bass: r3(f.bassRatio), sub: r3(f.bandSub), lp: r3(f.lowPulse), lstd: r3(f.lowBandDbStd), lfl: db10(f.lowFlatnessMedian),
        kick: r3(f.kickRate), kp: r3(f.kickPunch),
        cen: r3(f.centroidMean), cstd: r3(f.centroidStd), roll: r3(f.rolloffMean), bw: r3(f.bandwidthMean),
        flat: db10(f.flatnessMedian), fill: r3(f.spectralFill), flux: r3(f.fluxMean), fstd: r3(f.fluxStd), crest: r3(f.spectralCrestMean),
        hi: r3(f.highRatio), sil: r3(f.silenceRatio), dur: Math.round(f.duration ?? 0), an: Math.round(f.analyzedSeconds ?? 0),
        mfl: db10(f.midFlatnessMedian), pr: r3(f.pulseRate), ps: r3(f.pulseStrength),
      },
      v: r3(r.valence), k: r.auto.music?.key?.name ?? null,
      ...(full ? {
        F: deep(f),
        X: Object.fromEntries(Object.entries(r.auto.explain ?? {}).map(([k, list]) => [k, list.map((c) => [c.label, c.value, c.weight])])),
        cv: deep({ t: r.auto.curves?.times, i: r.auto.curves?.intensity }),
      } : {}),
    };
  });
  const duels = (await getComparisons())
    .filter((c) => index.has(c.a) && index.has(c.b))
    .map((c) => [index.get(c.a), index.get(c.b), c.winner]);
  const data = {
    app: "mea-diagnostic", full, algorithm: ALGORITHM_VERSION, extractor: FEATURE_VERSION,
    weights: state.weights, aggregation: state.aggregation, exportedAt: new Date().toISOString(),
    count: tracks.length, tracks, duels,
  };
  downloadJson(data, full ? "music-analyser-diagnostic-full.json" : "music-analyser-diagnostic.json");
  return tracks.length;
}

// ---------- reports for analysis ----------

const REPORTS_KEY = "reports";

export async function getReports() {
  return (await db.getSetting(REPORTS_KEY).catch(() => null)) ?? [];
}

/**
 * Saves a detailed snapshot of one track for a closer look at the model:
 * every measure (and their curves), sub-scores and how they are built, the
 * user's rating, expected score and comment. No audio, no file path.
 */
export async function reportTrack(id, { comment = "", expected = null } = {}) {
  const r = state.records.get(id);
  if (!r?.auto) throw new Error("Track not analysed.");
  const src = r.source ?? {};
  const report = {
    id,
    at: new Date().toISOString(),
    algorithm: ALGORITHM_VERSION,
    extractor: r.featureVersion,
    name: r.name,
    source: { kind: src.kind ?? "local", mode: src.mode ?? null, coverage: src.coverage ?? null, excerpts: src.excerpts ?? null, uri: src.uri ?? null },
    genre: genreInfo(r).label,
    externalGenres: r.extGenres ?? null,
    expected: Number.isFinite(expected) ? expected : null,
    comment: String(comment ?? "").slice(0, 2000),
    finalScore: r.finalScore,
    user: { manual: r.manual ?? null, correction: r.correction ?? null, lyrics: r.lyrics ?? null, vocals: r.vocals ?? null },
    auto: {
      score: r.auto.score, aggregation: r.auto.aggregation, subscores: r.auto.subscores, confidences: r.auto.confidences,
      stats: r.auto.stats, explain: r.auto.explain, curves: r.auto.curves, music: r.auto.music,
    },
    weights: state.weights,
    features: r.features,
  };
  const list = (await getReports()).filter((x) => x.id !== id);
  list.push(report);
  await db.setSetting(REPORTS_KEY, list.slice(-60));
  return list.length;
}

/** Downloads the saved reports (all, or the given track ids). */
export async function exportReports(ids = null) {
  const all = await getReports();
  const reports = ids ? all.filter((x) => ids.includes(x.id)) : all;
  downloadJson({ app: "mea-reports", exportedAt: new Date().toISOString(), count: reports.length, reports },
    reports.length === 1 ? `music-analyser-report-${reports[0].name.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}.json` : "music-analyser-reports.json");
  return reports.length;
}

export async function clearReports() {
  await db.setSetting(REPORTS_KEY, []);
}

// ---------- backup ----------

export async function exportDatabase() {
  const data = buildExport([...state.records.values()], { weights: state.weights, aggregation: state.aggregation });
  downloadJson(data, "music-energy-database.json");
  return data.tracks.length;
}

export async function importDatabase(file) {
  const { tracks, settings } = parseExport(await file.text());
  const merged = [];
  for (const incoming of tracks) {
    const rec = mergeRecord(state.records.get(incoming.id), incoming);
    rescore(rec, scoring(), "import");
    state.records.set(rec.id, rec);
    merged.push(rec);
  }
  await db.putTracks(merged);
  notify();
  return { count: merged.length, weights: settings.weights ?? null, aggregation: settings.aggregation ?? null };
}

export async function clearAllData() {
  await db.clearAll();
  state.records.clear();
  state.files.clear();
  state.weights = { ...DEFAULT_WEIGHTS };
  state.aggregation = DEFAULT_AGGREGATION;
  state.progression = null;
  notify();
}

// ---------- progression ----------

/** Progression input for one analysed record (null if not analysed). */
function progressionItem(r) {
  if (r?.finalScore == null || !r.auto) return null;
  // a correction shifts the whole curve: apply the same offset to its start / end
  const offset = r.finalScore - r.auto.score;
  const stats = r.auto.stats ?? {};
  return {
    id: r.id, name: r.name, duration: r.duration, score: r.finalScore,
    start: (stats.start ?? r.auto.score) + offset,
    end: (stats.end ?? r.auto.score) + offset,
    subscores: { ...r.auto.subscores, ...(r.correction?.overrides ?? {}) },
  };
}

export function buildProgression(tolerance, { byStyle = false } = {}) {
  const ids = [...state.records.values()].filter((r) => progressionItem(r)).map((r) => r.id);
  const res = orderRecords(ids, tolerance, { byStyle });
  const base = buildOrder(ids.map((id) => progressionItem(state.records.get(id))), { tolerance });
  // stats of the plain order; steps of the chosen one
  state.progression = { ...base, steps: res.steps, byStyle, tolerance, builtAt: Date.now() };
  notify();
  return state.progression;
}

/** Orders any subset of records (e.g. the files matched with a Spotify playlist). */
export function orderRecords(ids, tolerance = 6, { byStyle = false } = {}) {
  const items = ids.map((id) => progressionItem(state.records.get(id))).filter(Boolean);
  if (!byStyle) return buildOrder(items, { tolerance });
  // style = top two levels of the genre (e.g. "Electronic › Hard dance")
  return buildGroupedOrder(items, (it) => {
    const g = genreInfo(state.records.get(it.id)).label;
    return g ? genrePath(g).slice(0, 2).join(SEP) : null;
  }, { tolerance });
}

// ---------- set generator ----------

/** Generator input for one analysed record (null if not analysed). */
export function setItem(r, fps = libraryFingerprints()) {
  const base = progressionItem(r);
  if (!base) return null;
  const m = r.auto.music ?? {};
  return {
    ...base,
    artist: trackMeta(r).artist?.toLowerCase() || null,
    valence: r.valence ?? null,
    bpm: m.tempo?.bpm ?? null, bpmStart: m.tempo?.start ?? null, bpmEnd: m.tempo?.end ?? null,
    key: m.key?.index ?? null, keyStart: m.key?.start ?? null, keyEnd: m.key?.end ?? null,
    fp: fps.get(r.id) ?? null,
  };
}

export function setPool(ids = null) {
  const fps = libraryFingerprints();
  const list = ids ? ids.map((id) => state.records.get(id)) : [...state.records.values()];
  return list.map((r) => setItem(r, fps)).filter(Boolean);
}

// ---------- live scan (audio captured from the Spotify app) ----------

export const capturedId = (track) => `spotify:${track.id}`;

/** Stores the features of a captured track as a library record. */
export async function saveCaptured(track, features, info) {
  const id = capturedId(track);
  const name = `${track.artists?.join(", ") || "?"} - ${track.name}`;
  const record = state.records.get(id) ?? createRecord({ id, hashAlgorithm: "spotify-id", name, size: null, type: "spotify", lastModified: null });
  record.name = name;
  record.source = {
    kind: track.demo ? "test" : "spotify", test: track.demo ? track.id : undefined,
    trackId: track.id, uri: track.uri, url: track.url ?? null, image: track.image ?? null,
    mode: info.mode, coverage: info.coverage, excerpts: info.excerpts, probes: info.probes, capturedAt: Date.now(),
  };
  if (track.demo) record.name = `${t("Demo")} · ${track.name}`;
  if (track.artistIds?.length) {
    record.source.artistIds = track.artistIds;
    await attachCachedGenres(record, track.artistIds);
  }
  record.tags = { title: track.name, artist: track.artists?.join(", ") ?? "", album: track.album ?? "", isrc: track.isrc ?? null, source: "spotify" };
  state.records.set(id, record);
  applyFeatures(record, features, scoring());
  await save(record);
  return record;
}

/** Captured record of a track, if it is analysed with the current extractor. */
export function capturedRecord(track) {
  const r = state.records.get(capturedId(track));
  return r?.features && r.featureVersion === FEATURE_VERSION ? r : null;
}

// ---------- Spotify (stored locally, cleared on disconnect) ----------

export const spotifyStore = {
  get: (key) => db.getSetting(`spotify.${key}`),
  set: (key, value) => db.setSetting(`spotify.${key}`, value),
  clear: async () => {
    for (const k of ["playlist", "matches", "library"]) await db.setSetting(`spotify.${k}`, null);
  },
};

/** Every playlist imported so far (id → playlist), for comparisons, exports and diffs. */
export async function importedPlaylists() {
  const lib = (await spotifyStore.get("library").catch(() => null)) ?? {};
  const cur = await spotifyStore.get("playlist").catch(() => null);
  if (cur && !lib[cur.id]) lib[cur.id] = cur;
  return Object.values(lib);
}

/**
 * Stores an imported playlist and returns what changed since its previous
 * import: { added: tracks, removed: tracks, previousAt }.
 */
export async function rememberPlaylist(pl) {
  const lib = (await spotifyStore.get("library").catch(() => null)) ?? {};
  const current = await spotifyStore.get("playlist").catch(() => null);
  const prev = lib[pl.id] ?? (current?.id === pl.id ? current : null);
  lib[pl.id] = pl;
  await spotifyStore.set("library", lib);
  if (!prev) return null;
  const before = new Set(prev.tracks.map((t) => t.id));
  const after = new Set(pl.tracks.map((t) => t.id));
  return {
    added: pl.tracks.filter((t) => !before.has(t.id)),
    removed: prev.tracks.filter((t) => !after.has(t.id)),
    previousAt: prev.importedAt,
  };
}

export async function forgetPlaylist(id) {
  const lib = (await spotifyStore.get("library").catch(() => null)) ?? {};
  delete lib[id];
  await spotifyStore.set("library", lib);
}
