// Central configuration. Everything that tunes the scoring model lives here so
// the algorithm can be adjusted without touching UI, storage or audio code.

import { t } from "./i18n/index.js";

/**
 * Version of the scoring model (features -> sub-scores -> intensity).
 * Bump it whenever the scoring changes: stored tracks whose version differs are
 * re-scored automatically from their cached features, without re-decoding audio.
 */
export const ALGORITHM_VERSION = "2.0";

/**
 * Version of the feature extractor (audio -> raw features).
 * Bump it only when the raw features change in a way that requires the audio
 * file again. Tracks with an older feature version are flagged "re-analysis
 * advised" but keep their scores and corrections.
 */
export const FEATURE_VERSION = "1.4";

/** Schema version of the JSON export. */
export const EXPORT_SCHEMA_VERSION = 1;

export const ANALYSIS = {
  sampleRate: 44100,        // every file is decoded (and resampled) to this rate
  fftSize: 2048,
  hopSize: 512,             // ~11.6 ms at 44.1 kHz
  // Long files are analysed through evenly spaced excerpts to bound CPU/memory.
  maxFullAnalysisSeconds: 12 * 60,
  excerptSeconds: 45,
  excerptCount: 12,
  windowSeconds: 6,         // timeline: features are also computed on sliding windows
  windowHopSeconds: 3,
  referenceLufs: -14,       // every file is normalised to this loudness before analysis
  silenceDb: -60,           // frames below this RMS (after normalisation) are "silent"
  concurrency: 2,           // files decoded/analysed in parallel
};

/** Rhythm map (note extraction) settings. */
export const RHYTHM = {
  fftSize: 2048,
  hopSize: 256,             // ~5.8 ms timing resolution
  attackPosition: 0.68,     // where in the window an attack peaks the flux (timing correction)
  maxDurationSeconds: 20 * 60,
  maxLanes: 8,              // the lane colours come from an 8-slot categorical palette
};

/** Default note-extraction parameters (all editable in the rhythm tab). */
export const RHYTHM_DEFAULTS = Object.freeze({
  bandsPerOctave: 24,  // heavy: needs a new spectral pass (24 = quarter tone)
  fMin: 30,            // heavy
  fMax: 16000,         // heavy
  instruments: 0,      // number of instruments (lanes); 0 = automatic
  maxInstruments: 6,   // upper bound for the automatic choice
  sensitivity: 0.5,    // 0 = only strong attacks, 1 = every small attack
  minGapMs: 25,        // minimum time between two notes of the same lane (25 ms = 40 notes/s)
  silenceDb: 45,       // no notes where the music is this far below its loud level (dB)
  assignRatio: 0.35,   // an attack also counts for an instrument carrying ≥ this share of the main one
  minStrength: 0.35,   // drop notes weaker than this × the lane's strong notes (leftovers of other sounds)
});

/**
 * Weights of each sub-score in the global intensity. Relative values matter,
 * not their sum. `noise` is not averaged with the others: it acts as an
 * "extremeness" push that only matters once the track is already intense.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  energy: 0.6,
  tempo: 0.5,
  density: 0.25,
  brightness: 0.2,
  harshness: 2.6,
  pressure: 1.5,
  complexity: 0.15,
  noise: 0.7,
});

/**
 * How a track's intensity curve (and each sub-score curve) becomes its score.
 * The first one is the default.
 */
export const AGGREGATIONS = [
  { key: "topMean", label: t("Mean of peaks"), hint: t("Mean of the 25 % most intense moments (choruses, drops): what you remember of a track.") },
  { key: "mean", label: t("Mean"), hint: t("Average intensity over the whole track.") },
  { key: "median", label: t("Median"), hint: t("Typical level, ignores intros, outros and breaks.") },
  { key: "peak", label: t("Peak"), hint: t("Most intense passage, smoothed over ~12 s to ignore accidents.") },
  { key: "perceptual", label: t("Perceptual"), hint: t("Power mean: every passage counts, intense ones more.") },
];
export const DEFAULT_AGGREGATION = AGGREGATIONS[0].key;

