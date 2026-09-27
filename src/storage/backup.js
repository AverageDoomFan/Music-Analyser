// JSON export / import of the local database (music-energy-database.json).

import { ALGORITHM_VERSION, FEATURE_VERSION, EXPORT_SCHEMA_VERSION } from "../config.js";

export function buildExport(records, settings) {
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
    throw new Error("Fichier JSON invalide.");
  }
  if (data?.app !== "music-energy-analyzer" || !Array.isArray(data.tracks)) {
    throw new Error("Ce fichier n'est pas une base Music Energy Analyzer.");
  }
  if (data.schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new Error("Export produit par une version plus récente de l'application.");
  }
  const tracks = data.tracks.filter((t) => t && typeof t.id === "string" && typeof t.name === "string");
  return { tracks, settings: data.settings ?? {} };
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
