// "Duel between friends": compares two diagnostic exports (app "mea-diagnostic",
// see exportDiagnostic in src/app/controller.js). Pure logic, no DOM.
//
// A diagnostic track: { n: name, sid?: Spotify id, src: "local" | "spotify:<mode>:<coverage %>" | "test:…",
//   s: final score, a: automatic score, u: user's adjustments, sub: sub-scores, f: compact features,
//   g: genre, k: key, d?: 1 for a draft, F/X/cv: full data (dropped here) }

import { t } from "../i18n/index.js";

/** Measured features shown side by side, with the gap that starts to matter (`spread`). */
export const DUEL_FEATURES = [
  { key: "plr", label: "Loudness (PLR)", unit: "dB", spread: 2.5, digits: 1, hint: "Peak to loudness ratio: low = crushed, loud master." },
  { key: "src", label: "Source loudness", unit: "LUFS", spread: 3, digits: 1, hint: "Loudness of the captured or decoded audio, before normalisation." },
  { key: "cr", label: "Crest", unit: "dB", spread: 2.5, digits: 1, hint: "Peaks above the average level: low = compressed." },
  { key: "cen", label: "Brightness (centroid)", unit: "Hz", spread: 350, digits: 0, hint: "Spectral centre of gravity." },
  { key: "bass", label: "Bass ratio", unit: "", spread: 0.06, digits: 2, hint: "Share of the energy in the low end." },
  { key: "flat", label: "Flatness", unit: "dB", spread: 2.5, digits: 1, hint: "Noise-like spectrum (high = noisy, distorted)." },
  { key: "bpm", label: "BPM", unit: "", spread: 6, digits: 0, hint: "Detected tempo." },
  { key: "on", label: "Attack rate", unit: "/s", spread: 0.8, digits: 1, hint: "Onsets per second." },
  { key: "xr", label: "Fast pulse rate", unit: "Hz", spread: 1.5, digits: 1, hint: "Very fast kicks (speedcore, extratone)." },
];

/** Accents, case, track numbers, extensions and "feat." / "remastered" mentions removed. */
export function normalizeName(name) {
  let s = String(name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  s = s.replace(/\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|webm)$/, "");
  s = s.replace(/^\s*\d{1,3}\s*[-._)]\s*/, "");
  s = s.replace(/[([][^)\]]*\b(feat|ft|featuring|with|remaster(ed)?|radio edit|explicit|official|clip|audio|lyrics?)\b[^)\]]*[)\]]/g, " ");
  s = s.replace(/\s-\s(\d{4}\s)?remaster(ed)?(\s\d{4})?.*$/, "");
  const cut = s.indexOf(" - ");
  const clean = (x) => x.replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (cut < 0) return clean(s);
  const artist = s.slice(0, cut).split(/,|&|\bfeat\.?\b|\bft\.?\b| x | and /)[0];
  const title = s.slice(cut + 3).replace(/\b(feat|ft)\.?\s.*$/, "");
  return `${clean(artist)} - ${clean(title)}`;
}

/** Reads "spotify:follow:62" → { kind, mode, coverage (0..1) }. */
export function parseSrc(src) {
  const [kind = "local", mode = null, pct] = String(src ?? "local").split(":");
  const coverage = pct != null && Number.isFinite(Number(pct)) ? Number(pct) / 100 : kind === "local" ? 1 : null;
  return { kind, mode, coverage };
}

/** One diagnostic track in the duel's shape (null when unusable). */
export function duelTrack(x) {
  if (!x || typeof x.n !== "string" || !Number.isFinite(x.s)) return null;
  const src = parseSrc(x.src);
  return {
    name: x.n,
    sid: typeof x.sid === "string" && x.sid ? x.sid : null,
    nameKey: normalizeName(x.n),
    score: x.s,
    auto: Number.isFinite(x.a) ? x.a : x.s,
    sub: x.sub ?? {},
    f: x.f ?? {},
    genre: x.g ?? null,
    key: x.k ?? null,
    user: x.u ?? {},
    src,
    test: src.kind === "test",
    draft: !!x.d,
  };
}

