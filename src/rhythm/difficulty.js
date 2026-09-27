// Rhythm map statistics: keys per second and a difficulty estimate, as curves.
//
// Difficulty uses a "strain" model (in the spirit of rhythm games' star
// ratings): each note adds to a strain that decays exponentially with time,
// so sustained dense passages accumulate. Chords and lane jumps add a bit.
// It is a practical estimate for comparing passages and maps, not a
// replica of any specific game's rating.

const CHORD_WINDOW = 0.015;  // notes closer than this form a chord
const DECAY = 0.3;           // strain multiplier per second without notes
const STEP = 0.25;           // curve resolution (s)

/** Notes of the selected lanes, merged and sorted: [{t, lane}] */
export function mapNotes(lanes, selected) {
  const out = [];
  lanes.forEach((lane, l) => {
    if (selected && !selected[l]) return;
    for (const t of lane.notes) out.push({ t, lane: l });
  });
  return out.sort((a, b) => a.t - b.t);
}

/** Keys per second over a sliding 1 s window, sampled every STEP. */
export function kpsCurve(notes, duration, window = 1) {
  const times = [], values = [];
  let lo = 0, hi = 0;
  for (let t = 0; t <= duration + 1e-9; t += STEP) {
    while (hi < notes.length && notes[hi].t < t + window / 2) hi++;
    while (lo < notes.length && notes[lo].t < t - window / 2) lo++;
    times.push(round(t, 2));
    values.push((hi - lo) / window);
  }
  return { times, values };
}

/** Strain-based difficulty curve (≈ stars) and overall rating. */
export function difficultyCurve(notes, duration, laneCount = 1) {
  // strain right after each note
  const strains = new Float64Array(notes.length);
  let strain = 0, prevT = null, prevLane = null;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const dt = prevT == null ? 1 : n.t - prevT;
    let chord = 1;
    while (i + chord < notes.length && notes[i + chord].t - n.t < CHORD_WINDOW) chord++;
    // notes of a chord are handled together
    const jump = prevLane == null ? 0 : Math.abs(n.lane - prevLane) / Math.max(1, laneCount - 1);
    strain = strain * DECAY ** Math.max(dt, 0) + 1 + 0.45 * (chord - 1) + 0.35 * jump;
    for (let k = 0; k < chord; k++) strains[i + k] = strain;
    prevT = n.t;
    prevLane = notes[i + chord - 1].lane;
    i += chord - 1;
  }
  const stars = (s) => 0.9 * s ** 0.75;
  const times = [], values = [];
  let j = -1;
  for (let t = 0; t <= duration + 1e-9; t += STEP) {
    while (j + 1 < notes.length && notes[j + 1].t <= t) j++;
    const s = j >= 0 ? strains[j] * DECAY ** (t - notes[j].t) : 0;
    times.push(round(t, 2));
    values.push(round(stars(s), 2));
  }
  // overall: weighted sum of the strongest 0.5 s sections (0.9^k weights)
  const sections = [];
  for (let i = 0; i < values.length; i += 2) sections.push(Math.max(values[i], values[i + 1] ?? 0));
  sections.sort((a, b) => b - a);
  let overall = 0, weight = 1, norm = 0;
  for (const s of sections.slice(0, 60)) {
    overall += s * weight;
    norm += weight;
    weight *= 0.9;
  }
  return { times, values, overall: norm ? round(overall / norm, 2) : 0, peak: Math.max(0, ...values) };
}

/** Everything the rhythm view shows for a selection of lanes. */
export function mapStatistics(lanes, selected, duration) {
  const notes = mapNotes(lanes, selected);
  const kps = kpsCurve(notes, duration);
  const difficulty = difficultyCurve(notes, duration, lanes.filter((_, l) => !selected || selected[l]).length);
  const active = duration > 0 ? notes.length / duration : 0;
  return {
    notes: notes.length,
    kps,
    difficulty,
    meanKps: round(active, 2),
    maxKps: Math.max(0, ...kps.values),
  };
}

function round(x, d) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
