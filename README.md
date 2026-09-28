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

L'onglet **Accueil** présente les parcours possibles et l'état de l'application. Le guide détaillé est dans **[guide.html](guide.html)** (lien « Guide » dans l'application).

1. Dépose des fichiers (MP3, WAV, OGG, FLAC, M4A… selon le navigateur) ou un dossier entier.
2. L'analyse tourne en arrière-plan (Web Workers) ; les résultats sont mis en cache dans IndexedDB.
3. Choisis comment la courbe d'intensité devient un score (moyenne des pics, moyenne, médiane, pic, perceptive) et trie par score, par statistique de courbe (début, fin, variabilité…), par nom ou par date.
4. Ouvre un morceau pour suivre ses **courbes dans le temps** (intensité, sous-scores, BPM, volume relatif, attaques…) et voir **pourquoi** il a ce score.
5. « Le score ne correspond pas » → quelques questions ciblées, aperçu ancien/nouveau score, accepter ou annuler.
6. Onglet **Progression** → « Créer une progression », export M3U / texte.
7. Onglet **Set** → dessine la courbe d'intensité voulue, l'app choisit et ordonne les morceaux (voir plus bas).
8. **Paroles** et **Duels** (bibliothèque) → ajuste la perception à ton ressenti.
9. Paramètres → pondérations, apprentissage à partir des corrections, recherche de paroles, export/import JSON, effacement des données.

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
  rhythm/notes.js           attaques, spectres d'attaque, NMF → instruments, notes, fusion / scission
  rhythm/difficulty.js      KPS, difficulté (strain), statistiques de map
  rhythm/session.js         décodage partagé avec la lecture, cache des bandes pour la session
  audio/engine.js           lecture Web Audio : position, piste isolée, cues planifiés
  spotify/                  PKCE, API (playlists, contrôle de lecture), association fichiers ↔ titres
  live/capture.js           capture audio système / entrée audio (AudioWorklet, rééchantillonnage 44,1 kHz)
  live/scanner.js           scan d'une playlist : pilotage Spotify, extraits, analyse live et finale
  live/plan.js              modes (entier, extraits fixes, adaptatif : sondes puis écoute ciblée)
  live/meter.js             loudness BS.1770 en continu (momentanée, court terme, intégrée, LRA)
  audio/music.js            tonalité (chroma, Krumhansl), Camelot, MFCC, structure (auto-similarité)
  scoring/describe.js       tonalité / tempo de début et de fin, ambiance, effet des paroles
  scoring/similarity.js     empreinte de timbre, morceaux proches, groupes (k-means)
  playlist/set.js           générateur de set (courbe cible, transitions, contraintes), découpage
  util/lyrics.js            recherche LRCLIB optionnelle, suggestion d'ambiance
  scoring/genres.js         genres personnels hiérarchiques, suggestions par plus proches voisins
  testlab/synth.js          générateur paramétrique de morceaux de test (worker : testlab.worker.js)
  testlab/suite.js          banc d'essai : min / moyen / max par variable, balayages, évaluation
  live/demo.js              mode démo du scan en direct (faux Spotify → MediaStream)
  ml/essentia.js            modèles Essentia.js optionnels (genre, voix, humeurs, dansabilité)
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

## Musique : tonalité, tempo, structure, ambiance

Chaque morceau reçoit, en plus de son intensité :
- **Tonalité et mode** (ex. « Am · 8A » sur la roue Camelot), avec une fiabilité et les tonalités du début et de la fin. Calcul : chroma sur les pics d'une FFT de 8192 points (fréquence affinée par interpolation), puis corrélation avec les profils de Krumhansl-Kessler.
- **Tempo** : les estimations par fenêtre sont ramenées à l'octave du tempo global, avec la stabilité (part des fenêtres à ±4 %), l'octave alternative et le tempo du début et de la fin.
- **Structure** : découpage en sections par nouveauté de la matrice d'auto-similarité (timbre, harmonie, niveau). Les étiquettes (Intro, Montée, Pic, Break, Section, Outro) ne dépendent que du niveau relatif des sections, jamais d'un genre. La structure n'est calculée que si tout le morceau a été entendu d'un seul tenant.
- **Ambiance** (0 = sombre, 100 = lumineux), à partir du mode, de la brillance, du tempo, de la consonance et du caractère peu saturé du son. Combinée à l'intensité, elle donne une étiquette : Euphorique, Sombre / rageur, Serein, Mélancolique…
- **Empreinte de timbre** (MFCC et équilibre spectral), pour trouver les morceaux proches et former des groupes.

