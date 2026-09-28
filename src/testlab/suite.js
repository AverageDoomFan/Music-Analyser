// Test suite: which tracks to generate and what the analysis should find.
// Each variable has min / mid / max tracks (only that parameter moves), and
// a few "sweep" tracks where one parameter changes over time.

import { renderTrack, renderSong } from "./synth.js";
import { DIMENSIONS } from "../config.js";

const LEVELS = ["min", "moyen", "max"];

/** Measures read from a scored record (features + auto). */
export const MEASURES = {
  score: { label: "Intensité", get: (r) => r.finalScore ?? r.auto?.score },
  bpm: { label: "BPM", get: (r) => r.auto?.music?.tempo?.bpm ?? r.features?.bpm ?? null, fmt: (v) => `${Math.round(v)}` },
  key: { label: "Tonalité", get: (r) => r.auto?.music?.key?.name ?? null, fmt: (v) => v },
  valence: { label: "Ambiance", get: (r) => r.valence ?? r.auto?.music?.mood?.valence },
  loudnessRange: { label: "Plage dynamique (LU)", get: (r) => r.features?.loudnessRange, fmt: (v) => v.toFixed(1) },
  centroid: { label: "Centroïde (Hz)", get: (r) => r.features?.centroidMean, fmt: (v) => `${Math.round(v)}` },
};
for (const d of DIMENSIONS) {
  MEASURES[`sub:${d.key}`] = { label: `Sous-score ${d.label}`, get: (r) => r.auto?.subscores?.[d.key] };
}

/**
 * Variables tested at three levels.
 * measure: MEASURES key; expect: "increasing" (min < moyen < max by at least
 * `margin`) or per-level { near, tol } / { equals }.
 */
export const VARIABLES = [
  { key: "tempo", label: "Tempo", measure: "bpm", also: "sub:tempo", hint: "60, 120 et 175 BPM, même son.",
    levels: [{ bpm: 60 }, { bpm: 120 }, { bpm: 175 }], expect: [{ near: 60, tol: 0.06, octave: true }, { near: 120, tol: 0.06, octave: true }, { near: 175, tol: 0.06, octave: true }] },
  { key: "brightness", label: "Brillance", measure: "sub:brightness", also: "centroid", hint: "Son étouffé (filtre à 600 Hz), normal, très aigu (harmoniques riches, hi-hats forts).",
    levels: [{ cutoff: 600, bright: 0.2, hats: 0.03 }, {}, { bright: 0.85, hats: 0.35, hatDiv: 4 }], expect: "increasing", margin: 8 },
  { key: "pressure", label: "Pression", measure: "sub:pressure", hint: "Sans kick ni basse, kick propre, kick saturé et sub long.",
    levels: [{ kick: 0, sub: 0, bass: 0 }, {}, { kick: 1, kickDrive: 10, sub: 0.8, bass: 0.45 }], expect: "increasing", margin: 8 },
  { key: "harshness", label: "Dureté", measure: "sub:harshness", hint: "Mix propre, légèrement saturé, très saturé et écrêté.",
    levels: [{}, { drive: 4 }, { drive: 25, clip: 0.3, hats: 0.3 }], expect: "increasing", margin: 6 },
  { key: "noise", label: "Bruit", measure: "sub:noise", hint: "Aucun bruit, souffle léger, mur de bruit blanc.",
    levels: [{}, { noise: 0.08 }, { noise: 0.9, drive: 6 }], expect: "increasing", margin: 6 },
  { key: "density", label: "Densité", measure: "sub:density", hint: "Un accord et un kick, groove normal, toutes les couches + hi-hats en doubles croches.",
    levels: [{ snare: 0, hats: 0, bass: 0, chords: 0.3 }, {}, { arp: 0.2, lead: 0.12, hats: 0.2, hatDiv: 4, bass: 0.35 }], expect: "increasing", margin: 6 },
  { key: "complexity", label: "Complexité", measure: "sub:complexity", hint: "Boucle parfaitement régulière, quelques variations, rythme et timbres imprévisibles.",
    levels: [{}, { irregular: 0.6, arp: 0.15 }, { irregular: 1, arp: 0.2 }], expect: "increasing", margin: 4 },
  { key: "dynamics", label: "Dynamique", measure: "loudnessRange", hint: "Niveau constant, contraste moyen, grands écarts fort / doux.",
    levels: [{}, { swell: 0.35 }, { swell: 0.9 }], expect: "increasing", margin: 1.5 },
  { key: "key", label: "Tonalité", measure: "key", hint: "Do majeur, La mineur, Fa# majeur.",
    levels: [{ key: 0, mode: "major" }, { key: 9, mode: "minor" }, { key: 6, mode: "major" }], expect: [{ equals: "C" }, { equals: "Am" }, { equals: "F#" }] },
  { key: "mood", label: "Ambiance", measure: "valence", hint: "Mineur, lent, sombre et saturé ; mineur propre ; majeur, rapide, brillant et propre.",
    levels: [{ mode: "minor", bpm: 75, cutoff: 900, drive: 6, key: 2 }, { mode: "minor", bpm: 110, key: 2 }, { mode: "major", bpm: 150, bright: 0.65 }], expect: "increasing", margin: 8 },
  { key: "intensity", label: "Intensité globale", measure: "score", hint: "Nappe calme, groove pop, extrême bruitiste.",
    levels: [{ kick: 0, snare: 0, hats: 0, bass: 0, arp: 0, chords: 0.3, bright: 0.3, bpm: 70 }, {}, { bpm: 190, kick: 1, kickDrive: 20, sub: 0.6, hats: 0.4, hatDiv: 4, noise: 0.5, drive: 20, clip: 0.3 }], expect: "increasing", margin: 15 },
];

