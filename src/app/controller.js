// Use cases: import, cache lookup, analysis, rescoring, corrections, backup.
// UI modules call these functions and re-render from the store.

import { AUDIO_EXTENSIONS, DEFAULT_WEIGHTS, FEATURE_VERSION, AGGREGATIONS, DEFAULT_AGGREGATION } from "../config.js";
import { state, notify } from "./store.js";
import { db } from "../storage/db.js";
import { buildExport, downloadJson, parseExport, mergeRecord } from "../storage/backup.js";
import { LocalFileSource, TestSource } from "../audio/sources.js";
import { analyzeAudio } from "../audio/analyzer.js";
import { readTags } from "../util/tags.js";
import {
  createRecord, applyFeatures, rescore, commitCorrection, clearCorrection, setManualScore,
  setLyricsRating, setVocals, computeFinal as computeFinalFor,
} from "../core/track.js";
import { lookupLyrics } from "../util/lyrics.js";
import { parseFileName } from "../util/tags.js";
import { fingerprints, similarTo } from "../scoring/similarity.js";
import { genrePath, normalizeGenre, genreVector, suggestGenres, SEP } from "../scoring/genres.js";
import { fitWeights, fitPairwise } from "../scoring/learning.js";
import { buildProgression as buildOrder } from "../playlist/progression.js";

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
export function sanitizeWeights(weights) {
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(DEFAULT_WEIGHTS)) if (Number.isFinite(weights?.[k])) out[k] = weights[k];
  return out;
}