**Voix et paroles.** L'audio seul ne permet pas de détecter la voix de façon fiable sans modèle d'apprentissage. Les indices mesurés sont gardés, mais ne décident de rien. C'est donc l'utilisateur qui dit si un morceau est chanté, et quelle ambiance donnent ses paroles : joyeux, tendre, neutre, triste, sombre ou violent, avec trois niveaux. Cette note ajuste l'intensité perçue (par exemple, des paroles violentes à fond : +9) et l'ambiance. Un assistant (« Noter les paroles ») enchaîne les morceaux avec des raccourcis clavier.

En option (Paramètres), l'app interroge **LRCLIB** (lrclib.net, base de paroles ouverte) avec l'artiste et le titre seulement. Elle sait alors si un titre est instrumental et propose une ambiance d'après un lexique de mots, que tu confirmes. Les paroles ne sont jamais conservées. Cette recherche n'a pas pu être testée depuis l'environnement de développement (domaine bloqué) : à vérifier en ligne.

**Duels.** « Lequel est le plus intense ? » : l'app choisit des paires où le modèle hésite (scores proches, timbres différents). Les réponses ajustent les pondérations par un modèle de Bradley-Terry. Si aucune pondération n'explique mieux tes réponses, les réglages actuels sont gardés.

## Banc d'essai, mode démo

- **Banc d'essai** : des morceaux de synthèse sont générés dans un worker à partir d'un groove paramétrique (kick, caisse claire, charleston, basse, accords, arpège, bruit, saturation, écrêtage, irrégularité, contraste de niveau).
  - Chaque variable a trois versions (min, moyen, max) où elle seule change : tempo, brillance, pression, dureté, bruit, densité, complexité, dynamique, tonalité, ambiance, intensité globale.
  - Quatre morceaux évoluent dans le temps : trois balayages (tempo 80 → 170 BPM, brillance, arrivée du bruit) et un morceau à la structure connue.
  - Ils passent par l'analyse normale, marqués « Test ». Une grille compare le mesuré à l'attendu.
  - La même série tourne dans les tests Node (`tests/testlab.test.mjs`), donc toute régression d'une mesure fait échouer les tests.
- Ce banc a révélé et fait corriger deux défauts :
  - les tempos par fenêtre étaient ramenés à l'octave du tempo global, ce qui écrasait les vrais changements de tempo ; ils sont maintenant suivis de fenêtre en fenêtre ;
  - la complexité mesurait l'agitation plutôt que l'imprévisibilité (algorithme 1.4).
- **Mode démo** (onglet Direct) : un faux Spotify joue des morceaux du banc d'essai dans un `MediaStream`, capté par la vraie chaîne de capture. On peut ainsi essayer tout le scan en direct sans compte ni partage audio.

## Genres

- Étiquettes hiérarchiques propres à l'utilisateur (« Électro › Hardstyle › Rawstyle »). L'étiquette de l'utilisateur prime toujours.
- Les morceaux non étiquetés reçoivent une suggestion par plus proches voisins parmi les morceaux étiquetés. Le calcul utilise l'empreinte de timbre, l'intensité, l'ambiance, le tempo et le mode. Si les voisins ne s'accordent pas sur un sous-genre (au moins 55 % des votes), la suggestion remonte au genre parent.
- Un assistant d'étiquetage présente d'abord les morceaux les plus incertains.
- Les genres servent au filtre et au tri de la bibliothèque, et au découpage en playlists dans l'onglet Set.

**Modèles Essentia (optionnel).** Les classifieurs MusiCNN d'Essentia.js proposent genre, voix / instrumental, humeurs et dansabilité.
- **Code** : essentia.js 0.1.3 et TensorFlow.js 3.21 sont chargés depuis jsDelivr, seulement quand la fonction est utilisée.
- **Modèles** : au format TensorFlow.js, importés par l'utilisateur depuis un dossier (métadonnées `.json` avec les classes), puis gardés dans IndexedDB.
- **Calcul** : audio rééchantillonné à 16 kHz, au plus 60 s prises au milieu du morceau, moyenne des prédictions par tranche.
- **Résultats** : des suggestions corrigeables. La voix prédite ne remplace jamais une réponse de l'utilisateur.
- **Licences** : modèles CC BY-NC-ND 4.0 (usage non commercial), essentia.js AGPL-3.0.
- **Tests** : la chaîne a été testée dans Chromium avec les vraies bibliothèques et des modèles simulés. Les vrais modèles n'ont pas pu être téléchargés depuis l'environnement de développement.

## Onglet Set : générateur de set