/** Tracks whose parameters change over time (check the curves in the detail dialog). */
export const SWEEPS = [
  { key: "sweep-tempo", label: "Balayage · tempo 80 → 170 BPM", seconds: 60, params: { bpm: (t) => 80 + (90 * t) / 60 }, curve: "BPM", hint: "La courbe BPM doit monter régulièrement." },
  { key: "sweep-bright", label: "Balayage · brillance 400 Hz → sans filtre", seconds: 60, params: { cutoff: (t) => 400 * (40 ** (t / 60)), hats: 0.25 }, curve: "Sous-score Brillance", hint: "Le sous-score brillance doit monter." },
  { key: "sweep-noise", label: "Balayage · le bruit arrive", seconds: 60, params: { noise: (t) => Math.max(0, (t - 10) / 50) * 0.9 }, curve: "Sous-score Bruit", hint: "Le bruit et l'intensité montent dans la seconde moitié." },
  {
    key: "structure", label: "Structure · intro, montée, drop, break, drop, outro", song: [
      { seconds: 16, params: { kick: 0, snare: 0, hats: 0, bass: 0, chords: 0.25 }, gain: 0.35 },
      { seconds: 12, params: { snare: 0.3, hats: 0.2, hatDiv: 4, kick: 0, bass: 0.1 }, gain: 0.6 },
      { seconds: 24, params: { kick: 1, kickDrive: 8, sub: 0.6, bass: 0.4, arp: 0.2, hats: 0.25, drive: 4 }, gain: 1 },
      { seconds: 16, params: { kick: 0, snare: 0, hats: 0, bass: 0, chords: 0.25, bright: 0.3 }, gain: 0.3 },
      { seconds: 24, params: { kick: 1, kickDrive: 8, sub: 0.6, bass: 0.4, arp: 0.2, hats: 0.25, drive: 4 }, gain: 1 },
      { seconds: 12, params: { kick: 0, snare: 0, hats: 0, bass: 0, chords: 0.25 }, gain: 0.3 },
    ],
    expectSections: [{ at: 8, label: "Intro" }, { at: 40, label: "Pic" }, { at: 60, label: "Break" }, { at: 80, label: "Pic" }],
    curve: "Structure", hint: "Sections attendues : Intro 0–16 s, Pic 28–52 s, Break 52–68 s, Pic 68–92 s.",
  },
];

/** Every track of the suite: { id, name, variable, level, render() }. */
export function suiteTracks(seconds = 20) {
  const out = [];
  VARIABLES.forEach((v, vi) => {
    // a seed per variable: identical settings in two tests still give two distinct files
    v.levels.forEach((params, i) => out.push({
      id: `${v.key}-${LEVELS[i]}`, variable: v.key, level: LEVELS[i],
      name: `Test · ${v.label} · ${LEVELS[i]}`,
      render: () => renderTrack({ seed: 3 + i + 10 * vi, ...params }, seconds),
    }));
  });
  for (const s of SWEEPS) {
    out.push({
      id: s.key, variable: s.key, level: "balayage", name: `Test · ${s.label}`,
      render: () => (s.song ? renderSong(s.song) : renderTrack(s.params, s.seconds)),
    });
  }
  return out;
}

