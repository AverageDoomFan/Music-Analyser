# Music Energy Analyzer

A 100 % in-browser web app with two tools:

- **Analysis**: a perceived intensity score, curves over time, progressive playlists, sets drawn on a curve.
- **Rhythm**: splits a track into notes to create a rhythm game map (lanes per instrument, cue sounds, KPS, difficulty).

It analyses audio **locally** and gives each track a perceived intensity score from 0 to 100, to build playlists from the calmest to the most extreme:

```
AMBIENT → CALM → SOFT → LAID-BACK → GROOVY → LIVELY → ENERGETIC → POWERFUL → INTENSE → FIERCE → EXTREME → PAROXYSMAL
```

The score is a practical perceptual ranking tool, **not a scientific measure**. There is no genre rule: everything comes from audio features.

The interface is in **English by default**, with a **French** version (Settings › Language; the guide follows the same choice).

## Using it

The **Home** tab shows the possible paths and the state of the app. The detailed guide is **[guide.html](guide.html)** (“Guide” link in the app).

1. Drop files (MP3, WAV, OGG, FLAC, M4A… depending on the browser) or a whole folder, or scan a Spotify playlist in the **Live** tab.
2. The analysis runs in the background (Web Workers); results are cached in IndexedDB.
3. Choose how the intensity curve becomes a score (mean of peaks, mean, median, peak, perceptual) and sort by score, curve statistic (start, end, variability…), mood, BPM, key, genre, name or date.
4. Open a track to follow its **curves over time** (intensity, sub-scores, BPM, relative level, distortion, kick speed…) and see **why** it has its score. ▶ plays it: local files of the session in the browser, Spotify captures on your Spotify app.
5. “The score is off” → a few targeted questions, old / new score preview, accept or cancel. Or set a manual score.
6. **Games** → a daily Spotify track to guess (the same for everyone, analysed live while you guess), guess a track's score on the speed dial, pick the more intense of two tracks (> < =), or hunt a drawn score on Spotify; fix the scores you disagree with.
7. **Lyrics** (library, track details or directly in the Live tab), **Duels** and **Genres** → tune the perception to how you feel.
8. **Progression** → “Build a progression”, M3U / text export. **Set** → draw the intensity curve you want; the app picks and orders the tracks.
9. **⚑ Report for analysis** (track details) → saves everything about a track, with your comment and expected score, to send for a closer look at the model.
10. Settings → language, weights, learning from corrections, genre sources (MusicBrainz, optional Last.fm key), JSON export / import, diagnostic export, reports, local data deletion.

Audio files are never sent to a server. They are not stored either: only the extracted features are. Local playback and re-analysis therefore work for files imported in the current session; a file imported again later is recognised by its SHA-256 fingerprint and not analysed again.

## Running locally

No dependency, no build:

```sh
python3 -m http.server 8000   # or any static server
# then http://localhost:8000
```

(A server is needed: ES modules and workers do not load from `file://`.)

Tests (Node ≥ 20): `npm test` — feature extraction and score ordering on synthetic signals, the full test bench (min / mid / max of every variable, and the values rated by ear), tempo octave, corrections, versioning, export / import, progression, set, live scan (and ▶ jump), play orders, genres, Spotify helpers.

## GitHub Pages deployment

- **Option A**: Settings → Pages → Source “GitHub Actions”. The `.github/workflows/pages.yml` workflow runs the tests then deploys on every push to `main`. It also adds `?v=<commit>` to every module URL (`scripts/stamp-version.mjs`): after a deployment, the browser cannot mix a new page with modules left in cache.
- **Option B**: Settings → Pages → “Deploy from a branch”, `main` branch, `/ (root)` folder. The site is served as is, without tests or versioning: after an update, a hard reload (Ctrl+Shift+R) may be needed.

## Architecture

