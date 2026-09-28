// Personal genres: the user labels some tracks with their own taxonomy
// (hierarchical labels like "Électro › Hardstyle › Rawstyle"), the app
// suggests labels for the others from their nearest labelled neighbours.
// The user's label always wins; suggestions are only suggestions.

export const SEP = " › ";

/** "Électro/Hardstyle > Rawstyle" → ["Électro", "Hardstyle", "Rawstyle"]. */
export function genrePath(label) {
  return String(label ?? "").split(/\s*(?:›|>|\/)\s*/).map((s) => s.trim()).filter(Boolean);
}

export const normalizeGenre = (label) => genrePath(label).join(SEP);

/**
 * Description vector used for neighbours: timbre fingerprint (already
 * z-scored over the library) plus intensity, mood, tempo and mode.
 */
export function genreVector(r, fp) {
  if (!fp) return null;
  const m = r.auto?.music ?? {};
  const bpm = m.tempo?.bpm;
  return [
    ...fp,
    ((r.finalScore ?? 50) - 50) / 18 * 1.5,
    ((r.valence ?? 50) - 50) / 20,
    bpm ? Math.log2(bpm / 120) * 2 : 0,
    m.key ? (m.key.index < 12 ? 0.4 : -0.4) : 0,
  ];
}

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

/**
 * @param {number[]} vec  vector of the track to label
 * @param {{label:string, vec:number[]}[]} labelled
 * @returns {{label:string, confidence:number, neighbours:number}[]} best first
 *   (the deepest level of the hierarchy on which neighbours agree)
 */
export function suggestGenres(vec, labelled, k = 7) {
  if (!vec || !labelled.length) return [];
  const near = labelled.map((l) => ({ ...l, d: dist(vec, l.vec) })).sort((a, b) => a.d - b.d).slice(0, k);
  const w = near.map((n) => 1 / (0.15 + n.d));
  const total = w.reduce((a, b) => a + b, 0);
  // votes for every prefix of every label
  const votes = new Map();
  near.forEach((n, i) => {
    const path = genrePath(n.label);
    for (let lv = 1; lv <= path.length; lv++) {
      const key = path.slice(0, lv).join(SEP);
      votes.set(key, (votes.get(key) ?? 0) + w[i]);
    }
  });
  const cands = [...votes.entries()].map(([label, v]) => ({ label, confidence: v / total, depth: genrePath(label).length, neighbours: near.length }));
  // prefer the deepest label that still gathers a clear share of the votes
  cands.sort((a, b) => {
    const okA = a.confidence >= 0.55, okB = b.confidence >= 0.55;
    if (okA !== okB) return okA ? -1 : 1;
    if (okA && a.depth !== b.depth) return b.depth - a.depth;
    return b.confidence - a.confidence;
  });
  // closeness of the neighbours also bounds the confidence
  const closeness = Math.exp(-near[0].d / 1.5);
  return cands.slice(0, 4).map((c) => ({ label: c.label, confidence: Math.round(c.confidence * closeness * 100) / 100, neighbours: c.neighbours }));
}
