// Decoding + feature extraction with bounded concurrency. Feature extraction
// runs in module Web Workers; falls back to the main thread if they are not
// supported.

import { ANALYSIS } from "../config.js";
import { decodeToMono } from "./decoder.js";

function spawnWorker() {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(new URL("./features.worker.js", import.meta.url), { type: "module" });
    } catch (err) {
      return reject(err);
    }
    const timer = setTimeout(() => { w.terminate(); reject(new Error("worker timeout")); }, 5000);
    w.onmessage = (e) => {
      if (e.data?.ready) { clearTimeout(timer); resolve(w); }
    };
    w.onerror = (e) => { e.preventDefault?.(); clearTimeout(timer); w.terminate(); reject(new Error("worker error")); };
  });
}

class WorkerPool {
  constructor(size) {
    this.size = size;
    this.count = 0;
    this.idle = [];
    this.waiting = [];
    this.nextId = 1;
  }

  async acquire() {
    if (this.idle.length) return this.idle.pop();
    if (this.count < this.size) {
      this.count++;
      try {
        return await spawnWorker();
      } catch (err) {
        this.count--;
        throw err;
      }
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(w) {
    const next = this.waiting.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  async run(mono, sampleRate, extra, onProgress) {
    const worker = await this.acquire();
    const jobId = this.nextId++;
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.jobId !== jobId) return;
        if (e.data.progress != null) return onProgress(e.data.progress);
        this.release(worker);
        if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.features);
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        worker.terminate();
        this.count--;
        reject(new Error("Échec de l'analyse (worker)."));
      };
      worker.postMessage({ jobId, mono, sampleRate, extra }, [mono.buffer]);
    });
  }
}

let pool = null;
let workersReady = null; // Promise<boolean>
let active = 0;
const queue = [];

async function withSlot(fn) {
  while (active >= ANALYSIS.concurrency) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

function ensureWorkers() {
  workersReady ??= (async () => {
    if (typeof Worker === "undefined") return false;
    pool = new WorkerPool(ANALYSIS.concurrency);
    try {
      pool.release(await pool.acquire());
      return true;
    } catch {
      return false;
    }
  })();
  return workersReady;
}

/**
 * @param {ArrayBuffer} arrayBuffer encoded audio (will be detached)
 * @param {(stage:"decode"|"features", progress:number)=>void} onProgress
 */
export function analyzeAudio(arrayBuffer, onProgress = () => {}) {
  return withSlot(async () => {
    onProgress("decode", 0);
    return extract(await decodeToMono(arrayBuffer), onProgress);
  });
}

async function extract(decoded, onProgress) {
  onProgress("features", 0);
  const report = (p) => onProgress("features", p);
  if (await ensureWorkers()) return pool.run(decoded.mono, decoded.sampleRate, decoded.clipping, report);
  const { extractFeatures } = await import("./features.js");
  await new Promise((r) => setTimeout(r, 0));
  return extractFeatures(decoded.mono, decoded.sampleRate, decoded.clipping, report);
}

/** Feature extraction of PCM already in memory (live captures). `mono` is transferred. */
export function analyzePcm(mono, sampleRate, extra = {}, onProgress = () => {}) {
  return withSlot(() => extract({ mono, sampleRate, clipping: extra }, onProgress));
}