```
index.html, guide.html, styles.css
src/
  config.js                 ALGORITHM_VERSION, FEATURE_VERSION, weights, sub-score scales, calibration, levels
  i18n/index.js             t() / tn(), language choice, translation of the static markup
  i18n/fr.js                French strings, keyed by the English text
  audio/
    sources.js              AudioSource → LocalFileSource (extension point for other sources)
    decoder.js              Web Audio decoding → mono 44.1 kHz + per-channel clipping
    fft.js                  radix-2 FFT
    features.js             raw feature extraction (pure function, testable in Node)
    features.worker.js      runs it in a Web Worker
    analyzer.js             queue, worker pool, main-thread fallback
    music.js                key (chroma, Krumhansl), Camelot, MFCC, structure (self-similarity)
    engine.js               Web Audio playback: position, isolated lane, scheduled cues
  scoring/
    model.js                features → 8 sub-scores → intensity, per window (curves)
    aggregate.js            curve → score (mean of peaks, mean, median, peak, perceptual…)
    index.js                active model (the place to swap the model)
    describe.js             start / end key and tempo, mood, lyrics effect
    correction.js           questions, choice of the relevant ones, applying the answers
    learning.js             fitting the global weights to corrections (and to duels, Bradley-Terry)
    similarity.js           timbre fingerprint, close tracks, groups (k-means)
    genres.js               personal hierarchical genres, nearest-neighbour suggestions
    genre-map.js            Spotify micro-genres → hierarchy (Electronic › Hard dance › Rawstyle)
  core/track.js             a track's life cycle (auto / correction / manual, history, re-scoring)
  storage/db.js             IndexedDB (tracks, settings)
  storage/backup.js         JSON export / import, merging without losing corrections
  playlist/progression.js   progression algorithm + M3U / text export
  playlist/set.js           set generator (target curve, transitions, constraints), splitting
  rhythm/                   bands, notes (NMF instruments), difficulty, session
  spotify/                  PKCE, API (playlists, playback control), matching, export
  live/capture.js           system audio / audio input capture (AudioWorklet, resampling to 44.1 kHz)
  live/scanner.js           playlist scan: Spotify control, excerpts, live and final analysis
  live/plan.js              modes (whole, fixed excerpts, adaptive: probes then focused listening)
  live/order.js             play orders of the scan (playlist, random, title, artist, duration, score…)
  live/meter.js             continuous BS.1770 loudness (momentary, short term, integrated, LRA)
  live/demo.js              live scan demo mode (fake Spotify → MediaStream)
  testlab/                  parametric test track generator and test bench evaluation
  util/musicbrainz.js       genres from MusicBrainz (ISRC / artist + title search, vote merging)
  util/lastfm.js            optional Last.fm top tags (user's own API key)
  util/rate-queue.js        request spacing (MusicBrainz: 1 request per second)
  app/                      state and use cases (controller: analysis, genres, reports, games…)
  ui/                       one module per tab or dialog (library, detail, games, live, set…)
```

Scoring, storage, audio import and the interface are independent: a new model only has to expose `computeSubscores`, `computeIntensity` and `scoreFeatures` and be plugged in `src/scoring/index.js`.

### Extracted features

- **Temporal**: BPM (onset envelope autocorrelation + reliability), onsets/s, rhythmic regularity, RMS (mean, deviation), silences.
- **Spectral**: centroid, bandwidth, 85 % rolloff, flux (mean, deviation), flatness, zero crossing rate, spectral crest, spectral fill, band energies (sub, bass, low-mid, high-mid, high) and low / mid / high ratios.
- **Low end / pressure**: low-end attacks (positive flux 40–150 Hz), clear kicks per second and their punch, low-end energy variation, 30–500 Hz flatness.
- **Distortion** (extractor 1.4): flatness of the mids (400 Hz – 5 kHz). Distorted guitars and saturated synths fill that band with harmonics and noise; clean voices and instruments leave it peaky.
- **Kick speed** (extractor 1.4): the fastest regular pulse of the low-band onset envelope (autocorrelation), with its regularity. Unlike the BPM it is never folded into 60–180: speedcore at 280 BPM gives ~4.7 kicks/s, extratone at 600+ BPM 10+ kicks/s, even when the kicks are too close to be picked one by one.
- **General**: loudness range (LRA-like), peak-to-loudness ratio (PLR), crest factor, clipping (plateaus of ≥ 3 samples at the peak, relative to the peak), transient strength.

**Volume independence**: every file is first normalised to -14 LUFS (BS.1770-like loudness: K-filter, gating). A file's mastering level therefore changes neither its features nor its score; the same track exported 12 dB lower gets the same score (checked by the tests). The original loudness is kept for information only.

