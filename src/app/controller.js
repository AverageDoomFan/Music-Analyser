// Use cases: import, cache lookup, analysis, rescoring, corrections, backup.
// UI modules call these functions and re-render from the store.

import { AUDIO_EXTENSIONS, DEFAULT_WEIGHTS, FEATURE_VERSION, AGGREGATIONS, DEFAULT_AGGREGATION } from "../config.js";
import { state, notify } from "./store.js";
import { db } from "../storage/db.js";
import { buildExport, downloadJson, parseExport, mergeRecord } from "../storage/backup.js";
import { LocalFileSource } from "../audio/sources.js";
import { analyzeAudio } from "../audio/analyzer.js";
import {
  createRecord, applyFeatures, rescore, commitCorrection, clearCorrection, setManualScore,
} from "../core/track.js";
import { fitWeights } from "../scoring/learning.js";
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
      await db.putTrack(existing);
      state.queue.cached++;
      return;
    }

    record = existing ?? createRecord({ ...meta, id: identity.id, hashAlgorithm: identity.algorithm, source: sourceDesc });
    record.source = sourceDesc;
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
  enqueue(new LocalFileSource(file), { force: true });
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

export function buildProgression(tolerance) {
  const items = [...state.records.values()]
    .filter((r) => r.finalScore != null && r.auto)
    .map((r) => {
      // a correction shifts the whole curve: apply the same offset to its start / end
      const offset = r.finalScore - r.auto.score;
      const stats = r.auto.stats ?? {};
      return {
        id: r.id, name: r.name, duration: r.duration, score: r.finalScore,
        start: (stats.start ?? r.auto.score) + offset,
        end: (stats.end ?? r.auto.score) + offset,
        subscores: { ...r.auto.subscores, ...(r.correction?.overrides ?? {}) },
      };
    });
  state.progression = { ...buildOrder(items, { tolerance }), tolerance, builtAt: Date.now() };
  notify();
  return state.progression;
}