const fmt = (m, v) => (v == null ? "—" : MEASURES[m]?.fmt ? MEASURES[m].fmt(v) : String(Math.round(v)));

function nearOk(v, e) {
  if (v == null) return false;
  const cands = e.octave ? [v, v * 2, v / 2] : [v];
  return cands.some((x) => Math.abs(x / e.near - 1) <= e.tol);
}

/**
 * @param {Map<string, object>} byTestId  suite track id → scored record
 * @returns {{variable, label, hint, rows:[{level, measured, expected, ok}], ok, also?}[]}
 */
export function evaluate(byTestId) {
  const results = [];
  for (const v of VARIABLES) {
    const recs = LEVELS.map((l) => byTestId.get(`${v.key}-${l}`));
    const vals = recs.map((r) => (r ? MEASURES[v.measure].get(r) : null));
    const rows = LEVELS.map((level, i) => {
      const e = Array.isArray(v.expect) ? v.expect[i] : null;
      let ok = null, expected = "";
      if (vals[i] == null) ok = null;
      else if (e?.equals != null) { ok = vals[i] === e.equals; expected = e.equals; }
      else if (e?.near != null) { ok = nearOk(vals[i], e); expected = `${e.near} ±${Math.round(e.tol * 100)} %${e.octave ? " (ou ×2, ÷2)" : ""}`; }
      else if (v.expect === "increasing") {
        expected = i === 0 ? "le plus bas" : i === 1 ? "entre les deux" : "le plus haut";
        if (vals.every((x) => x != null)) ok = i === 0 ? vals[0] + v.margin <= vals[1] : i === 1 ? vals[0] + v.margin <= vals[1] && vals[1] + v.margin <= vals[2] : vals[1] + v.margin <= vals[2];
      }
      const also = v.also && recs[i] ? fmt(v.also, MEASURES[v.also].get(recs[i])) : null;
      return { level, measured: fmt(v.measure, vals[i]), raw: vals[i], expected, ok, also, recordId: recs[i]?.id ?? null };
    });
    const known = rows.filter((r) => r.ok != null);
    results.push({
      variable: v.key, label: v.label, hint: v.hint, measure: MEASURES[v.measure].label, alsoLabel: v.also ? MEASURES[v.also].label : null,
      rows, ok: known.length === 3 ? known.every((r) => r.ok) : null,
    });
  }
  for (const s of SWEEPS) {
    const r = byTestId.get(s.key);
    let ok = null, measured = r ? "voir la courbe" : "—";
    if (r && s.expectSections) {
      const secs = r.auto?.music?.sections ?? [];
      const found = s.expectSections.map((e) => secs.find((x) => e.at >= x.start && e.at < x.end)?.label ?? "?");
      ok = found.every((f, i) => f === s.expectSections[i].label);
      measured = secs.map((x) => `${x.label} ${Math.round(x.start)}–${Math.round(x.end)} s`).join(" · ") || "aucune";
    }
    if (r && s.key === "sweep-tempo") {
      const b = r.features?.timeline?.series?.bpm ?? [];
      const first = b.slice(0, 3).filter(Boolean), last = b.slice(-3).filter(Boolean);
      const a = first.reduce((x, y) => x + y, 0) / (first.length || 1), z = last.reduce((x, y) => x + y, 0) / (last.length || 1);
      ok = first.length && last.length ? z > a * 1.4 : null;
      measured = `${Math.round(a)} → ${Math.round(z)} BPM`;
    }
    if (r && (s.key === "sweep-bright" || s.key === "sweep-noise")) {
      const dim = s.key === "sweep-bright" ? "brightness" : "noise";
      const c = r.auto?.curves?.subscores?.[dim] ?? [];
      const q = Math.max(1, Math.floor(c.length / 4));
      const a = c.slice(0, q).reduce((x, y) => x + y, 0) / q, z = c.slice(-q).reduce((x, y) => x + y, 0) / q;
      ok = c.length ? z > a + 10 : null;
      measured = `${Math.round(a)} → ${Math.round(z)}`;
    }
    results.push({
      variable: s.key, label: s.label, hint: s.hint, measure: s.curve, sweep: true,
      rows: [{ level: "balayage", measured, expected: s.hint, ok, recordId: r?.id ?? null }], ok,
    });
  }
  return results;
}