Files longer than 12 minutes are analysed through 12 excerpts of 45 s spread over the whole length.

## Music: key, tempo, structure, mood

- **Key and mode** (e.g. “Am · 8A” on the Camelot wheel), with a reliability and the start and end keys. Chroma from the peaks of an 8192-point FFT (frequency refined by interpolation), correlated with the Krumhansl-Kessler profiles.
- **Tempo**: tracked window to window, with steadiness (share of windows within ±4 %), the alternative octave and the start and end tempo.
- **Structure**: sections from the novelty of the self-similarity matrix (timbre, harmony, level). Labels (Intro, Build-up, Peak, Break, Section, Outro) only depend on the sections' relative levels, never on a genre. Only computed when the whole track was heard in one go.
- **Mood** (0 = dark, 100 = bright), from the mode, brightness, tempo, consonance and how unsaturated the sound is. Combined with intensity it gives a label: Euphoric, Dark / raging, Serene, Melancholic…
- **Timbre fingerprint** (MFCC and spectral balance), to find close tracks and form groups.

**Vocals and lyrics.** Audio alone cannot detect vocals reliably without a learned model. The user says whether a track is sung, and the mood of its lyrics: joyful, tender, neutral, sad, dark or violent, on three levels. The rating shifts the perceived intensity (violent lyrics at full: +9) and the mood. It can be given in the track's details, in the “Rate the lyrics” assistant (keyboard shortcuts), or in the Live tab while the track is scanned (applied when it is saved).

When MusicBrainz tags a recording or its album “instrumental”, the track is marked instrumental (your own answer always wins). There is no automatic lyrics lookup any more: the former LRCLIB option only guessed a mood from a word list, and your own rating is what moves the score.

**Duels and games.** “Which one is more intense?”: the app picks pairs where the model hesitates. The **Games** tab offers the same comparison as a game (> < =) and a trivia (guess the hidden score). Answers are saved as duels and fit the weights with a Bradley-Terry model; if no weights explain your answers better, the current settings are kept. Scores can be fixed on the spot.

## Scoring model (algorithm 2.0)

Eight 0–100 sub-scores, each an explicit blend of normalised components (shown in the details tooltip):

| Dimension | Mainly |
|---|---|
| Energy | spectral motion, attacks, low-end attacks, crushed master, tight dynamics |
| Tempo | onsets/s, BPM weighted by its reliability; the unfolded kick speed sets a floor |
| Density | spectral fill, bandwidth, attacks, tight dynamics |
| Brightness | centroid, rolloff, energy > 2 kHz |
| Harshness | distortion (mid flatness), high energy, centroid, flux, clipping, compression |
| Pressure | low-end attacks, kick punch, crushed master, a little low-end weight — volume independent |
| Complexity | irregular rhythm, non-repetitive pulse, timbre variation |
| Noise | strong flatness, full spectrum, few tonal peaks, clipping, crushing |

Intensity of a window = weighted mean of the first seven dimensions, then a “noise / extreme” push towards 100 that only acts once the track is already intense or harsh, then a piecewise calibration (`CALIBRATION` in `config.js`).

Version 2.0 was fitted on a real diagnostic export (100 tracks captured from Spotify, from ambient piano to extratone) against by-ear ratings:

- Ranges follow real libraries instead of theoretical extremes, so a loud, dense modern pop mix no longer maxes out what a metal or hardcore track reaches. On the fitted set the error dropped from 18 to 13 points (RMSE) and the rank correlation rose from 0.82 to 0.87; mid-range chill tracks moved down by 10–25 points.
- A low PLR, a steady level and a low crest only count when there are attacks (a sustained pad is not “crushed”), and low-end measures only when there is a low end.
- Harshness weighs the most, then pressure; brightness, density and complexity weigh little (they are common to calm and intense mixes).
- Distortion and kick speed need extractor 1.4 (a new analysis of the track). Older tracks use an approximation (whole-spectrum flatness, no kick speed): metal and extratone are underrated until they are analysed again.

Weights can be changed in `config.js` (`DEFAULT_WEIGHTS`) or in the interface; corrections, duels and games adapt them to your ear.