/** Extra curve statistics offered for sorting (not as scores). */
export const CURVE_STATS = [
  { key: "start", label: t("Start"), hint: t("Intensity of the first 20 seconds.") },
  { key: "end", label: t("End"), hint: t("Intensity of the last 20 seconds.") },
  { key: "variability", label: t("Variability"), hint: t("Gap between calm and intense passages (p90 − p10).") },
]

export const DIMENSIONS = [
  { key: "energy", label: t("Energy"), hint: t("Overall activity: spectral motion, attacks, crushed dynamics.") },
  { key: "tempo", label: t("Tempo"), hint: t("Speed of events (onsets), BPM weighted by its reliability, kick speed (never folded: speedcore, extratone).") },
  { key: "density", label: t("Density"), hint: t("Spectral and temporal fill.") },
  { key: "brightness", label: t("Brightness"), hint: t("Spectral centre of gravity, energy in the highs.") },
  { key: "harshness", label: t("Harshness"), hint: t("Distortion (flat, saturated mids), noisy highs, clipping, compression: how aggressive the timbre is.") },
  { key: "pressure", label: t("Pressure"), hint: t("Kicks and bass that hit: low-end attacks, kick punch, crushed master; a little the weight of the low end. Independent of the file's volume.") },
  { key: "complexity", label: t("Complexity"), hint: t("Unpredictability: irregular rhythm, non-repetitive pulse, changing timbre.") },
  { key: "noise", label: t("Noise"), hint: t("Noise / extreme character: flat spectrum, little tonality. Pushes towards 100 tracks that are already intense.") },
]

/**
 * Piecewise-linear calibration from the raw model output (0..1) to the
 * displayed score (0..100). Fitted (algorithm 2.0) on a real 100-track
 * library rated by ear, from ambient piano to extratone.
 */
export const CALIBRATION = [
  [0.0, 0],
  [0.15, 16],
  [0.3, 33],
  [0.4, 45],
  [0.5, 58],
  [0.6, 71],
  [0.7, 82],
  [0.8, 90],
  [1.0, 100],
];

/**
 * How the user's rating of a song's lyrics shifts its perceived intensity and
 * mood (per level, levels 1..3). Words change how a track feels: violent
 * lyrics make it hit harder, tender ones soften it.
 */
export const LYRICS_MOODS = [
  { key: "joyeux", label: t("Joyful"), icon: "☀", intensity: 1, valence: 10 },
  { key: "doux", label: t("Tender / soothing"), icon: "♡", intensity: -2, valence: 5 },
  { key: "neutre", label: t("Neutral"), icon: "○", intensity: 0, valence: 0 },
  { key: "triste", label: t("Sad"), icon: "☂", intensity: -1, valence: -10 },
  { key: "sombre", label: t("Dark"), icon: "☾", intensity: 1, valence: -8 },
  { key: "violent", label: t("Violent / angry"), icon: "⚡", intensity: 3, valence: -10 },
];
export const LYRICS_LEVELS = ["", t("a little"), t("clearly"), t("very")];

/** Perceptual stages used for display and the progression view. */
export const STAGES = [
  { min: 0, label: t("Ambient") },
  { min: 10, label: t("Calm") },
  { min: 20, label: t("Soft") },
  { min: 30, label: t("Laid-back") },
  { min: 40, label: t("Groovy") },
  { min: 50, label: t("Lively") },
  { min: 60, label: t("Energetic") },
  { min: 70, label: t("Powerful") },
  { min: 78, label: t("Intense") },
  { min: 86, label: t("Fierce") },
  { min: 93, label: t("Extreme") },
  { min: 97, label: t("Paroxysmal") },
];

export function stageFor(score) {
  let stage = STAGES[0];
  for (const s of STAGES) if (score >= s.min) stage = s;
  return stage;
}

export const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus", "webm"];