- **Courbe cible** : préréglages (échauffement → pic → retour au calme, montée, vagues, plateau, fractionné, descente) ou courbe libre. On déplace les points, un clic en ajoute un, un double-clic le retire.
- **Sélection et ordre** : recuit simulé à partir d'une affectation par rangs (le k-ième morceau le plus calme va au k-ième créneau le plus calme de la courbe). Le coût combine :
  - l'écart à la courbe ;
  - les transitions : enchaînement d'intensité fin → début, tempo (demi et double tempo compatibles), compatibilité Camelot, timbre et ambiance, chacune avec un poids réglable ;
  - la durée visée et les contraintes.
- **Contraintes** : premier et dernier morceau, morceaux verrouillés 🔒 ou exclus ✕, jamais deux fois le même artiste d'affilée. La source est la bibliothèque ou une playlist Spotify importée.
- **Résultat** : note de fluidité de chaque transition (le détail au survol), écart à la courbe et transitions difficiles. Export M3U ou texte, ou création de la playlist sur Spotify, pour les titres captés en direct ou associés à un fichier.
- **Découper** une bibliothèque ou une playlist en N playlists, par intensité, par ambiance ou par groupe de timbre, puis les créer sur Spotify.

## Onglet Spotify : trier une de tes playlists

L'onglet importe la liste des titres d'une de tes playlists et l'associe à tes fichiers audio locaux (analysés dans l'app), puis crée sur ton compte une **nouvelle** playlist, privée, ordonnée du plus calme au plus intense. La playlist d'origine n'est jamais modifiée.

**Mise en place (une fois)**
1. Sur [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), crée une application. Depuis 2026, le compte propriétaire d'une application en mode développement doit être Premium. Ne mets pas « Spotify » dans son nom et coche *Web API*.
2. *Redirect URIs* : ajoute l'adresse affichée dans l'onglet, par exemple `https://averagedoomfan.github.io/Music-Analyser/`. Pour un test en local, ajoute aussi `http://127.0.0.1:8000/` : Spotify n'accepte plus `localhost`, seulement l'IP de bouclage.
3. *User Management* : ajoute l'e-mail de ton compte Spotify (mode développement : 5 comptes maximum).
4. Copie le **Client ID**, qui est public. Le *Client secret* ne sert pas et ne doit jamais être mis dans l'app.
5. Dans l'onglet Spotify : colle le Client ID, clique « Connecter mon compte Spotify », puis accepte les droits demandés.

**Utilisation** : choisis une playlist dont tu es propriétaire ou collaborateur (règle du mode développement), puis « Importer les titres ». Dépose ensuite tes fichiers dans la zone d'import.
- **Association automatique** : par ISRC lu dans les tags quand il existe, sinon par titre, artiste et durée. Les tags lus sont ID3 pour le MP3 et Vorbis pour le FLAC ; à défaut, le nom de fichier au format « Artiste - Titre ».
- **Correction** : une association se corrige ligne par ligne.
- **Création** : « Aperçu de l'ordre » puis « Créer la playlist sur Spotify ».
- **Suivi** : les playlists importées sont mémorisées. Un nouvel import affiche les titres ajoutés et retirés depuis le précédent, avec un raccourci pour scanner les nouveaux.
- **Carte** : chaque morceau analysé est placé selon son intensité et son ambiance, avec la moyenne. On peut **comparer** avec une autre playlist importée : points superposés, et tableau intensité, ambiance, étendue, tempo, tonalités et répartition par palier.

**Sécurité et vie privée**
- **Connexion** : OAuth 2.0 *Authorization Code + PKCE*, le flux prévu pour les applications sans serveur. Pas de secret, et un `state` protège contre les requêtes forgées.
- **Droits demandés** : lire tes playlists privées et collaboratives, créer et modifier des playlists, lire et piloter la lecture (onglet Direct). Rien d'autre.
- **Jeton** : il reste dans ce navigateur (localStorage) et n'est envoyé qu'à `accounts.spotify.com` et `api.spotify.com`.
- **Données conservées** : seule la liste de la dernière playlist importée et tes associations. « Déconnecter et effacer » supprime le jeton et ces données. Tu peux aussi révoquer l'accès sur [spotify.com/account/apps](https://www.spotify.com/account/apps).

**Cadre légal** (résumé, pas un avis juridique) : c'est un usage standard de l'API, la gestion de playlists pour son propre compte. Il reste dans les règles tant que :
- l'audio analysé est celui de **tes propres fichiers**, achetés ou copiés depuis une source licite (copie privée). L'app ne télécharge rien depuis Spotify, et ce serait interdit ;
- aucune donnée Spotify ne sert à entraîner un modèle d'IA, ni à produire des statistiques d'écoute (interdit par la *Developer Policy*). Ici, les métadonnées ne servent qu'à l'association et à la création de la playlist, et l'ajustement des pondérations n'utilise que tes corrections sur tes fichiers ;
- l'application ne se présente pas comme un produit Spotify : le contenu est attribué et ramène vers Spotify par des liens.


