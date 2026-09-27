# Music Energy Analyzer

Deux outils dans une même web app 100 % navigateur :

- **Analyse** : score d'intensité perceptive, courbes dans le temps, playlists progressives.
- **Rythme** : découpage d'un morceau en notes pour créer une map de jeu de rythme (pistes par instrument, cue sounds, KPS, difficulté).

Web app 100 % navigateur qui analyse des fichiers audio **localement** et leur attribue un score d'intensité perceptive de 0 à 100, pour construire une playlist allant du plus calme au plus extrême :

```
CALME → ÉNERGIQUE → INTENSE → AGRESSIF → EXTRÊME → BRUITISTE
```

Le score est un outil pratique de classement perceptif, **pas une mesure scientifique**. Aucune règle par genre : tout est déduit de caractéristiques audio.

## Utilisation

1. Dépose des fichiers (MP3, WAV, OGG, FLAC, M4A… selon le navigateur) ou un dossier entier.
2. L'analyse tourne en arrière-plan (Web Workers) ; les résultats sont mis en cache dans IndexedDB.
3. Choisis comment la courbe d'intensité devient un score (moyenne des pics, moyenne, médiane, pic, perceptive) et trie par score, par statistique de courbe (début, fin, variabilité…), par nom ou par date.
4. Ouvre un morceau pour suivre ses **courbes dans le temps** (intensité, sous-scores, BPM, volume relatif, attaques…) et voir **pourquoi** il a ce score.
5. « Le score ne correspond pas » → quelques questions ciblées, aperçu ancien/nouveau score, accepter ou annuler.
6. Onglet **Progression** → « Créer une progression », export M3U / texte.
7. Paramètres → pondérations, apprentissage à partir des corrections, export/import JSON, effacement des données.

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

- **Option A** : Settings → Pages → Source « GitHub Actions ». Le workflow `.github/workflows/pages.yml` lance les tests puis déploie à chaque push sur `main`. Il ajoute aussi `?v=<commit>` à toutes les URL de modules (`scripts/stamp-version.mjs`) : après un déploiement, le navigateur ne peut pas mélanger une page neuve avec des modules restés en cache.
- **Option B** : Settings → Pages → « Deploy from a branch », branche `main`, dossier `/ (root)`. Le site est servi tel quel, sans tests ni versionnage : après une mise à jour, un rechargement forcé (Ctrl+Maj+R) peut être nécessaire.

## Architecture

```
index.html, styles.css
src/
  config.js                 ALGORITHM_VERSION, FEATURE_VERSION, pondérations, calibration, paliers
  audio/
    sources.js              AudioSource → LocalFileSource (point d'extension pour d'autres sources)
    decoder.js              décodage Web Audio → mono 44,1 kHz + clipping par canal
    fft.js                  FFT radix-2
    features.js             extraction des caractéristiques brutes (fonction pure, testable en Node)
    features.worker.js      exécution dans un Web Worker
    analyzer.js             file d'attente, pool de workers, repli sur le thread principal
  scoring/
    model.js                caractéristiques → 8 sous-scores → intensité, par fenêtre (courbes)
    aggregate.js            courbe → score (moyenne des pics, moyenne, médiane, pic, perceptive…)
    index.js                modèle actif (point de remplacement du modèle)
    correction.js           questions, sélection des questions pertinentes, application des réponses
    learning.js             ajustement des pondérations globales à partir des corrections
  core/track.js             cycle de vie d'un morceau (auto / correction / manuel, historique, re-scoring)
  storage/db.js             IndexedDB (tracks, settings)
  storage/backup.js         export / import JSON avec fusion sans perte de corrections
  playlist/progression.js   algorithme de progression + export M3U / texte
  rhythm/bands.js           bandes log + enveloppes d'attaque SuperFlux (worker : rhythm.worker.js)
  rhythm/notes.js           regroupement en pistes, détection des notes, suppression des échos
  rhythm/difficulty.js      KPS, difficulté (strain), statistiques de map
  rhythm/session.js         décodage partagé avec la lecture, cache des bandes pour la session
  audio/engine.js           lecture Web Audio : position, piste isolée, cues planifiés
  app/                      état et cas d'usage (contrôleur)
  ui/                       bibliothèque, détail, correction, paramètres, progression, graphiques
```

Le scoring, le stockage, l'import audio et l'interface sont indépendants : un nouveau modèle n'a qu'à exposer `computeSubscores`, `computeIntensity` et `scoreFeatures` et à être branché dans `src/scoring/index.js`.

### Caractéristiques extraites

