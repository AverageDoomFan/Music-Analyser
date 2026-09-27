// Rhythm-map extraction for the current session: decodes the track once
// (shared with playback), runs the spectral pass in a worker and keeps the
// band data in memory so regrouping / re-detecting is instant.

import { engine } from "../audio/engine.js";
import { RHYTHM } from "../config.js";

let cached = null; // { id, key, data }
let jobSeq = 0;

const heavyKey = (p) => `${p.bandsPerOctave}|${p.fMin}|${p.fMax}`;

/** Band data for a track, recomputed only when a "heavy" parameter changed. */
export async function bandData(id, file, params, onProgress = () => {}) {
  const key = heavyKey(params);
  if (cached?.id === id && cached.key === key) return cached.data;
  onProgress("decode", 0);
  const buffer = await engine.load(id, file);
  if (buffer.duration > RHYTHM.maxDurationSeconds) throw new Error(`Morceau trop long (max ${RHYTHM.maxDurationSeconds / 60} min).`);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buffer.numberOfChannels;
  }
  onProgress("bands", 0);
  const data = await runWorker(mono, buffer.sampleRate, params, (p) => onProgress("bands", p));
  cached = { id, key, data };
  return data;
}

export const cachedBandData = (id, params) => (cached?.id === id && cached.key === heavyKey(params) ? cached.data : null);

function runWorker(mono, sampleRate, params, onProgress) {
  const heavy = { bandsPerOctave: params.bandsPerOctave, fMin: params.fMin, fMax: params.fMax };
  const onMainThread = async () => {
    const { computeBandFlux } = await import("./bands.js");
    await new Promise((r) => setTimeout(r, 0));
    return computeBandFlux(mono, sampleRate, heavy, onProgress);
  };
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./rhythm.worker.js", import.meta.url), { type: "module" });
    } catch {
      return onMainThread().then(resolve, reject);
    }
    const jobId = ++jobSeq;
    let started = false;
    worker.onmessage = (e) => {
      if (e.data.ready) {
        // the PCM is transferred only once the worker is known to work
        started = true;
        worker.postMessage({ jobId, mono, sampleRate, params: heavy }, [mono.buffer]);
        return;
      }
      if (e.data.jobId !== jobId) return;
      if (e.data.progress != null) return onProgress(e.data.progress);
      worker.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.data);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      worker.terminate();
      if (!started) onMainThread().then(resolve, reject);
      else reject(new Error("Échec de l'extraction (worker)."));
    };
  });
}