/**
 * Validates a diagnostic export (text or parsed object) and returns
 * { algorithm, extractor, aggregation, exportedAt, tracks } (tracks in the duel's
 * shape; test-bench tracks and drafts left out). Throws a readable Error.
 */
export function parseDiagnostic(input) {
  let data = input;
  if (typeof input === "string") {
    try { data = JSON.parse(input); } catch { throw new Error(t("This file is not valid JSON.")); }
  }
  if (data?.app !== "mea-diagnostic" || !Array.isArray(data.tracks)) {
    throw new Error(t("This file is not a Music Energy Analyzer profile (diagnostic export)."));
  }
  const tracks = data.tracks.map(duelTrack).filter((x) => x && !x.test && !x.draft);
  return {
    algorithm: data.algorithm ?? null, extractor: data.extractor ?? null, aggregation: data.aggregation ?? null,
    exportedAt: data.exportedAt ?? null, tracks,
  };
}

/** A stored profile: the compact fields only (full curves dropped). */
export function compactProfile(p) {
  return {
    algorithm: p.algorithm, extractor: p.extractor, aggregation: p.aggregation, exportedAt: p.exportedAt,
    tracks: p.tracks.map((x) => ({ ...x })),
  };
}

/**
 * Pairs the tracks of two libraries: by Spotify id when both have one, else by
 * normalised "artist - title". Returns { pairs: [{ a, b, by }], onlyA, onlyB }.
 */
export function matchTracks(A, B) {
  const bySid = new Map(), byName = new Map();
  for (const b of B) {
    if (b.sid && !bySid.has(b.sid)) bySid.set(b.sid, b);
    if (b.nameKey) byName.set(b.nameKey, [...(byName.get(b.nameKey) ?? []), b]);
  }
  const used = new Set();
  const pairs = [];
  const seenA = new Set();
  const onlyA = [];
  for (const a of A) {
    const id = a.sid ? `s:${a.sid}` : `n:${a.nameKey}`;
    if (seenA.has(id)) continue;
    seenA.add(id);
    let b = a.sid ? bySid.get(a.sid) : null;
    let by = "spotify";
    if (!b || used.has(b)) {
      // same name: prefer a track without a Spotify id (else it would have matched by id)
      const cands = (byName.get(a.nameKey) ?? []).filter((x) => !used.has(x));
      b = cands.find((x) => !x.sid || !a.sid) ?? cands[0] ?? null;
      by = "name";
    }
    if (b && !used.has(b) && a.nameKey) {
      used.add(b);
      pairs.push({ a, b, by });
    } else onlyA.push(a);
  }
  const onlyB = B.filter((b) => !used.has(b));
  return { pairs, onlyA, onlyB };
}

/** Pearson correlation (null below 3 pairs or without variance). */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Library-wide numbers of one side: { count, avg, median, over100 (share) }. */
export function sideStats(tracks) {
  const s = tracks.map((x) => x.score).sort((a, b) => a - b);
  const n = s.length;
  return {
    count: n,
    avg: n ? s.reduce((a, b) => a + b, 0) / n : null,
    median: n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null,
    over100: n ? s.filter((x) => x > 100).length / n : 0,
  };
}

/**
 * Differences on one common track, for "why don't we get the same score?":
 *   subs [{ key, a, b, diff }] and features [{ key, a, b, diff, z }] sorted by
 *   importance (z = |diff| / spread), with `big` on the ones that matter,
 *   causes [code…] from the capture and the user's adjustments.
 */
