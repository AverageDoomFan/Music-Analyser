// Application state + change notification (batched on animation frames).

import { DEFAULT_WEIGHTS } from "../config.js";

export const state = {
  records: new Map(),          // id -> track record (persisted)
  weights: { ...DEFAULT_WEIGHTS },
  files: new Map(),            // id -> File, for this session only (playback, re-analysis)
  jobs: new Map(),             // jobKey -> { key, id?, name, size, stage, progress, error? }
  queue: { total: 0, done: 0, cached: 0, errors: 0 },
  progression: null,
  ui: { search: "", status: "all", stage: "all", sort: "score-asc", tab: "library" },
};

const listeners = new Set();
let scheduled = false;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const fn of listeners) fn(state);
  });
}