- **Temporelles** : BPM (autocorrélation de l'enveloppe d'onsets + fiabilité), onsets/s, régularité rythmique, RMS (moyenne, écart-type), silences.
- **Spectrales** : centroïde, largeur de bande, rolloff 85 %, flux (moyenne, écart-type), planéité, zero crossing rate, crête spectrale, remplissage spectral, énergie par bandes (sub, basses, bas-médiums, haut-médiums, aigus) et ratios graves/médiums/aigus.
- **Grave / pression** : attaques dans le grave (flux positif 40–150 Hz), kicks nets par seconde, variation d'énergie du grave (grave soutenu ou pulsé), planéité 30–500 Hz (kick propre quasi sinusoïdal vs kick saturé).
- **Générales** : plage dynamique (type LRA), rapport pic/loudness (PLR), crest factor, clipping (plateaux de ≥ 3 échantillons au pic, relatif au pic), force des transitoires.

**Indépendance au volume** : chaque fichier est d'abord normalisé à -14 LUFS (loudness type BS.1770 : filtre K, gating). Le niveau de mastering d'un fichier ne change donc ni ses caractéristiques ni son score ; un même morceau exporté 12 dB plus bas obtient le même score (vérifié par les tests). La loudness d'origine est conservée à titre informatif uniquement.

Les fichiers de plus de 12 minutes sont analysés sur 12 extraits de 45 s répartis sur toute la durée.

## Onglet Rythme : créateur de map

Choisis un morceau importé pendant la session (ou ouvre-le depuis son détail avec « Rythme »). Les notes sont extraites automatiquement.