export function pairDetails(pair, { sameAlgorithm = true } = {}) {
  const { a, b } = pair;
  const keys = [...new Set([...Object.keys(a.sub), ...Object.keys(b.sub)])];
  const subs = keys.map((key) => {
    const x = a.sub[key], y = b.sub[key];
    return { key, a: x ?? null, b: y ?? null, diff: Number.isFinite(x) && Number.isFinite(y) ? y - x : null };
  });
  const subRank = subs.filter((s) => s.diff != null).sort((p, q) => Math.abs(q.diff) - Math.abs(p.diff));
  subRank.slice(0, 3).forEach((s) => { if (Math.abs(s.diff) >= 8) s.big = true; });
  const features = DUEL_FEATURES.map((d) => {
    const x = a.f[d.key], y = b.f[d.key];
    const ok = Number.isFinite(x) && Number.isFinite(y);
    return { key: d.key, a: Number.isFinite(x) ? x : null, b: Number.isFinite(y) ? y : null, diff: ok ? y - x : null, z: ok ? Math.abs(y - x) / d.spread : null };
  });
  features.filter((f) => f.z != null).sort((p, q) => q.z - p.z).slice(0, 3).forEach((f) => { if (f.z >= 1) f.big = true; });
  const causes = [];
  if (a.user?.m != null || b.user?.m != null) causes.push("manual");
  if (a.user?.c != null || b.user?.c != null) causes.push("correction");
  if (a.user?.ly || b.user?.ly) causes.push("lyrics");
  if ((a.src.coverage ?? 1) < 0.6 || (b.src.coverage ?? 1) < 0.6) causes.push("partial");
  if (a.src.kind !== b.src.kind) causes.push("source");
  if (!sameAlgorithm) causes.push("algorithm");
  const autoGap = b.auto - a.auto, gap = b.score - a.score;
  if (Math.abs(gap - autoGap) >= 4) causes.push("adjusted");
  return { subs, features, causes, gap, autoGap };
}

/**
 * The duel: A = me, B = the friend (profiles from parseDiagnostic).
 *   common [{ key, name, a, b, gap (b − a), by, pair }] sorted by |gap| desc,
 *   n, r (correlation), meanAbsGap, meanGap, onlyA, onlyB,
 *   sides { a, b } (sideStats of each whole library, common { a, b } on the common tracks),
 *   harder: "a" | "b" | "tie", agreement: "same" | "close" | "different" | "apart" | null
 */
export function duelStats(A, B) {
  const { pairs, onlyA, onlyB } = matchTracks(A.tracks, B.tracks);
  const common = pairs
    .map((p) => ({
      key: `${p.a.sid ?? p.a.nameKey}|${p.b.sid ?? p.b.nameKey}`,
      name: p.a.name, a: p.a.score, b: p.b.score, gap: p.b.score - p.a.score, by: p.by, pair: p,
    }))
    .sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap) || x.name.localeCompare(y.name));
  const xs = common.map((c) => c.a), ys = common.map((c) => c.b);
  const n = common.length;
  const meanAbsGap = n ? common.reduce((s, c) => s + Math.abs(c.gap), 0) / n : null;
  const meanGap = n ? common.reduce((s, c) => s + c.gap, 0) / n : null;
  const sides = { a: sideStats(A.tracks), b: sideStats(B.tracks) };
  const common2 = { a: sideStats(pairs.map((p) => p.a)), b: sideStats(pairs.map((p) => p.b)) };
  const diff = (sides.b.avg ?? 0) - (sides.a.avg ?? 0);
  const harder = sides.a.avg == null || sides.b.avg == null ? null : Math.abs(diff) < 2 ? "tie" : diff > 0 ? "b" : "a";
  const agreement = meanAbsGap == null ? null : meanAbsGap < 4 ? "same" : meanAbsGap < 9 ? "close" : meanAbsGap < 16 ? "different" : "apart";
  return {
    common, n, r: pearson(xs, ys), meanAbsGap, meanGap,
    onlyA: [...onlyA].sort((x, y) => y.score - x.score),
    onlyB: [...onlyB].sort((x, y) => y.score - x.score),
    sides, commonSides: common2, harder, agreement,
    sameAlgorithm: !A.algorithm || !B.algorithm || A.algorithm === B.algorithm,
  };
}
