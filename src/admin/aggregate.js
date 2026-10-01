// Admin panel data: normalises what comes from Firestore or from exported
// JSON files into one dataset, then computes the views. Pure functions.

const TIE_GAP = 3; // a score gap under this reads as "equal" for the model

const toMillis = (v) => (v == null ? null : typeof v === "number" ? v : typeof v.toMillis === "function" ? v.toMillis() : Date.parse(v) || null);

/** What the model said for a duel, from the scores stored with the answer. */
export function modelVerdict(scores) {
  if (!Array.isArray(scores) || scores.length !== 2 || scores.some((x) => !Number.isFinite(x))) return null;
  const [a, b] = scores;
  return Math.abs(a - b) < TIE_GAP ? "tie" : a > b ? "a" : "b";
}

const empty = () => ({ users: [], duels: [], reports: [] });

/** Firestore snapshots (plain objects with their ids) → dataset. */
export function fromCloud({ users = [], duels = [], reports = [] }) {
  return {
    users: users.map((u) => ({
      id: u.id, name: u.name || "", email: u.email || "", lastSync: toMillis(u.lastSync),
      counts: u.counts ?? {}, app: u.app ?? {}, library: u.library ?? {}, source: "cloud",
    })),
    duels: duels.map((d) => ({ ...d, user: d.user, at: toMillis(d.at) })),
    reports: reports.map((r) => ({
      user: r.user, id: r.trackId, name: r.name, at: r.at, expected: r.expected ?? null, finalScore: r.finalScore ?? null,
      comment: r.comment ?? "", algorithm: r.algorithm ?? null, extractor: r.extractor ?? null, data: r.data ?? null,
    })),
  };
}

/**
 * An exported file → dataset. Accepts the database export (schema ≥ 2, with
 * duels and reports), the diagnostic export and the reports export. The file
 * stands for one user, named after the file.
 */
export function fromFile(json, label) {
  const user = `file:${label}`;
  const ds = empty();
  if (json?.app === "music-energy-analyzer") {
    const names = new Map((json.tracks ?? []).map((t) => [t.id, t.name]));
    const scored = (json.tracks ?? []).filter((t) => t.finalScore != null);
    ds.users.push({
      id: user, name: label, email: "", lastSync: toMillis(json.exportedAt), source: "file",
      counts: { tracks: json.tracks?.length ?? 0, analysed: scored.length, duels: json.duels?.length ?? 0, reports: json.reports?.length ?? 0 },
      app: { algorithm: json.algorithmVersion, extractor: json.featureVersion },
      library: { averageScore: scored.length ? Math.round((scored.reduce((a, t) => a + t.finalScore, 0) / scored.length) * 10) / 10 : null },
    });
    ds.duels = (json.duels ?? []).map((d) => ({ ...d, user, aName: d.aName ?? names.get(d.a) ?? null, bName: d.bName ?? names.get(d.b) ?? null }));
    ds.reports = (json.reports ?? []).map((r) => reportFromLocal(r, user));
  } else if (json?.app === "mea-reports") {
    ds.users.push({ id: user, name: label, email: "", lastSync: toMillis(json.exportedAt), source: "file", counts: { reports: json.reports?.length ?? 0 }, app: {}, library: {} });
    ds.reports = (json.reports ?? []).map((r) => reportFromLocal(r, user));
  } else if (json?.app === "mea-diagnostic") {
    const tracks = json.tracks ?? [];
    ds.users.push({
      id: user, name: label, email: "", lastSync: toMillis(json.exportedAt), source: "file",
      counts: { tracks: tracks.length, analysed: tracks.length, duels: json.duels?.length ?? 0 }, app: { algorithm: json.algorithm, extractor: json.extractor }, library: {},
    });
    // diagnostic duels are [indexA, indexB, winner] with the current scores
    ds.duels = (json.duels ?? []).map(([ia, ib, winner]) => ({
      user, a: `#${ia}`, b: `#${ib}`, aName: tracks[ia]?.n ?? null, bName: tracks[ib]?.n ?? null, winner,
      at: null, source: "diagnostic", scores: [tracks[ia]?.s ?? null, tracks[ib]?.s ?? null], algorithm: json.algorithm,
    }));
  } else {
    throw new Error("Unknown file: not a database, diagnostic or reports export.");
  }
  return ds;
}

function reportFromLocal(r, user) {
  return {
    user, id: r.id, name: r.name, at: r.at, expected: r.expected ?? null, finalScore: r.finalScore ?? null,
    comment: r.comment ?? "", algorithm: r.algorithm ?? null, extractor: r.extractor ?? null, data: JSON.stringify(r),
  };
}

