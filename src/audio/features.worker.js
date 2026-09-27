import { extractFeatures } from "./features.js";

self.onmessage = (e) => {
  const { jobId, mono, sampleRate, extra } = e.data;
  try {
    const features = extractFeatures(mono, sampleRate, extra, (p) => self.postMessage({ jobId, progress: p }));
    self.postMessage({ jobId, features });
  } catch (err) {
    self.postMessage({ jobId, error: String(err?.message ?? err) });
  }
};

self.postMessage({ ready: true });
