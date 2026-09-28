import { computeBandFlux } from "./bands.js";

self.onmessage = (e) => {
  const { jobId, mono, sampleRate, params } = e.data;
  try {
    const data = computeBandFlux(mono, sampleRate, params, (p) => self.postMessage({ jobId, progress: p }));
    self.postMessage({ jobId, data }, [data.flux.buffer, data.level.buffer, data.rmsDb.buffer]);
  } catch (err) {
    self.postMessage({ jobId, error: String(err?.message ?? err) });
  }
};
self.postMessage({ ready: true });
