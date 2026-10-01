// Firestore documents built from local data. Pure functions (tested in Node);
// the shapes match the validation in firestore.rules.

const MAX_REPORT_JSON = 900000; // Firestore documents are limited to 1 MiB

/** Short stable hash (FNV-1a, base 36). */
export function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Document id of a duel: the same answer always maps to the same document. */
export const duelId = (d) => `${d.at}_${shortHash(`${d.a}|${d.b}|${d.winner}`)}`;

/** Document id of a report: one per track (a newer report replaces the older). */
export const reportId = (r) => `${shortHash(r.id)}_${String(r.id).replace(/[^\w.-]+/g, "_").slice(-60)}`;

const cut = (v, max) => (v == null ? null : String(v).slice(0, max));

export function duelDoc(d, names = new Map()) {
  const doc = {
    a: cut(d.a, 200), b: cut(d.b, 200),
    aName: cut(names.get(d.a) ?? d.aName, 300), bName: cut(names.get(d.b) ?? d.bName, 300),
    winner: d.winner, at: Number(d.at) || 0,
    source: cut(d.source ?? "duels", 20), algorithm: cut(d.algorithm, 20),
  };
  if (Array.isArray(d.scores) && d.scores.length === 2) doc.scores = d.scores.map((x) => (Number.isFinite(x) ? x : null));
  return doc;
}

/** The full report travels as JSON text (Firestore refuses nested arrays and big maps). */
export function reportDoc(r) {
  let full = r;
  let data = JSON.stringify(full);
  if (data.length > MAX_REPORT_JSON && full.features?.timeline) {
    full = { ...full, features: { ...full.features, timeline: null }, trimmed: "timeline" };
    data = JSON.stringify(full);
  }
  if (data.length > MAX_REPORT_JSON) {
    full = { ...full, features: null, auto: { ...full.auto, curves: null }, trimmed: "features" };
    data = JSON.stringify(full);
  }
  return {
    trackId: cut(r.id, 200), name: cut(r.name ?? "?", 300), at: cut(r.at, 40),
    expected: Number.isFinite(r.expected) ? r.expected : null,
    finalScore: Number.isFinite(r.finalScore) ? Math.round(r.finalScore * 10) / 10 : null,
    comment: cut(r.comment ?? "", 2000), algorithm: cut(r.algorithm, 20), extractor: cut(r.extractor, 20),
    data,
  };
}

/** Profile: who, when, counters and a tiny library summary (no track list). */
export function userDoc({ user, records, duels, reports, app }, lastSync) {
  const scored = records.filter((r) => r.finalScore != null);
  const avg = scored.length ? Math.round((scored.reduce((a, r) => a + r.finalScore, 0) / scored.length) * 10) / 10 : null;
  return {
    name: cut(user.displayName ?? "", 120),
    email: cut(user.email ?? "", 200),
    lastSync,
    counts: { tracks: records.length, analysed: scored.length, duels, reports },
    app: { algorithm: app.algorithm, extractor: app.extractor, lang: app.lang },
    library: {
      averageScore: avg,
      captured: records.filter((r) => r.source?.kind === "spotify").length,
      files: records.filter((r) => !r.source?.kind || r.source.kind === "local").length,
      corrected: records.filter((r) => r.correction || r.manual).length,
    },
  };
}