/** Several datasets → one (users by id, duels and reports without duplicates). */
export function mergeDatasets(list) {
  const out = empty();
  const users = new Map(), duels = new Map(), reports = new Map();
  for (const ds of list) {
    for (const u of ds.users) users.set(u.id, { ...users.get(u.id), ...u });
    for (const d of ds.duels) duels.set(`${d.user}|${d.a}|${d.b}|${d.at}|${d.winner}`, d);
    for (const r of ds.reports) {
      const k = `${r.user}|${r.id}`;
      if (!reports.has(k) || String(r.at) > String(reports.get(k).at)) reports.set(k, r);
    }
  }
  out.users = [...users.values()];
  out.duels = [...duels.values()].sort((x, y) => (y.at ?? 0) - (x.at ?? 0));
  out.reports = [...reports.values()].sort((x, y) => String(y.at).localeCompare(String(x.at)));
  return out;
}

/** Headline numbers, per algorithm version too. */
export function overview(ds) {
  const judged = ds.duels.map((d) => ({ d, m: modelVerdict(d.scores) })).filter((x) => x.m);
  const agree = judged.filter((x) => x.m === x.d.winner).length;
  const byAlgo = new Map();
  for (const { d, m } of judged) {
    const k = d.algorithm ?? "?";
    const e = byAlgo.get(k) ?? { algorithm: k, duels: 0, agree: 0 };
    e.duels++;
    if (m === d.winner) e.agree++;
    byAlgo.set(k, e);
  }
  const deltas = ds.reports.filter((r) => Number.isFinite(r.expected) && Number.isFinite(r.finalScore)).map((r) => r.expected - r.finalScore);
  return {
    users: ds.users.length,
    duels: ds.duels.length,
    reports: ds.reports.length,
    agreement: judged.length ? agree / judged.length : null,
    judged: judged.length,
    byAlgorithm: [...byAlgo.values()].map((e) => ({ ...e, rate: e.agree / e.duels })).sort((a, b) => String(b.algorithm).localeCompare(String(a.algorithm), undefined, { numeric: true })),
    meanReportDelta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
    meanAbsReportDelta: deltas.length ? deltas.reduce((a, b) => a + Math.abs(b), 0) / deltas.length : null,
  };
}

/** Per user: activity and how often the model agrees with them. */
export function userStats(ds) {
  return ds.users.map((u) => {
    const duels = ds.duels.filter((d) => d.user === u.id);
    const judged = duels.filter((d) => modelVerdict(d.scores));
    const agree = judged.filter((d) => modelVerdict(d.scores) === d.winner).length;
    return {
      ...u,
      duelCount: duels.length,
      reportCount: ds.reports.filter((r) => r.user === u.id).length,
      agreement: judged.length ? agree / judged.length : null,
      lastActivity: Math.max(u.lastSync ?? 0, ...duels.map((d) => d.at ?? 0)) || null,
    };
  }).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
}

/**
 * Tracks where people disagree with the model. Each duel answer that
 * contradicts the model pushes one track up and the other down; reports add
 * their expected − model gap. Sorted by how strongly people disagree.
 */
export function disputedTracks(ds) {
  const map = new Map();
  const entry = (id, name) => {
    if (!map.has(id)) map.set(id, { id, name: name ?? id, up: 0, down: 0, duels: 0, contradicted: 0, users: new Set(), reportDeltas: [], comments: [] });
    const e = map.get(id);
    if (name && e.name === id) e.name = name;
    return e;
  };
  for (const d of ds.duels) {
    const m = modelVerdict(d.scores);
    const A = entry(d.a, d.aName), B = entry(d.b, d.bName);
    A.duels++; B.duels++;
    A.users.add(d.user); B.users.add(d.user);
    if (!m || m === d.winner) continue;
    A.contradicted++; B.contradicted++;
    const rank = { a: 1, tie: 0, b: -1 };
    // positive: the user puts A higher (relative to B) than the model did
    const shift = rank[d.winner] - rank[m];
    if (shift > 0) { A.up++; B.down++; } else { A.down++; B.up++; }
  }
  for (const r of ds.reports) {
    const e = entry(r.id, r.name);
    e.users.add(r.user);
    if (Number.isFinite(r.expected) && Number.isFinite(r.finalScore)) e.reportDeltas.push(r.expected - r.finalScore);
    if (r.comment) e.comments.push(r.comment);
  }
  return [...map.values()]
    .map((e) => {
      const reportDelta = e.reportDeltas.length ? e.reportDeltas.reduce((a, b) => a + b, 0) / e.reportDeltas.length : null;
      const direction = e.up - e.down + (reportDelta == null ? 0 : Math.sign(reportDelta) * Math.min(3, Math.abs(reportDelta) / 10));
      return { ...e, users: e.users.size, reportDelta, direction, weight: e.up + e.down + e.reportDeltas.length * 2 };
    })
    .filter((e) => e.weight > 0)
    .sort((a, b) => Math.abs(b.direction) - Math.abs(a.direction) || b.weight - a.weight);
}