Each sub-score has a **reliability** (how consistent its components are; for tempo, the beat tracker's reliability). Correction questions only cover the dimensions that can explain the gap and whose analysis is unsure.

### Curves over time

Nothing is only averaged. Extraction has two passes: one per STFT frame (~11.6 ms) storing every measure, then a summary of those frames for the whole track and for each **6 s window (3 s hop)**. Each feature becomes a curve, stored in columns in `features.timeline`; the model scores **each window**, which gives an intensity curve and one curve per sub-score.

Extractor 1.8 measures the **attack rate** (`src/audio/fast-pulse.js`): the frame pass cannot see attacks closer than ~25 ms, so the envelopes of two bands are sampled at ~2 kHz and searched for the fastest regular pulse of 2 to 70 hits/s shared by both. Algorithm 2.4 turns it into points on top of the calibrated score along a rising curve (`ATTACK_POINTS`: 0 at 3/s, 5 at 5/s, 12 at 8/s, 25 at 12/s, 45 at 16/s, 65 at 24/s, 80 at 48/s), scaled by how regular and lasting the pulse is and faded in with the intensity. Known limit: from ~20 hits/s up a kick train is also a pitched tone, so a sustained low note (distorted bass or guitar at 30-70 Hz) reads the same way.

**From the curve to a score** (`src/scoring/aggregate.js`, above the library or in Settings):

| Method | Computation |
|---|---|
| Mean of peaks *(default)* | mean of the 25 % most intense windows (choruses, drops) |
| Mean | mean of the whole curve |
| Median | typical level, ignores intros / outros / breaks |
| Peak | maximum of the curve smoothed over ~12 s |
| Perceptual | power mean (p = 3): everything counts, intense passages more |

Extra sort statistics: **Start** (first 20 s), **End** (last 20 s), **Variability** (p90 − p10). Changing the method recomputes everything from the cache.

### Versioning and stored data

Each track stores its raw features, initial and current automatic score, correction answers, corrected sub-scores and score, manual score, final score, a timestamped history, and the algorithm and extractor versions.

- `ALGORITHM_VERSION` changes → on load, every score is recomputed **from the cached features**, without reading the audio, and correction answers are re-applied.
- `FEATURE_VERSION` changes → scores stay (missing features are approximated), tracks are flagged “re-analysis advised”. 1.3 → 1.4 adds mid flatness (distortion) and kick speed.

## Genres

- Personal hierarchical labels (“Electronic › Hardstyle › Rawstyle”). The user's label always wins.
- Unlabelled tracks get a nearest-neighbour suggestion from the labelled ones (timbre, intensity, mood, tempo, mode). If the neighbours disagree on a sub-genre (less than 55 % of the votes), the suggestion goes up to the parent genre.
- **Automatic genres**: Spotify's Web API returns empty artist genres for apps created after November 2024, so genres come from **MusicBrainz** (musicbrainz.org, open, CORS, no key). For each analysed track the app searches the recording by ISRC (file tags, or the matched / captured Spotify track), else by artist + title (+ length), then reads the genre votes of the recording, its album (release group) and its artist, and merges them (track ×3, album ×2, artist ×1, each level normalised). One request per second through a queue; results cached 30 days per track, artist and album. Tracks without genres are looked up in the background at startup and after each analysis (can be turned off in Settings); **“Refresh genres”** under the library filters looks every track up again. Optional: with your own Last.fm API key (Settings), tracks MusicBrainz does not know get Last.fm's top tags. Names are placed in a hierarchy by keyword rules (`src/scoring/genre-map.js`); the library shows where the genres come from.
- Search, filter, grouping by family / style / exact genre, “by style, then intensity” order (Progression tab and sorted Spotify playlist), splitting into playlists by genre (Set tab).

## Reports and diagnostic

- **⚑ Report for analysis** (track details): a detailed snapshot of one track — every feature and its curves, sub-scores, their components, the curves of the model, genres, your corrections, lyrics rating, expected score and comment. Settings › Reports for analysis exports the saved reports in one JSON file. No audio, no file path.
- **Diagnostic export** (Settings): one compact JSON for the whole library (scores, sub-scores, the measures behind each dimension, genres, corrections, lyrics ratings, duels), used to recalibrate the model.

## Set tab: set generator

- **Target curve**: presets (warm-up → peak → cool-down, steady climb, waves, plateau, intervals, wind-down) or a free curve.
- **Selection and order**: simulated annealing from a rank assignment. The cost combines the gap to the curve, transitions (intensity seam end → start, tempo with half / double compatibility, Camelot compatibility, timbre, mood, each with an adjustable weight), the target length and constraints.
- **Constraints**: first and last track, locked 🔒 or excluded ✕ tracks, never the same artist twice in a row. The source is the library or an imported Spotify playlist.
- **Result**: smoothness rating per transition, gap to the curve, rough transitions. M3U / text export, or playlist creation on Spotify.
- **Split** a library or playlist into N playlists by intensity, mood, timbre group or genre.

## Spotify tab: sort one of your playlists

The tab imports the track list of one of your playlists and matches it with your local audio files, or with tracks scanned in the Live tab, then creates on your account a **new** private playlist ordered from calmest to most intense. The original playlist is never changed.

**Setting up (once)**
1. On [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), create an app (the owner account of a development-mode app must be Premium). Do not put “Spotify” in its name and tick *Web API*.
2. *Redirect URIs*: add the address shown in the tab, e.g. `https://averagedoomfan.github.io/Music-Analyser/`. For a local test, also add `http://127.0.0.1:8000/` (Spotify no longer accepts `localhost`).
3. *User Management*: add your Spotify account's e-mail (development mode: 5 accounts max).
4. Copy the **Client ID**, which is public. The *Client secret* is not used and must never be put in the app.
5. In the Spotify tab: paste the Client ID, click “Log in to Spotify”, accept the requested rights.

**Using it**: import a playlist you own or collaborate on, then drop your files. Matching uses the ISRC from the tags when present, else title, artist and length (ID3 for MP3, Vorbis for FLAC, else the “Artist - Title” file name). Matches can be fixed row by row. Imported playlists are remembered; importing again shows the tracks added and removed. The **map** places each analysed track by intensity and mood, and can be **compared** with another imported playlist.

**Security and privacy**
- **Login**: OAuth 2.0 *Authorization Code + PKCE*, the flow meant for serverless apps. No secret; a `state` protects against forged requests.
- **Requested rights**: read your private and collaborative playlists, create and change playlists, read and control playback (Live tab, playback from the library). Nothing else.
- **Token**: stays in this browser (localStorage), only sent to `accounts.spotify.com` and `api.spotify.com`.
- **Kept data**: the imported playlists and your matches. “Log out and delete” removes the token and that data. You can also revoke the access on [spotify.com/account/apps](https://www.spotify.com/account/apps).

**Legal frame** (a summary, not legal advice): a standard API use, managing playlists for your own account, as long as:
- the analysed audio is **your own files** or your own playback; the app downloads nothing from Spotify;
- no Spotify data is used to train an AI model or to produce listening statistics (forbidden by the *Developer Policy*): metadata only serve matching and playlist creation, and weight fitting only uses your own ratings;
- the app does not present itself as a Spotify product: content is attributed and links back to Spotify.

## Live tab: analyse a Spotify playlist without the files

The Live tab plays each track of the imported playlist on **your Spotify app** (API playback control), captures the sound coming out of the PC and analyses it in real time with the same extractor as for files. Analysed tracks join the library (source “Spotify”, with the share of the track heard), can be played back from the library, and count for the Spotify tab's sorted playlist.

**Capture (Windows)**
- **System audio**: Chrome or Edge, “Entire screen” + “Also share system audio”. The sound must stay audible and nothing else must play.
- **Silent scan**: with VB-Cable, route Spotify to “CABLE Input” (Settings › Sound › Volume mixer), then pick the “CABLE Output” input in the tab.
- In Spotify, turn off “Normalize volume” and crossfade. The Spotify app must be open on the PC; Premium is needed for playback control.

**Modes**
- **Adaptive** (default): 3 s probes at most 20 s apart cover the whole track (a chorus or a drop lasts longer than that, so at least one probe lands in it), then the rest of the per-track budget listens 18 s around the most intense ones.
- **Fixed excerpts**: N excerpts of L seconds, evenly spread.
- **Whole track**: full listening, identical to a file's analysis.

**Live screen**: intensity gauge, curve and sub-scores, parts heard, 8-dimension radar, spectrum and spectrogram, L/R meters and loudness, 17 measures with their trend, lyrics rating for the current track, the scan queue (scrolls inside its box, the page never moves) and the spread of scores by level. At the end of each track the excerpts kept in memory are analysed again as a whole (real positions in the track), then discarded.

**What is kept**: only the features, curves and list of excerpts heard, never the audio. Playback control and sound capture remain a grey area regarding Spotify's terms: this is a personal tool, not a service to distribute.

## Concert mode

A full-screen show for an **analysed track**, opened with **✦ Concert** in the track's details or the ✦ button on its library row (a track with an intensity curve that can be played here: a file imported in this session, or a Spotify capture while logged in with playback rights). It never uses the Live capture: a live capture lags behind the music, while an analysed track already has precise per-window measures.

- **Playback** goes through the library player (the Web Audio engine for a file, your Spotify app for a Spotify capture), from the detail's playhead if the track was playing. **Space** plays / pauses, **← →** move 5 s (**Shift** 15 s), click the strip at the bottom to jump, **F** toggles full screen, **Esc** closes (the track keeps playing, like closing its details). Leaving full screen keeps the show open in the window.
- **Driven by the stored analysis** at the playback position: the 6 s / 3 s-hop timeline is interpolated smoothly between windows for the window score (as the detail curve shows it) and its stage, the 8 sub-scores, the 5 band energies, the level, the attack rates and the folded tempo. The tempo gives a **beat clock** (kicks, bar accents), its bar grid anchored on the first drop.
- **Known in advance**: drops (a big rise of the intensity between windows, snapped to the section start) and section changes (Intro, Build-up, Peak, Break, Outro). Before a drop the show **builds tension** (the trails implode, the camera pushes in, colours drain, light rings converge, a countdown); on the drop a refracting shockwave, a flash, a camera kick and a title card. Each section brings a new camera angle and a palette shift. The HUD shows the title and artist, the window score with its stage, the time, what comes next, and the whole track's curve with sections, drops and the playhead.
- **Audio**: for a file, the engine's output is tapped (an AnalyserNode, zero latency since it is the source) for the real spectrum, waveform and kicks, and the beat clock phase-locks onto the kicks heard. A Spotify track has no audio in the page: the spectrum and waveform are synthesized from the band energies and the beat clock, and the position is checked against the Spotify app every few seconds.
- **Rendering**: WebGL2 (nebula / tunnel background, feedback trails, spectrum ring, GPU particles, bloom, camera, chromatic aberration), Canvas2D fallback (forced with `?concert2d`). The render scale adapts to keep the frame rate. Flashes never exceed 3 per second; with *reduce motion* the camera stays still and flashes are rarer and softer. The pure logic (timeline sampling, drops, beat clock, synthesized spectrum, onset detector, flash limiter) is in `src/ui/concert-logic.js`, tested in `tests/concert.test.mjs`.

## Rhythm tab: map maker

Pick a track imported in the session (or open it from its details with “Rhythm”). Notes are extracted automatically, grouped by instrument (NMF on the attack spectra), with an instruments × time matrix, playback (original, cues only, or an isolated lane), KPS and a strain-based difficulty, adjustable splitting settings, and manual split / merge of lanes. The map is saved in IndexedDB with the track. Details of the algorithm are in `src/rhythm/`; tests in `tests/rhythm.test.mjs`.

## Test bench and demo mode

- **Test bench**: synthetic tracks generated in a worker from a parametric groove (kick, snare, hats, bass, chords, arpeggio, noise, saturation, clipping, irregularity, level contrast). Each variable has min / mid / max versions where only it changes (tempo, brightness, pressure, harshness, noise, density, complexity, dynamics, key, mood, overall intensity), plus three sweeps and a track with a known structure. They go through the normal analysis, tagged “Test”, and a grid compares measured and expected values. The same suite runs in the Node tests.
- **Demo mode** (Live tab): a fake Spotify plays test bench tracks into a `MediaStream`, captured by the real capture chain, to try the whole live scan without an account or audio sharing.
