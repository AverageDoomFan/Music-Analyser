# Music Energy Analyzer

Web app 100 % navigateur qui analyse des fichiers audio **localement** et leur attribue un score d'intensité perceptive de 0 à 100, pour construire une playlist allant du plus calme au plus extrême :

```
CALME → ÉNERGIQUE → INTENSE → AGRESSIF → EXTRÊME → BRUITISTE
```

Le score est un outil pratique de classement perceptif, **pas une mesure scientifique**. Aucune règle par genre : tout est déduit de caractéristiques audio.

## Utilisation

1. Dépose des fichiers (MP3, WAV, OGG, FLAC, M4A… selon le navigateur) ou un dossier entier.
2. L'analyse tourne en arrière-plan (Web Workers) ; les résultats sont mis en cache dans IndexedDB.
3. Ouvre un morceau pour voir **pourquoi** il a ce score (sous-scores, fiabilité, caractéristiques brutes).
4. « Le score ne correspond pas » → quelques questions ciblées, aperçu ancien/nouveau score, accepter ou annuler.
5. Onglet **Progression** → « Créer une progression », export M3U / texte.
6. Paramètres → pondérations, apprentissage à partir des corrections, export/import JSON, effacement des données.

Les fichiers audio ne sont jamais envoyés à un serveur. Ils ne sont pas non plus stockés : seules les caractéristiques extraites le sont. La lecture et la réanalyse audio sont donc possibles pour les fichiers importés pendant la session ; un fichier réimporté plus tard est reconnu par son empreinte SHA-256 et n'est pas réanalysé.

## Lancer en local

Aucune dépendance, aucun build :

```sh
python3 -m http.server 8000   # ou n'importe quel serveur statique
# puis http://localhost:8000
```

(Un serveur est nécessaire : les modules ES et les workers ne se chargent pas en `file://`.)

Tests (Node ≥ 20) : `npm test` — extraction de caractéristiques et ordre de scores sur des signaux synthétiques, corrections, versioning, export/import, progression.

## Déploiement GitHub Pages

- **Option A** : Settings → Pages → Source « GitHub Actions ». Le workflow `.github/workflows/pages.yml` lance les tests puis déploie à chaque push sur `main`.
- **Option B** : Settings → Pages → « Deploy from a branch », branche `main`, dossier `/ (root)`. Le site est servi tel quel.

## Architecture

```
index.html, styles.css
src/
  config.js                 ALGORITHM_VERSION, FEATURE_VERSION, pondérations, calibration, paliers
  audio/
    sources.js              AudioSource → LocalFileSource, YouTubeSource (interface seulement)
    decoder.js              décodage Web Audio → mono 44,1 kHz + mesure du clipping par canal
    fft.js                  FFT radix-2
    features.js             extraction des caractéristiques brutes (fonction pure, testable en Node)
    features.worker.js      exécution dans un Web Worker
    analyzer.js             file d'attente, pool de workers, repli sur le thread principal
  scoring/
    model.js                caractéristiques → 8 sous-scores → score 0-100
    index.js                modèle actif (point de remplacement du modèle)
    correction.js           questions, sélection des questions pertinentes, application des réponses
    learning.js             ajustement des pondérations globales à partir des corrections
  core/track.js             cycle de vie d'un morceau (auto / correction / manuel, historique, re-scoring)
  storage/db.js             IndexedDB (tracks, settings)
  storage/backup.js         export / import JSON avec fusion sans perte de corrections
  playlist/progression.js   algorithme de progression + export M3U / texte
  app/                      état et cas d'usage (contrôleur)
  ui/                       bibliothèque, détail, correction, paramètres, progression, graphiques
```

Le scoring, le stockage, l'import audio et l'interface sont indépendants : un nouveau modèle n'a qu'à exposer `computeSubscores`, `computeIntensity` et `scoreFeatures` et à être branché dans `src/scoring/index.js`.

### Caractéristiques extraites

- **Temporelles** : BPM (autocorrélation de l'enveloppe d'onsets + fiabilité), onsets/s, régularité rythmique, RMS (moyenne, écart-type), silences.
- **Spectrales** : centroïde, largeur de bande, rolloff 85 %, flux (moyenne, écart-type), planéité, zero crossing rate, crête spectrale, remplissage spectral, énergie par bandes (sub, basses, bas-médiums, haut-médiums, aigus) et ratios graves/médiums/aigus.
- **Générales** : loudness approximative type BS.1770 (LUFS, filtre K, gating), plage dynamique (type LRA), crest factor, pic, clipping (plateaux de ≥ 3 échantillons au pic), force des transitoires.

Les fichiers de plus de 12 minutes sont analysés sur 12 extraits de 45 s répartis sur toute la durée.

### Score

Huit sous-scores 0-100, chacun mélange explicite de composantes normalisées (visibles dans l'infobulle du détail) :

| Dimension | Principalement |
|---|---|
| Énergie | loudness, mouvement spectral, dynamique resserrée, attaques |
| Tempo | onsets/s, BPM pondéré par sa fiabilité (un BPM élevé seul ne suffit pas) |
| Densité | remplissage spectral, largeur de bande, attaques, peu de silences |
| Brillance | centroïde, rolloff, énergie > 2 kHz |
| Dureté | planéité, aigus, flux, transitoires, clipping, saturation |
| Volume | loudness, compression |
| Complexité | variabilité spectrale et rythmique |
| Bruit | planéité forte, spectre rempli, absence de pics tonals, clipping, écrasement |

Score = moyenne pondérée des sept premières dimensions, puis poussée « bruit/extrême » vers 100 qui n'agit que si le morceau est déjà intense (un bruit doux n'est pas « extrême »), puis calibration par morceaux (`CALIBRATION` dans `config.js`). Pondérations modifiables dans `config.js` (`DEFAULT_WEIGHTS`) ou dans l'interface. La calibration a été réglée sur des signaux synthétiques caricaturaux et sur des plages typiques de musique réelle : c'est un point de départ, les corrections et l'apprentissage des pondérations servent à l'adapter à ton oreille.

Chaque sous-score a une **fiabilité** (cohérence de ses composantes ; pour le tempo, fiabilité du beat tracking). Les questions de correction ne portent que sur les dimensions qui peuvent expliquer l'écart et dont l'analyse est peu sûre ; la question sur le bruit est toujours posée en haut de l'échelle.

### Versioning et données conservées

Chaque morceau stocke : caractéristiques brutes, score automatique initial, score automatique courant, réponses de correction, sous-scores corrigés, score corrigé, score manuel, score final, historique horodaté, versions de l'algorithme et de l'extraction.

- Changement de `ALGORITHM_VERSION` → au chargement, tous les scores sont recalculés **depuis les caractéristiques en cache**, sans relire l'audio, et les réponses de correction sont réappliquées.
- Changement de `FEATURE_VERSION` → les scores restent, les morceaux sont marqués « réanalyse conseillée ».

### YouTube

`YouTubeSource` définit l'interface (identité par id de vidéo, `getArrayBuffer()` délégué à un « provider »). Aucun provider n'est fourni : une page statique ne doit pas contourner les restrictions de YouTube (CORS, conditions d'utilisation). L'interface affiche « Analyse YouTube : nécessite un service/outil compatible. » Un service légitime pourra être branché plus tard sans toucher au reste du pipeline.