- **Matrice** pistes × temps. Le fond coloré montre l'énergie captée dans la plage de fréquences de chaque piste, les traits sont les notes (plus opaques = attaque plus forte). Les aigus sont en haut.
- **Lecture** : clic sur la matrice ou sur une courbe = lecture depuis ce point, re-clic = stop (Espace aussi). La tête de lecture avance et la vue la suit. Molette pour défiler, Ctrl + molette pour zoomer, clic sur la vue d'ensemble pour se déplacer.
- **Écouter** : la musique originale, les cues seuls, ou **une piste isolée** (filtrage passe-bande sur sa plage : 🎧 sur la piste) pour entendre ce qui a été extrait.
- **Cues** : chaque piste cochée joue un « tick » à une hauteur qui lui est propre sur chacune de ses notes, planifié à l'échantillon près par-dessus la musique.
- **Pistes cochées** = la map : elles définissent les cues, les **KPS** (notes par seconde, fenêtre glissante d'1 s) et la **difficulté** (★, modèle de « strain » : chaque note ajoute une charge qui décroît avec le temps, avec un bonus pour les accords et les changements de piste). Les deux sont affichées en courbes, avec des statistiques.
- **Paramètres de découpage** : nombre de pistes max, mode et seuil de regroupement, sensibilité, écart minimal entre notes, suppression des échos entre pistes, bandes par octave, plage de fréquences. **Correction manuelle** : ✂ scinde une piste, ⤓ la fusionne avec celle du dessous.
- La map (pistes, notes, paramètres, sélection) est enregistrée dans IndexedDB avec le morceau. L'export de map pour un jeu n'est pas encore prévu.

### Algorithme (`src/rhythm/`)

1. **Bandes** (`bands.js`) : STFT de 2048 points avec un pas de 256 (5,8 ms), puis bandes logarithmiques (6 par octave par défaut, de 30 Hz à 16 kHz). Pour chaque bande : niveau log et enveloppe d'attaque de type **SuperFlux** (montée par rapport au maximum de la bande et de ses voisines deux trames plus tôt, ce qui neutralise le vibrato et les glissandos). Tourne dans un Web Worker ; les paramètres légers sont ensuite recalculés instantanément, sans refaire ce passage.
2. **Regroupement en pistes** (`notes.js`) : les bandes voisines sont fusionnées tant qu'elles appartiennent au même son. Critère *timbre* : le rapport de force entre les deux groupes reste constant d'une attaque à l'autre (dispersion du log-rapport). Critère *rythme* : les attaques sont simultanées. Le mode *auto* prend le meilleur des deux, avec un seuil de coïncidence élevé. Les groupes presque silencieux sont absorbés. Une piste = une plage de fréquences contiguë.
3. **Notes** : pics de l'enveloppe de chaque piste au-dessus d'un seuil adaptatif (moyenne locale + k·écart-type sur ±0,3 s, plus un plancher relatif), avec un écart minimal. Le seuil suit la dynamique locale : attaques douces d'un orchestre comme 25+ notes/s d'un extratone.
4. **Un son = une piste** : parmi des notes simultanées (±30 ms) de pistes différentes, on compare la **montée d'amplitude perçue** (pondération A) de chaque piste. Les échos faibles disparaissent. Une note forte pour sa propre piste reste (une mélodie sur un kick). Deux pistes dont les notes coïncident presque toujours sont un même son dédoublé (son pitché qui change de bandes) : seule la plus forte garde la note.

Testé (`tests/rhythm.test.mjs`) sur un mix kick / charley / mélodie (chaque instrument dans sa piste, timing à ±5 ms), un extratone mélodique à 25 impulsions/s et des cordes legato avec vibrato.

### Courbes dans le temps

Rien n'est seulement moyenné. L'extraction se fait en deux passes :

1. une passe par trame STFT (~11,6 ms) qui stocke toutes les mesures ;
2. un résumé de ces trames, calculé une fois pour le morceau entier et une fois pour chaque **fenêtre de 6 s (pas de 3 s)**.

Chaque caractéristique (BPM local et sa fiabilité, attaques/s, volume relatif au morceau, grave, brillance, planéité, PLR…) devient ainsi une courbe, stockée en colonnes dans `features.timeline`. Le modèle calcule les sous-scores et l'intensité **de chaque fenêtre** : on obtient une courbe d'intensité et une courbe par sous-score.

**Du morceau à un score** (`src/scoring/aggregate.js`, réglable au-dessus de la bibliothèque ou dans Paramètres) :

| Méthode | Calcul |
|---|---|
| Moyenne des pics *(défaut)* | moyenne des 25 % de fenêtres les plus intenses (refrains, drops) |
| Moyenne | moyenne de toute la courbe |
| Médiane | niveau typique, insensible aux intros / outros / breaks |
| Pic | maximum de la courbe lissée sur ~12 s (un accident isolé ne compte pas) |
| Perceptive | moyenne de puissance (p = 3) : tout compte, les passages intenses davantage |

Statistiques supplémentaires pour le tri : **Début** (20 premières secondes), **Fin** (20 dernières), **Variabilité** (p90 − p10). Les sous-scores affichés utilisent la même méthode sur leurs propres courbes. Changer de méthode recalcule tout depuis le cache, sans relire l'audio.

Une correction décale toute la courbe : elle s'applique comme l'écart qu'elle provoque sur les sous-scores agrégés, ajouté au score agrégé. Le même décalage est appliqué aux statistiques pour le tri.

La **progression** utilise les courbes : le coût d'une transition tient compte de l'écart entre la **fin** d'un morceau et le **début** du suivant, en plus de l'écart de score et de la différence de timbre et de rythme.

### Score

Huit sous-scores 0-100, chacun mélange explicite de composantes normalisées (visibles dans l'infobulle du détail) :

| Dimension | Principalement |
|---|---|
| Énergie | loudness, mouvement spectral, dynamique resserrée, attaques |
| Tempo | onsets/s, BPM pondéré par sa fiabilité (un BPM élevé seul ne suffit pas) |
| Densité | remplissage spectral, largeur de bande, attaques, peu de silences |
| Brillance | centroïde, rolloff, énergie > 2 kHz |
| Dureté | planéité, aigus, flux, transitoires, clipping, saturation |
| Pression | kicks et basses : attaques dans le grave, poids, maintien et saturation du grave, écrasement (PLR) — indépendant du volume |
| Complexité | variabilité spectrale et rythmique |
| Bruit | planéité forte, spectre rempli, absence de pics tonals, clipping, écrasement |

Intensité d'une fenêtre = moyenne pondérée des sept premières dimensions, puis poussée « bruit/extrême » vers 100 qui n'agit que si le morceau est déjà intense (un bruit doux n'est pas « extrême »), puis calibration par morceaux (`CALIBRATION` dans `config.js`). Pondérations modifiables dans `config.js` (`DEFAULT_WEIGHTS`) ou dans l'interface. La calibration a été réglée sur des signaux synthétiques caricaturaux et sur des plages typiques de musique réelle : c'est un point de départ, les corrections et l'apprentissage des pondérations servent à l'adapter à ton oreille.

Chaque sous-score a une **fiabilité** (cohérence de ses composantes ; pour le tempo, fiabilité du beat tracking). Les questions de correction ne portent que sur les dimensions qui peuvent expliquer l'écart et dont l'analyse est peu sûre ; la question sur le bruit est toujours posée en haut de l'échelle.

### Versioning et données conservées

Chaque morceau stocke : caractéristiques brutes, score automatique initial, score automatique courant, réponses de correction, sous-scores corrigés, score corrigé, score manuel, score final, historique horodaté, versions de l'algorithme et de l'extraction.

- Changement de `ALGORITHM_VERSION` → au chargement, tous les scores sont recalculés **depuis les caractéristiques en cache**, sans relire l'audio, et les réponses de correction sont réappliquées.
- Changement de `FEATURE_VERSION` → les scores restent (les caractéristiques manquantes sont approximées), les morceaux sont marqués « réanalyse conseillée ». Passage 1.0 → 1.1 : normalisation de loudness et caractéristiques du grave. 1.1 → 1.2 : courbes dans le temps (sans réanalyse, un morceau n'a qu'une fenêtre, donc une courbe plate). Réimporter les fichiers pour en profiter ; les corrections sont conservées.
