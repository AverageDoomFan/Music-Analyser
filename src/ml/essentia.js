// Optional Essentia.js models (MTG, Universitat Pompeu Fabra): genre, voice /
// instrumental, moods, danceability, from pre-trained MusiCNN classifiers.
// Everything runs in the browser; audio never leaves it.
//
// - essentia.js (AGPL-3.0) and TensorFlow.js are loaded from jsDelivr on demand
// - the models (CC BY-NC-ND 4.0, non-commercial use) are imported by the user
//   from a folder (TensorFlow.js format: model.json + weight shards, plus the
//   model's metadata .json when available), then kept in IndexedDB
// - predictions are suggestions: the user's own answers always win

const CDN = {
  tf: "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js",
  wasm: "https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.es.js",
  model: "https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-model.es.js",
};
const PREFIX = "indexeddb://mea-ess-";
const SR = 16000;

/** Default classes (order of the published models) when no metadata file is given. */
const DEFAULT_CLASSES = {
  genre_dortmund: ["alternative", "blues", "electronic", "folkcountry", "funksoulrnb", "jazz", "pop", "raphiphop", "rock"],
  genre_electronic: ["ambient", "dnb", "house", "techno", "trance"],
  genre_rosamerica: ["cla", "dan", "hip", "jaz", "pop", "rhy", "roc", "spe"],
  genre_tzanetakis: ["blu", "cla", "cou", "dis", "hip", "jaz", "met", "pop", "reg", "roc"],
  voice_instrumental: ["instrumental", "voice"],
  danceability: ["danceable", "not_danceable"],
  mood_happy: ["happy", "non_happy"],
  mood_sad: ["non_sad", "sad"],
  mood_aggressive: ["aggressive", "not_aggressive"],
  mood_relaxed: ["non_relaxed", "relaxed"],
  mood_party: ["non_party", "party"],
  mood_acoustic: ["acoustic", "non_acoustic"],
  mood_electronic: ["electronic", "non_electronic"],
};

/** Readable (and hierarchical where it helps) genre names. */
const GENRE_NAMES = {
  alternative: "Rock › Alternatif", blues: "Blues", electronic: "Électro", folkcountry: "Folk / country",
  funksoulrnb: "Funk / soul / R&B", jazz: "Jazz", pop: "Pop", raphiphop: "Rap / hip-hop", rock: "Rock",
  ambient: "Électro › Ambient", dnb: "Électro › Drum and bass", house: "Électro › House", techno: "Électro › Techno", trance: "Électro › Trance",
  cla: "Classique", dan: "Électro › Dance", hip: "Rap / hip-hop", jaz: "Jazz", rhy: "Funk / soul / R&B", roc: "Rock", spe: "Parlé",
  blu: "Blues", cou: "Folk / country", dis: "Disco", met: "Metal", reg: "Reggae",
};
const MOOD_NAMES = { happy: "joyeux", sad: "triste", aggressive: "agressif", relaxed: "détendu", party: "festif", acoustic: "acoustique", electronic: "électronique" };

export const LICENSE_NOTE = "Modèles Essentia (MTG-UPF) sous licence CC BY-NC-ND 4.0 (usage non commercial) ; essentia.js sous licence AGPL-3.0.";

let libs = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
    document.head.append(s);
  });
}

/** Loads TensorFlow.js and essentia.js (once). */
export async function loadLibraries() {
  libs ??= (async () => {
    await loadScript(CDN.tf);
    const tf = window.tf;
    if (!tf) throw new Error("TensorFlow.js indisponible.");
    const [{ EssentiaWASM }, mdl] = await Promise.all([import(CDN.wasm), import(CDN.model)]);
    // the WASM module may need its runtime to finish initialising
    if (EssentiaWASM && !EssentiaWASM.EssentiaJS && typeof EssentiaWASM.then !== "function") {
      await new Promise((r) => { const t = setInterval(() => { if (EssentiaWASM.EssentiaJS) { clearInterval(t); r(); } }, 50); setTimeout(() => { clearInterval(t); r(); }, 8000); });
    }
    const extractor = new mdl.EssentiaTFInputExtractor(EssentiaWASM, "musicnn");
    return { tf, mdl, extractor };
  })().catch((err) => { libs = null; throw err; });
  return libs;
}

const kindOf = (name) => (/genre/.test(name) ? "genre" : /voice_instrumental/.test(name) ? "voice" : /danceab/.test(name) ? "dance" : /^mood_/.test(name) ? "mood" : "other");
const baseName = (name) => name.replace(/-musicnn.*$/i, "").replace(/-msd.*$/i, "").replace(/-tfjs.*$/i, "");

/**
 * Imports every model found in a picked folder (input webkitdirectory).
 * @param {FileList|File[]} files
 * @returns {Promise<{name, kind, classes}[]>} models stored
 */
