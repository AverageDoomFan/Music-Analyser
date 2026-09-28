// Musical description of a track from its cached features: key, tempo,
// structure and mood (valence). Like the intensity model, no genre rule:
// only audio descriptors. Used for display, sorting and transitions.

import { keyName, camelot } from "../audio/music.js";
import { LYRICS_MOODS } from "../config.js";
import { t } from "../i18n/index.js";

const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const lin = (x, lo, hi) => clamp01((x - lo) / (hi - lo));
const db = (x) => 10 * Math.log10(Math.max(x ?? 0, 1e-12));

/** Key most present among the first / last windows (confident ones), or the track key. */
function edgeKey(tl, which, fallback) {
  const s = tl?.series;
  if (!s?.keyIndex?.length) return fallback;
  const n = s.keyIndex.length;
  const idx = which === "start" ? [...Array(Math.min(4, n)).keys()] : [...Array(Math.min(4, n)).keys()].map((i) => n - 1 - i);
  const votes = new Map();
  for (const i of idx) {
    const k = s.keyIndex[i];
    if (k < 0 || !(s.keyConfidence[i] > 0.05)) continue;
    votes.set(k, (votes.get(k) ?? 0) + s.keyConfidence[i]);
  }
  if (!votes.size) return fallback;
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function edgeTempo(tl, which, fallback) {
  const s = tl?.series;
  if (!s?.bpm?.length) return fallback;
  const n = s.bpm.length;
  const idx = which === "start" ? [0, 1, 2, 3] : [n - 1, n - 2, n - 3, n - 4];
  const v = idx.filter((i) => i >= 0 && i < n && s.bpm[i] && s.bpmConfidence[i] >= 0.25).map((i) => s.bpm[i]);
  if (!v.length) return fallback;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

/**
 * Mood axis (valence): 0 = dark / tense, 100 = bright / cheerful.
 * Mode (major/minor, weighted by how clear the key is), brightness, tempo,
 * consonance (tonal vs noisy spectrum) and softness of the sound.
 */
export function computeMood(f) {
  const hasKey = Number.isInteger(f.keyIndex) && f.keyIndex >= 0;
  const conf = clamp01(f.keyConfidence ?? 0);
  // distortion smears the chroma: a minor key heard through saturation still
  // reads minor, even with a modest key confidence
  const modeV = hasKey ? 0.5 + (f.keyIndex < 12 ? 0.5 : -0.5) * conf ** 0.25 : 0.5;
  const bpmConf = clamp01(f.bpmConfidence);
  const tempoV = f.bpm ? bpmConf * lin(f.bpm, 70, 150) + (1 - bpmConf) * lin(f.onsetRate, 1, 8) : lin(f.onsetRate, 1, 8);
  // saturated mids (extractor 1.4+) sound dark and tense, whatever the key
  const clean = f.midFlatnessMedian != null ? 1 - lin(db(f.midFlatnessMedian), -30, -10) : 1;
  const comps = [
    ["Major / minor mode", modeV, hasKey ? 0.4 : 0.1],
    ["Brightness", lin(f.centroidMean, 700, 4000), 0.2],
    ["Tempo", tempoV, 0.15],
    ["Consonance (tonal, clean spectrum)", Math.min(1 - lin(db(f.flatnessMedian), -40, -10), clean), 0.15],
    ["Unsaturated sound", lin(f.crestDb, 5, 14), 0.1],
  ];
  let s = 0, w = 0;
  for (const [, v, wi] of comps) { s += v * wi; w += wi; }
  // perceptual stretch (2.1): the blend of cues stays near the middle, while a
  // dark, slow, saturated minor track is felt as clearly dark (test bench)
  const valence = clamp01(0.5 + (s / w - 0.5) * 1.2);
  return {
    valence: Math.round(valence * 1000) / 10,
    explain: comps.map(([label, value, weight]) => ({ label, value: Math.round(value * 1000) / 1000, weight })),
  };
}

/**
 * Dynamics on 0..100 from the loudness range (LU): 0 = constant level,
 * ~40 = clear loud / soft contrasts, 70 = huge gaps (~22 LU). Concave: the
 * first LU of contrast are the most audible.
 */
export function dynamicsScore(loudnessRange) {
  if (!Number.isFinite(loudnessRange)) return null;
  return Math.round(1000 * (1 - Math.exp(-Math.max(0, loudnessRange) / 18))) / 10;
}

/** Quadrant label from intensity and valence. */
export function moodLabel(intensity, valence) {
  if (intensity == null || valence == null) return "—";
  const hi = intensity >= 55, lo = intensity < 35;
  const bright = valence >= 58, dark = valence < 42;
  if (hi && bright) return t("Euphoric");
  if (hi && dark) return t("Dark / raging");
  if (hi) return t("Energetic");
  if (lo && bright) return t("Serene");
  if (lo && dark) return t("Melancholic");
  if (lo) return t("Laid-back");
  if (bright) return t("Cheerful");
  if (dark) return t("Tense");
  return t("Neutral");
}

// section labels of extractor ≤ 1.3
const LEGACY_SECTIONS = { "Montée": "Build-up", "Pic": "Peak" };

export function describeMusic(f) {
  const tl = f.timeline;
  const k = Number.isInteger(f.keyIndex) && f.keyIndex >= 0 ? f.keyIndex : null;
  const start = edgeKey(tl, "start", k), end = edgeKey(tl, "end", k);
  return {
    key: k == null ? null : {
      index: k, name: keyName(k), camelot: camelot(k), confidence: f.keyConfidence ?? 0,
      start, end, startCamelot: camelot(start), endCamelot: camelot(end),
    },
    tempo: f.bpm ? {
      bpm: f.bpm, confidence: f.bpmConfidence ?? 0, stability: f.bpmStability ?? null, alt: f.bpmAlt ?? null,
      start: edgeTempo(tl, "start", f.bpm), end: edgeTempo(tl, "end", f.bpm),
    } : null,
    sections: f.sections?.map((x) => ({ ...x, label: LEGACY_SECTIONS[x.label] ?? x.label })) ?? null,
    mood: computeMood(f),
    dynamics: dynamicsScore(f.loudnessRange),
  };
}

/** Intensity and valence shifts from the user's rating of the lyrics. */
export function lyricsEffect(lyrics) {
  if (!lyrics?.mood) return { intensity: 0, valence: 0 };
  const m = LYRICS_MOODS.find((x) => x.key === lyrics.mood);
  const k = Math.max(1, Math.min(3, lyrics.strength ?? 2));
  return m ? { intensity: m.intensity * k, valence: m.valence * k } : { intensity: 0, valence: 0 };
}
