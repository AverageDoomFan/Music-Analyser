// Play orders of the Live scan: the order in which the playlist's tracks are
// played and analysed. Pure functions (tested in Node).

import { t } from "../i18n/index.js";

export const PLAY_ORDERS = [
  { key: "playlist", label: t("Playlist order") },
  { key: "reverse", label: t("Reverse playlist order") },
  { key: "random", label: t("Random") },
  { key: "title", label: t("Title A → Z") },
  { key: "artist", label: t("Artist A → Z") },
  { key: "album", label: t("Album A → Z") },
  { key: "shortest", label: t("Shortest first") },
  { key: "longest", label: t("Longest first") },
  { key: "added", label: t("Recently added first") },
  { key: "scoreAsc", label: t("Lowest score first") },
  { key: "scoreDesc", label: t("Highest score first") },
];

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const text = (a, b) => (a == null) - (b == null) || (a != null && collator.compare(a, b));

/** Deterministic shuffle (mulberry32), so a random order stays put until reshuffled. */
function shuffle(list, seed) {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * @param {object[]} tracks  Spotify tracks, in playlist order
 * @param {string} order     PLAY_ORDERS key
 * @param {{seed?: number, scoreOf?: (track) => number|null}} [o]
 *   scoreOf: known score of a track (score orders; unknown scores go last)
 * @returns {object[]} a new array; ties keep the playlist order
 */
export function orderTracks(tracks, order, { seed = 1, scoreOf = () => null } = {}) {
  const list = tracks.map((track, i) => ({ track, i }));
  const by = (cmp) => list.sort((a, b) => cmp(a.track, b.track) || a.i - b.i).map((x) => x.track);
  const num = (f, dir = 1) => (a, b) => {
    const x = f(a), y = f(b);
    return (x == null) - (y == null) || (x != null && (x - y) * dir);
  };
  switch (order) {
    case "reverse": return [...tracks].reverse();
    case "random": return shuffle(tracks, seed);
    case "title": return by((a, b) => text(a.name, b.name));
    case "artist": return by((a, b) => text(a.artists?.[0], b.artists?.[0]) || text(a.album, b.album) || text(a.name, b.name));
    case "album": return by((a, b) => text(a.album, b.album) || text(a.name, b.name));
    case "shortest": return by(num((x) => x.durationMs));
    case "longest": return by(num((x) => x.durationMs, -1));
    case "added": return by(num((x) => (x.addedAt ? Date.parse(x.addedAt) : null), -1));
    case "scoreAsc": return by(num(scoreOf));
    case "scoreDesc": return by(num(scoreOf, -1));
    default: return [...tracks];
  }
}

/**
 * Queue of a scan started with ▶ on one track: that track first, then the
 * tracks still to do (`todo`), in play order (`order`: every track, ordered)
 * but continuing from `resumeFrom`, the in-order track the previous scan had
 * reached (it comes back first when it was not finished), then wrapping round
 * to the ones before it. Tracks `skip(track)` says are already done are left out.
 */
export function queueAfter(first, todo, { order = todo, resumeFrom = null, skip = () => false } = {}) {
  const pos = new Map(order.map((x, i) => [x.id, i]));
  const rest = todo.filter((x) => x.id !== first.id && !skip(x));
  const at = resumeFrom == null ? -1 : pos.get(resumeFrom) ?? -1;
  if (at > 0) {
    const key = (x) => ((pos.get(x.id) ?? 0) - at + order.length) % order.length;
    rest.sort((a, b) => key(a) - key(b));
  }
  return [first, ...rest];
}