export async function importModels(files) {
  const { tf } = await loadLibraries();
  const byDir = new Map();
  for (const f of files) {
    const path = f.webkitRelativePath || f.name;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  const stored = [];
  for (const [dir, list] of byDir) {
    const modelJson = list.find((f) => f.name === "model.json");
    if (!modelJson) continue;
    const weights = list.filter((f) => f.name.endsWith(".bin"));
    // metadata: another .json with "classes"
    let meta = null;
    for (const f of list.filter((x) => x.name.endsWith(".json") && x !== modelJson)) {
      try {
        const j = JSON.parse(await f.text());
        if (Array.isArray(j.classes)) { meta = j; break; }
      } catch { /* not metadata */ }
    }
    const rawName = meta?.name ? String(meta.name) : dir.split("/").pop() || modelJson.name;
    const name = baseName(rawName.toLowerCase().replace(/\s+/g, "_"));
    const classes = meta?.classes ?? DEFAULT_CLASSES[name] ?? null;
    const model = await tf.loadGraphModel(tf.io.browserFiles([modelJson, ...weights]));
    await model.save(`${PREFIX}${name}`);
    model.dispose?.();
    stored.push({ name, kind: kindOf(name), classes, classesFromMetadata: !!meta?.classes, savedAt: Date.now() });
  }
  return stored;
}

export async function removeModel(name) {
  const { tf } = await loadLibraries();
  try { await tf.io.removeModel(`${PREFIX}${name}`); } catch { /* already gone */ }
  loaded.delete(name);
}

const loaded = new Map();
async function modelFor(entry) {
  if (loaded.has(entry.name)) return loaded.get(entry.name);
  const { tf, mdl } = await loadLibraries();
  const m = new mdl.TensorflowMusiCNN(tf, `${PREFIX}${entry.name}`);
  await m.initialize();
  loaded.set(entry.name, m);
  return m;
}

/** Mono PCM (any rate) → 16 kHz, up to `maxSeconds` taken from the middle. */
export async function to16k(mono, sampleRate, maxSeconds = 60) {
  const len = Math.min(mono.length, Math.round(maxSeconds * sampleRate));
  const start = Math.max(0, Math.floor((mono.length - len) / 2));
  const slice = mono.subarray(start, start + len);
  const off = new OfflineAudioContext(1, Math.ceil((slice.length * SR) / sampleRate), SR);
  const buf = off.createBuffer(1, slice.length, sampleRate);
  buf.copyToChannel(slice, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

const mean = (rows) => {
  const n = rows.length, k = rows[0]?.length ?? 0;
  const out = new Array(k).fill(0);
  for (const r of rows) for (let i = 0; i < k; i++) out[i] += r[i] / n;
  return out;
};
const positive = (classes) => classes.findIndex((c) => !/^(non|not)_/.test(c));

/**
 * Runs every stored model on the audio.
 * @param {Float32Array} mono  PCM at `sampleRate`
 * @param {{name, kind, classes}[]} models
 * @returns {Promise<{genres:{label,p,model}[], voice:number|null, danceability:number|null, moods:Object, models:string[], at:number}>}
 */
export async function analyzeWithModels(mono, sampleRate, models) {
  if (!models.length) throw new Error("Aucun modèle Essentia importé (Paramètres).");
  const { extractor } = await loadLibraries();
  const audio = await to16k(mono, sampleRate);
  if (audio.length < SR * 3.5) throw new Error("Extrait trop court pour les modèles (3,5 s minimum).");
  const feature = extractor.computeFrameWise(audio, 256);
  const res = { genres: [], voice: null, danceability: null, moods: {}, models: [], at: Date.now() };
  for (const entry of models) {
    if (!entry.classes) continue;
    const m = await modelFor(entry);
    const pred = await m.predict(feature, true);
    const avg = mean(Array.isArray(pred[0]) ? pred : [pred]);
    res.models.push(entry.name);
    if (entry.kind === "genre") {
      entry.classes.forEach((c, i) => res.genres.push({ label: GENRE_NAMES[c] ?? c, p: round(avg[i]), model: entry.name }));
    } else if (entry.kind === "voice") {
      res.voice = round(avg[entry.classes.indexOf("voice")]);
    } else if (entry.kind === "dance") {
      res.danceability = round(avg[entry.classes.indexOf("danceable")]);
    } else if (entry.kind === "mood") {
      const i = positive(entry.classes);
      const key = entry.classes[i];
      res.moods[MOOD_NAMES[key] ?? key] = round(avg[i]);
    }
  }
  // same label from several models: keep the highest probability
  const best = new Map();
  for (const g of res.genres) if (!best.has(g.label) || best.get(g.label).p < g.p) best.set(g.label, g);
  res.genres = [...best.values()].sort((a, b) => b.p - a.p).slice(0, 8);
  return res;
}

function round(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null; }