## Onglet Direct : analyser une playlist Spotify sans les fichiers

L'onglet Direct fait jouer chaque titre de la playlist importée sur **ton application Spotify** (contrôle de lecture de l'API), capte le son qui sort du PC et l'analyse en temps réel avec le même extracteur que pour les fichiers. Les titres analysés rejoignent la bibliothèque (source « Spotify », avec la part du morceau écoutée) et comptent pour la playlist triée de l'onglet Spotify.

**Capture (Windows)**
- **Audio système** : Chrome ou Edge, « Écran entier » + « Partager l'audio du système ». Le son doit rester audible et rien d'autre ne doit jouer.
- **Scan silencieux** : avec VB-Cable, envoie Spotify vers « CABLE Input » (Paramètres › Son › Mélangeur de volume), puis choisis l'entrée « CABLE Output » dans l'onglet.
- Dans Spotify, désactive « Normaliser le volume » et le fondu enchaîné. L'application Spotify doit être ouverte sur le PC ; Premium est requis pour le contrôle de lecture.
- Les connexions antérieures doivent être refaites une fois : l'onglet demande les droits `user-read-playback-state` et `user-modify-playback-state`.

**Modes**
- **Adaptatif** (par défaut) : des sondes de 3 s espacées d'au plus 20 s couvrent tout le morceau. Un refrain ou un drop dure plus longtemps que cet écart, donc au moins une sonde tombe dedans. Les sondes sont notées ensemble, puis le reste du budget par titre sert à écouter 18 s autour des plus intenses, en commençant un peu avant.
- **Extraits fixes** : N extraits de L secondes répartis régulièrement.
- **Morceau entier** : écoute complète, résultat identique à l'analyse d'un fichier.
- Un titre déjà capté dans un mode au moins aussi complet n'est pas réécouté. Les titres associés à un fichier local analysé peuvent être ignorés.

**Déroulement d'un extrait** : pause, attente du silence, lecture à la position voulue, puis le début de l'extrait est repéré dans le son (premier bloc de 10 ms au-dessus de -58 dBFS). Si le passage est silencieux, la position rapportée par Spotify sert de repère. Si Spotify joue un autre titre que celui demandé, le titre est marqué en erreur.

**En direct** : toutes les 3 s, une fenêtre de 6 s est analysée. Elle est normalisée avec la loudness du morceau entendue jusque-là (mesure BS.1770 en continu) et notée par le modèle. L'écran affiche :
- la jauge d'intensité, la courbe et les sous-scores, avec les sondes ;
- les parties du morceau écoutées ;
- le radar des 8 dimensions ;
- le spectre et le spectrogramme ;
- les vumètres L/R et la loudness momentanée, court terme, intégrée, la plage LRA et la crête ;
- 17 mesures avec leur évolution ;
- la file du scan et la répartition des scores par palier.

À la fin de chaque titre, les extraits gardés en mémoire sont réanalysés d'un bloc (positions réelles dans le morceau), puis effacés.

**Ce qui est conservé** : uniquement les caractéristiques, les courbes et la liste des extraits écoutés, jamais l'audio. Ces analyses ne servent qu'à trier ta propre playlist. Le contrôle de lecture et la capture du son restent une zone grise au regard des conditions de Spotify : c'est un outil d'usage personnel, pas un service à diffuser.

## Onglet Rythme : créateur de map

Choisis un morceau importé pendant la session (ou ouvre-le depuis son détail avec « Rythme »). Les notes sont extraites automatiquement.