export function isAudioFile(file) {
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

export function enqueue(source, { force = false } = {}) {
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
    toastHook(`${job.name} : ${err.message || err}`, "error");
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
    if (features.sourceLoudnessLufs <= -69) throw new Error("Audio silencieux : rien à analyser.");
    applyFeatures(record, features, scoring());
    await db.putTrack(record);
    lookupMissingLyrics();
    if (state.files.has(record.id)) queueEssentia(record.id);
  } catch (err) {
    console.error(err);
    state.queue.errors++;
    if (record) {
      record.error = err.message || String(err);
      record.updatedAt = Date.now();
      await db.putTrack(record).catch(() => {});
    } else {
      toastHook(`${job.name} : ${err.message || err}`, "error");
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
  rescore(r, scoring(), "recalcul");
  await save(r);
}

export async function recomputeAll() {
  const changed = [];
  for (const r of state.records.values()) {
    if (!r.features) continue;
    r.auto = null;
    rescore(r, scoring(), "recalcul");
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
export function trackMeta(r) {
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
  if (pairs.filter((p) => p.winner !== "tie").length < 6) return { error: "Il faut au moins 6 duels tranchés.", n: pairs.length };
  return fitPairwise(pairs, state.weights);
}

// ---------- similarity ----------

let fpCache = { key: "", fps: new Map() };
export function libraryFingerprints() {
  const key = [...state.records.values()].map((r) => `${r.id}:${r.featureVersion}`).join("|");
  if (key !== fpCache.key) fpCache = { key, fps: fingerprints([...state.records.values()]) };
  return fpCache.fps;
}
export const similarTracks = (id, k = 5) => similarTo(id, libraryFingerprints(), k);

// ---------- Essentia models (optional) ----------

export const essentiaModels = async () => (await db.getSetting("essentiaModels").catch(() => null)) ?? [];
export const essentiaAuto = async () => !!(await db.getSetting("essentiaAuto").catch(() => false));
export const setEssentiaAuto = (on) => db.setSetting("essentiaAuto", !!on);

export async function importEssentiaModels(files) {
  const { importModels } = await import("../ml/essentia.js");
  const added = await importModels(files);
  const list = (await essentiaModels()).filter((m) => !added.some((a) => a.name === m.name));
  await db.setSetting("essentiaModels", [...list, ...added]);
  return added;
}

export async function removeEssentiaModel(name) {
  const { removeModel } = await import("../ml/essentia.js");
  await removeModel(name);
  await db.setSetting("essentiaModels", (await essentiaModels()).filter((m) => m.name !== name));
}

/** Stores model predictions; the voice prediction only fills an unknown / non-user state. */
async function storeMl(r, res) {
  r.ml = res;
  if (res.voice != null && r.vocals?.source !== "user") {
    r.vocals = { state: res.voice >= 0.5 ? "vocal" : "instrumental", source: "essentia", at: Date.now() };
    if (r.vocals.state === "instrumental" && r.lyrics) r.lyrics = null;
  }
  r.finalScore = computeFinalFor(r);
  r.updatedAt = Date.now();
  genreCache.key = "";
  await save(r);
}

/** Essentia on a track whose file is in this session. */
export async function runEssentia(id) {
  const r = state.records.get(id);
  const file = state.files.get(id);
  if (!r || !file) throw new Error("Fichier non disponible dans cette session : réimporte-le.");
  const models = await essentiaModels();
  if (!models.length) throw new Error("Importe d'abord des modèles Essentia (Paramètres).");
  const { analyzeWithModels } = await import("../ml/essentia.js");
  const { decodeToMono } = await import("../audio/decoder.js");
  const dec = await decodeToMono(await file.arrayBuffer());
  await storeMl(r, await analyzeWithModels(dec.mono, dec.sampleRate, models));
}

/** Essentia on audio already in memory (live captures). */
export async function runEssentiaOnPcm(id, mono, sampleRate) {
  const r = state.records.get(id);
  const models = await essentiaModels();
  if (!r || !models.length) return;
  const { analyzeWithModels } = await import("../ml/essentia.js");
  await storeMl(r, await analyzeWithModels(mono, sampleRate, models));
}

const essentiaQueue = [];
let essentiaBusy = false;
/** Background runs after an analysis, when enabled. */
export async function queueEssentia(id) {
  if (!(await essentiaAuto()) || !(await essentiaModels()).length) return;
  essentiaQueue.push(id);
  if (essentiaBusy) return;
  essentiaBusy = true;
  try {
    while (essentiaQueue.length) {
      const next = essentiaQueue.shift();
      try { await runEssentia(next); } catch (err) { console.warn("Essentia", err); }
    }
  } finally {
    essentiaBusy = false;
  }
}

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
    const g = r.genre?.label;
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
  const key = [...state.records.values()].map((r) => `${r.id}:${r.genre?.label ?? ""}:${r.featureVersion}:${Math.round(r.finalScore ?? -1)}`).join("|");
  if (key === genreCache.key) return genreCache.map;
  const fps = libraryFingerprints();
  const vecs = new Map();
  for (const r of state.records.values()) {
    const v = genreVector(r, fps.get(r.id));
    if (v) vecs.set(r.id, v);
  }
  const labelled = [...state.records.values()].filter((r) => r.genre?.source === "user" && vecs.has(r.id)).map((r) => ({ id: r.id, label: r.genre.label, vec: vecs.get(r.id) }));
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
 * Genre of a record: { label, source: "user" | "essentia" | "voisins", confidence, suggestions, ml }.
 * Only the user's label is certain; the others are shown as suggestions.
 */
export function genreInfo(r) {
  const suggestions = genreSuggestions().get(r.id) ?? [];
  const ml = r.ml?.genres ?? [];
  if (r.genre?.label) return { label: r.genre.label, source: "user", confidence: 1, suggestions, ml };
  if (ml[0] && ml[0].p >= 0.5) return { label: ml[0].label, source: "essentia", confidence: ml[0].p, suggestions, ml };
  if (suggestions[0] && suggestions[0].confidence >= 0.45) return { label: suggestions[0].label, source: "voisins", confidence: suggestions[0].confidence, suggestions, ml };
  return { label: null, source: null, confidence: 0, suggestions, ml };
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
  for (const r of state.records.values()) if (rescore(r, scoring(), "pondérations")) changed.push(r);
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
  for (const r of state.records.values()) if (rescore(r, scoring(), "agrégation")) changed.push(r);
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
  if (samples.length < 3) return { error: "Il faut au moins 3 morceaux corrigés.", n: samples.length };
  return fitWeights(samples, state.weights);
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
export function progressionItem(r) {
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

export function buildProgression(tolerance) {
  const items = [...state.records.values()].map(progressionItem).filter(Boolean);
  state.progression = { ...buildOrder(items, { tolerance }), tolerance, builtAt: Date.now() };
  notify();
  return state.progression;
}

/** Orders any subset of records (e.g. the files matched with a Spotify playlist). */
export function orderRecords(ids, tolerance = 6) {
  const items = ids.map((id) => progressionItem(state.records.get(id))).filter(Boolean);
  return buildOrder(items, { tolerance });
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
  if (track.demo) record.name = `Démo · ${track.name}`;
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
