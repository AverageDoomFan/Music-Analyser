// Central configuration. Everything that tunes the scoring model lives here so
// the algorithm can be adjusted without touching UI, storage or audio code.

/**
 * Version of the scoring model (features -> sub-scores -> intensity).
 * Bump it whenever the scoring changes: stored tracks whose version differs are
 * re-scored automatically from their cached features, without re-decoding audio.
 */
export const ALGORITHM_VERSION = "1.2";

/**
 * Version of the feature extractor (audio -> raw features).
 * Bump it only when the raw features change in a way that requires the audio
 * file again. Tracks with an older feature version are flagged "réanalyse
 * conseillée" but keep their scores and corrections.
 */
export const FEATURE_VERSION = "1.2";

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

/**
 * Weights of each sub-score in the global intensity. Relative values matter,
 * not their sum. `noise` is not averaged with the others: it acts as an
 * "extremeness" push that only matters once the track is already intense.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  energy: 1.0,
  tempo: 0.55,
  density: 0.9,
  brightness: 0.35,
  harshness: 1.2,
  pressure: 0.9,
  complexity: 0.35,
  noise: 1.0,
});

/**
 * How a track's intensity curve (and each sub-score curve) becomes its score.
 * The first one is the default.
 */
export const AGGREGATIONS = [
  { key: "topMean", label: "Moyenne des pics", hint: "Moyenne des 25 % de moments les plus intenses (refrains, drops) : ce que l'on retient d'un morceau." },
  { key: "mean", label: "Moyenne", hint: "Intensité moyenne sur toute la durée." },
  { key: "median", label: "Médiane", hint: "Niveau typique, insensible aux intros, outros et breaks." },
  { key: "peak", label: "Pic", hint: "Passage le plus intense, lissé sur ~12 s pour ignorer les accidents." },
  { key: "perceptual", label: "Perceptive", hint: "Moyenne de puissance : chaque passage compte, les passages intenses davantage." },
];
export const DEFAULT_AGGREGATION = AGGREGATIONS[0].key;

/** Extra curve statistics offered for sorting (not as scores). */
export const CURVE_STATS = [
  { key: "start", label: "Début", hint: "Intensité des 20 premières secondes." },
  { key: "end", label: "Fin", hint: "Intensité des 20 dernières secondes." },
  { key: "variability", label: "Variabilité", hint: "Écart entre passages calmes et intenses (p90 − p10)." },
];

export const DIMENSIONS = [
  { key: "energy", label: "Énergie", hint: "Activité globale : mouvement spectral, attaques, dynamique." },
  { key: "tempo", label: "Tempo", hint: "Vitesse des événements (onsets), BPM pondéré par sa fiabilité." },
  { key: "density", label: "Densité", hint: "Remplissage spectral et temporel, peu de silences." },
  { key: "brightness", label: "Brillance", hint: "Centre de gravité spectral, énergie dans les aigus." },
  { key: "harshness", label: "Dureté", hint: "Aigus bruités, transitoires, saturation : l'agressivité du timbre." },
  { key: "pressure", label: "Pression", hint: "Kicks et basses : attaques dans le grave, poids, maintien et saturation du grave, écrasement. Indépendant du volume du fichier." },
  { key: "complexity", label: "Complexité", hint: "Variabilité spectrale et rythmique." },
  { key: "noise", label: "Bruit", hint: "Caractère bruitiste / extrême : spectre plat, peu de tonalité." },
];

/**
 * Piecewise-linear calibration from the raw model output (0..1) to the
 * displayed score (0..100). Spreads the scale so the usual range of music is
 * not squeezed in the middle.
 */
export const CALIBRATION = [
  [0.0, 0],
  [0.12, 4],
  [0.25, 18],
  [0.4, 38],
  [0.55, 58],
  [0.7, 77],
  [0.82, 90],
  [0.92, 97],
  [1.0, 100],
];

/** Perceptual stages used for display and the progression view. */
export const STAGES = [
  { min: 0, label: "Calme" },
  { min: 15, label: "Calme / mélodique" },
  { min: 30, label: "Accessible" },
  { min: 45, label: "Énergique" },
  { min: 60, label: "Intense" },
  { min: 72, label: "Agressif" },
  { min: 84, label: "Extrême" },
  { min: 94, label: "Bruitiste" },
];

export function stageFor(score) {
  let stage = STAGES[0];
  for (const s of STAGES) if (score >= s.min) stage = s;
  return stage;
}

export const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus", "webm"];
