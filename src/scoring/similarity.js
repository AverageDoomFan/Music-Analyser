// Timbre similarity between tracks (MFCC fingerprint + spectral balance),
// standardised over the library, and k-means groups. Pure functions.

const WEIGHTS = { mfccMean: 1, mfccStd: 0.6, balance: 0.8 };

/** Raw fingerprint of a record, or null (older analyses have no MFCC). */
export function fingerprint(r) {
  const f = r?.features;
  if (!f?.mfccMean) return null;
  const be = f.bandEnergy ?? {};
  return [
    ...f.mfccMean.map((v) => v * WEIGHTS.mfccMean),
    ...f.mfccStd.map((v) => v * WEIGHTS.mfccStd),
    ...[be.sub, be.bass, be.lowMid, be.highMid, be.high].map((v) => Math.log10((v ?? 0) + 1e-4) * WEIGHTS.balance),
    Math.log10(Math.max(100, f.centroidMean ?? 1000)) * WEIGHTS.balance,
  ];
}

/** z-scored fingerprints of every record that has one: Map id → vector. */
export function fingerprints(records) {
  const raw = records.map((r) => [r.id, fingerprint(r)]).filter(([, v]) => v);
  if (!raw.length) return new Map();
  const dim = raw[0][1].length;
  const mu = new Array(dim).fill(0), sd = new Array(dim).fill(0);
  for (const [, v] of raw) v.forEach((x, i) => { mu[i] += x / raw.length; });
  for (const [, v] of raw) v.forEach((x, i) => { sd[i] += (x - mu[i]) ** 2 / raw.length; });
  return new Map(raw.map(([id, v]) => [id, v.map((x, i) => (sd[i] > 1e-9 ? (x - mu[i]) / Math.sqrt(sd[i]) : 0))]));
}

export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

/** 0..1 similarity (1 = identical fingerprint). */
export const similarity = (a, b) => Math.exp(-(distance(a, b) ** 2) / 1.2);

export function similarTo(id, fps, k = 5) {
  const me = fps.get(id);
  if (!me) return [];
  return [...fps.entries()].filter(([o]) => o !== id)
    .map(([o, v]) => ({ id: o, similarity: similarity(me, v) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

/** k-means (k-means++ seeding, deterministic) → Map id → group index. */
export function groups(fps, k) {
  const ids = [...fps.keys()];
  const X = ids.map((id) => fps.get(id));
  if (!X.length) return new Map();
  k = Math.max(1, Math.min(k, X.length));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const C = [X[Math.floor(rnd() * X.length)].slice()];
  while (C.length < k) {
    const d = X.map((x) => Math.min(...C.map((c) => distance(x, c) ** 2)));
    const tot = d.reduce((a, b) => a + b, 0);
    let r = rnd() * tot, i = 0;
    while (i < d.length - 1 && r > d[i]) r -= d[i++];
    C.push(X[i].slice());
  }
  let assign = new Array(X.length).fill(0);
  for (let it = 0; it < 30; it++) {
    const next = X.map((x) => C.reduce((best, c, j) => (distance(x, c) < distance(x, C[best]) ? j : best), 0));
    const changed = next.some((a, i) => a !== assign[i]);
    assign = next;
    for (let j = 0; j < k; j++) {
      const mem = X.filter((_, i) => assign[i] === j);
      if (mem.length) C[j] = C[j].map((_, d) => mem.reduce((a, m) => a + m[d], 0) / mem.length);
    }
    if (!changed) break;
  }
  return new Map(ids.map((id, i) => [id, assign[i]]));
}
