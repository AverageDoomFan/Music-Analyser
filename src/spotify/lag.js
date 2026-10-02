// How far Spotify's reported position runs ahead of the sound actually heard.
// The Web API's progress_ms is the client's playback position; the sound
// leaves the speakers later (the client's output buffer, the system mixer).
// The Live scan measures it on every excerpt: it plays from a known position,
// finds the first sound in the capture, and reads progress_ms meanwhile.
// The median of the last measures is kept in this browser; until there is
// one, an estimate is used.

export const DEFAULT_LAG = 0.3; // s
const KEY = "mea.spotify.lag";
const KEEP = 25;

/** Median of the measures (s), or null. */
export function medianLag(list) {
  const v = (list ?? []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** { value (s), measured: true when it comes from this browser's measures, n }. */
export function spotifyLag() {
  const list = read();
  const m = medianLag(list);
  return { value: m ?? DEFAULT_LAG, measured: m != null, n: list.length };
}

/** Adds one measure (s); absurd values (a stalled client, a seek meanwhile) are ignored. */
export function recordSpotifyLag(x) {
  if (!Number.isFinite(x) || x < -0.5 || x > 2) return;
  const list = [...read(), Math.round(x * 1000) / 1000].slice(-KEEP);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage blocked */ }
}
