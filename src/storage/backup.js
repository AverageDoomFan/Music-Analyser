// JSON export / import of the local database (music-energy-database.json).

import { ALGORITHM_VERSION, FEATURE_VERSION, EXPORT_SCHEMA_VERSION } from "../config.js";
import { t } from "../i18n/index.js";

/**
 * Full database export. `extras.duels` and `extras.reports` are the user's
 * judgements and reports for analysis: they are what a future algorithm is
 * tuned against, so they travel with the tracks (names added for reading).
 */
export function buildExport(records, settings, extras = {}) {
  const names = new Map(records.map((r) => [r.id, r.name]));
  return {
    app: "music-energy-analyzer",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    featureVersion: FEATURE_VERSION,
    exportedAt: new Date().toISOString(),
    settings,
    tracks: records.map((r) => {
      // `explain` is derived from features and recomputed on import
      const auto = r.auto ? { ...r.auto } : null;
      if (auto) delete auto.explain;
      return { ...r, auto };
    }),
    duels: (extras.duels ?? []).map((d) => ({ ...d, aName: names.get(d.a) ?? d.aName ?? null, bName: names.get(d.b) ?? d.bName ?? null })),
    reports: extras.reports ?? [],
  };
}

export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Parses and validates an export; throws a user-readable Error. */
export function parseExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(t("Invalid JSON file."));
  }
  if (data?.app !== "music-energy-analyzer" || !Array.isArray(data.tracks)) {
    throw new Error(t("This file is not a Music Energy Analyzer database."));
  }
  if (data.schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new Error(t("Export made by a newer version of the app."));
  }
  const tracks = data.tracks.filter((t) => t && typeof t.id === "string" && typeof t.name === "string");
  const duels = (Array.isArray(data.duels) ? data.duels : [])
    .filter((d) => d && typeof d.a === "string" && typeof d.b === "string" && ["a", "b", "tie"].includes(d.winner));
  const reports = (Array.isArray(data.reports) ? data.reports : []).filter((r) => r && typeof r.id === "string" && r.at);
  return { tracks, settings: data.settings ?? {}, duels, reports };
}

const duelKey = (d) => `${d.a}|${d.b}|${d.at ?? ""}|${d.winner}`;

/** Union of two duel lists (same pair, time and answer = same duel), oldest first. */
export function mergeDuels(existing, incoming) {
  const out = new Map();
  for (const d of [...existing, ...incoming]) if (!out.has(duelKey(d))) out.set(duelKey(d), d);
  return [...out.values()].sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
}

/** Union of two report lists: one report per track, the most recent wins, oldest first. */
export function mergeReports(existing, incoming) {
  const out = new Map();
  for (const r of [...existing, ...incoming]) {
    const cur = out.get(r.id);
    if (!cur || String(r.at) > String(cur.at)) out.set(r.id, r);
  }
  return [...out.values()].sort((x, y) => String(x.at).localeCompare(String(y.at)));
}

/**
 * Merges an imported record into an existing one without losing user work:
 * the most recently updated record wins, but corrections / manual scores
 * missing on the winner are taken from the other side.
 */
export function mergeRecord(existing, incoming) {
  if (!existing) return { ...incoming, auto: incoming.features ? null : incoming.auto };
  const newer = (incoming.updatedAt ?? 0) > (existing.updatedAt ?? 0) ? incoming : existing;
  const older = newer === incoming ? existing : incoming;
  const merged = { ...older, ...newer };
  merged.correction = newer.correction ?? older.correction ?? null;
  merged.manual = newer.manual ?? older.manual ?? null;
  merged.lyrics = newer.lyrics ?? older.lyrics ?? null;
  merged.vocals = newer.vocals ?? older.vocals ?? null;
  merged.genre = newer.genre ?? older.genre ?? null;
  merged.extGenres = newer.extGenres ?? older.extGenres ?? null;
  merged.features = newer.features ?? older.features ?? null;
  merged.featureVersion = newer.features ? newer.featureVersion : older.featureVersion;
  merged.initialAuto = existing.initialAuto ?? incoming.initialAuto ?? null;
  merged.history = [...(older.history ?? []), ...(newer.history ?? [])]
    .sort((a, b) => a.at - b.at)
    .filter((h, i, arr) => i === 0 || h.at !== arr[i - 1].at || h.kind !== arr[i - 1].kind)
    .slice(-30);
  if (merged.features) merged.auto = null; // recomputed with the local algorithm and weights
  return merged;
}