- **Matrice** instruments × temps. Le fond coloré montre le niveau du spectre filtré par le gabarit de chaque instrument, les traits sont les notes (plus opaques = attaque plus forte). Les instruments les plus aigus sont en haut.
- **Lecture** : clic sur la matrice ou sur une courbe = lecture depuis ce point, re-clic = stop (Espace aussi). La tête de lecture avance et la vue la suit. Molette pour défiler, Ctrl + molette pour zoomer, clic sur la vue d'ensemble pour se déplacer.
- **Écouter** : la musique originale, les cues seuls, ou **une piste isolée** (filtrage passe-bande sur sa plage : 🎧 sur la piste) pour entendre ce qui a été extrait.
- **Cues** : chaque piste cochée joue un « tick » à une hauteur qui lui est propre sur chacune de ses notes, planifié à l'échantillon près par-dessus la musique.
- **Pistes cochées** = la map : elles définissent les cues, les **KPS** (notes par seconde, fenêtre glissante d'1 s) et la **difficulté** (★, modèle de « strain » : chaque note ajoute une charge qui décroît avec le temps, avec un bonus pour les accords et les changements de piste). Les deux sont affichées en courbes, avec des statistiques.
- **Paramètres de découpage** : nombre d'instruments (auto ou fixé), sensibilité, filtre des notes faibles, partage entre instruments, écart minimal entre notes, porte de silence, résolution (bandes par octave), plage de fréquences. **Correction manuelle** : ✂ scinde un instrument en deux, ⤓ le fusionne avec celui du dessous.
- La map (pistes, notes, paramètres, sélection) est enregistrée dans IndexedDB avec le morceau. L'export de map pour un jeu n'est pas encore prévu.

### Algorithme (`src/rhythm/`)

1. **Bandes** (`bands.js`) : STFT de 2048 points avec un pas de 256 (5,8 ms) sur le signal ramené à 44,1 kHz. Bandes logarithmiques au **quart de ton** (24 par octave), niveau log et enveloppe d'attaque de type SuperFlux :
   - la montée d'une bande est comparée au maximum de ses voisines, mais seulement si elles sont à moins d'un quart de ton. Ça neutralise le vibrato sans masquer une note jouée un demi-ton plus loin (gamme de piano) ;
   - la montée est pondérée par sa **soudaineté** (part de la montée faite dans les 2 dernières trames).

   Ce passage tourne dans un Web Worker ; les autres réglages se recalculent instantanément.
2. **Attaques** (`notes.js`) :
   - **enveloppes** : une pour tout le spectre et une par registre (< 200 Hz, 200 Hz–1 kHz, 1–4 kHz, > 4 kHz), pour qu'un charley discret ne soit pas masqué par la basse ;
   - **blanchiment par bande** : une bande ne compte qu'au-dessus de 2 × sa moyenne locale ;
   - **combinaison (Σ flux^⅓)³** : elle récompense les montées simultanées sur beaucoup de bandes (série harmonique d'une note, coup de batterie) par rapport aux battements entre partiels ;
   - **sélection** : un pic est une attaque si sa **proéminence** (montée depuis le creux qui le précède) atteint une part de l'échelle locale. C'est robuste aussi bien pour des attaques espacées que pour 25+ impulsions/s ;
   - **porte de silence** : aucune note là où le niveau est à plus de N dB (45 par défaut) sous le niveau fort du morceau, et l'échelle locale a un plancher. Pas de notes dans les silences, les fondus ou après la fin.
3. **Spectres d'attaque** : pour chaque attaque, la montée du niveau de chaque bande (ce qui est apparu dans le spectre), regroupée par quart d'octave.
4. **Instruments** : **NMF** (factorisation en matrices non négatives) de la matrice attaques × spectre, qui produit K gabarits spectraux (les instruments) et la part de chaque gabarit dans chaque attaque.
   - Les gabarits peuvent se chevaucher en fréquence (kick et basse, deux mains au piano).
   - Une attaque qui contient deux instruments (kick + charley) active les deux.
   - K est choisi automatiquement (coude de l'erreur de reconstruction) ou fixé.
   - Les pistes ne sont donc plus des plages de fréquences : la plage affichée n'est qu'un indicatif, celle où se trouve 80 % de l'énergie du gabarit.
5. **Notes** : une attaque devient une note de chaque instrument qui en porte une part significative. Une note trop faible pour sa piste (reste d'un autre son) est filtrée, et l'écart minimal est appliqué par piste.
6. **Édition** : ✂ refait une NMF à 2 composantes sur les attaques de la piste, ⤓ fusionne deux pistes.

Testé (`tests/rhythm.test.mjs`, signaux dans `tests/rhythm-fixtures.mjs`) :

| Cas | Résultat |
|---|---|
| Mix kick / charley / mélodie | kick et charley chacun dans sa piste, sans note en trop ; timing ±5 ms |
| Piano (gamme par demi-tons et tons + accords) | toutes les notes trouvées ; la main droite a sa propre piste |
| Extratone mélodique (16 puis 25 impulsions/s) | impulsions trouvées, aucune note pendant les silences |
| Cordes legato avec vibrato | une note par changement |

Limite connue : sur un piano très résonant (accords tenus, partiels qui battent), la piste grave reçoit encore des notes parasites. Baisser la sensibilité ou monter le filtre des notes faibles aide.

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
