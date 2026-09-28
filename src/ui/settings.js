// Settings dialog: model weights, learning from corrections, backup, reset.

import { ALGORITHM_VERSION, FEATURE_VERSION, DEFAULT_WEIGHTS, DIMENSIONS, AGGREGATIONS } from "../config.js";
import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { toast } from "./toast.js";

const dialog = () => document.getElementById("settings-dialog");
let draft = null;
let proposal = null;
let lyricsLookup = false;
let ess = { models: [], auto: false, status: "" };

export function initSettings() {
  document.getElementById("open-settings").addEventListener("click", open);
  const d = dialog();
  d.addEventListener("input", (e) => {
    const key = e.target.dataset.weight;
    if (!key) return;
    draft[key] = Number(e.target.value);
    e.target.closest(".weight-row").querySelector("output").textContent = draft[key].toFixed(2);
    d.querySelector("[data-action=apply-weights]").disabled = false;
  });
  d.addEventListener("change", async (e) => {
    if (e.target.id === "ess-folder" && e.target.files.length) {
      ess.status = "Import des modèles…";
      render();
      try {
        const added = await ctl.importEssentiaModels(e.target.files);
        ess.models = await ctl.essentiaModels();
        ess.status = added.length ? `${added.length} modèle${added.length > 1 ? "s" : ""} importé${added.length > 1 ? "s" : ""} : ${added.map((m) => m.name).join(", ")}.${added.some((m) => !m.classes) ? " ⚠ Classes inconnues pour certains modèles : ajoute leur fichier .json de métadonnées dans le dossier." : ""}` : "Aucun dossier contenant un model.json trouvé.";
      } catch (err) {
        ess.status = `Échec : ${err.message}`;
      }
      e.target.value = "";
      render();
      return;
    }
    if (e.target.id === "ess-auto") {
      ess.auto = e.target.checked;
      await ctl.setEssentiaAuto(ess.auto);
      return;
    }
    if (e.target.id === "lyrics-lookup") {
      lyricsLookup = e.target.checked;
      await ctl.setLyricsLookup(lyricsLookup);
      toast(lyricsLookup ? "Recherche des paroles activée : les morceaux sont vérifiés en arrière-plan." : "Recherche des paroles désactivée.");
      return;
    }
    if (e.target.name === "aggregation") {
      await ctl.setAggregation(e.target.value);
      toast("Scores recalculés depuis les courbes en cache.");
      return;
    }
    if (e.target.id !== "import-json" || !e.target.files[0]) return;
    try {
      const { count, weights, aggregation } = await ctl.importDatabase(e.target.files[0]);
      toast(`${count} morceaux importés / fusionnés.`);
      if (weights && confirm("Le fichier contient aussi des pondérations. Les appliquer ?")) {
        await ctl.setWeights({ ...DEFAULT_WEIGHTS, ...weights });
        draft = { ...state.weights };
        render();
      }
      if (aggregation && aggregation !== state.aggregation && confirm("Le fichier utilise une autre méthode de calcul du score. L'appliquer ?")) {
        await ctl.setAggregation(aggregation);
        render();
      }
    } catch (err) {
      toast(err.message, "error");
    }
    e.target.value = "";
  });
  d.addEventListener("click", async (e) => {
    if (e.target === d) return d.close();
    const action = e.target.closest("[data-action]")?.dataset.action;
    switch (action) {
      case "close": d.close(); break;
      case "apply-weights":
        await ctl.setWeights(draft);
        toast("Pondérations appliquées, scores recalculés.");
        render();
        break;
      case "reset-weights":
        draft = { ...DEFAULT_WEIGHTS };
        await ctl.setWeights(draft);
        toast("Pondérations par défaut rétablies.");
        render();
        break;
      case "learn":
        proposal = ctl.proposeWeights();
        render();
        break;
      case "learn-apply":
        await ctl.setWeights(proposal.weights);
        draft = { ...state.weights };
        proposal = null;
        toast("Pondérations ajustées à tes corrections.");
        render();
        break;
      case "learn-cancel": proposal = null; render(); break;
      case "export": {
        const n = await ctl.exportDatabase();
        toast(`${n} morceaux exportés.`);
        break;
      }
      case "import": d.querySelector("#import-json").click(); break;
      case "ess-import": d.querySelector("#ess-folder").click(); break;
      case "ess-remove": {
        const name = e.target.closest("[data-name]").dataset.name;
        await ctl.removeEssentiaModel(name);
        ess.models = await ctl.essentiaModels();
        render();
        break;
      }
      case "ess-test": {
        ess.status = "Chargement d'essentia.js et TensorFlow.js…";
        render();
        try {
          const { loadLibraries } = await import("../ml/essentia.js");
          await loadLibraries();
          ess.status = "Bibliothèques chargées : Essentia est prêt.";
        } catch (err) {
          ess.status = `Échec du chargement : ${err.message}`;
        }
        render();
        break;
      }
      case "ess-run-all": {
        const ids = [...state.records.values()].filter((r) => r.auto && state.files.has(r.id)).map((r) => r.id);
        if (!ids.length) { toast("Aucun fichier de cette session à analyser (Essentia a besoin de l'audio)."); break; }
        let n = 0;
        for (const id of ids) {
          ess.status = `Analyse Essentia ${++n}/${ids.length}…`;
          render();
          try { await ctl.runEssentia(id); } catch (err) { ess.status = `Échec : ${err.message}`; render(); break; }
        }
        if (n === ids.length) ess.status = `${ids.length} morceau${ids.length > 1 ? "x" : ""} analysé${ids.length > 1 ? "s" : ""} par Essentia.`;
        render();
        break;
      }
      case "clear":
        if (confirm("Effacer toutes les analyses, corrections et réglages stockés dans ce navigateur ? Pense à exporter d'abord.")) {
          await ctl.clearAllData();
          draft = { ...state.weights };
          toast("Données locales effacées.");
          render();
        }
        break;
    }
  });
}

async function open() {
  draft = { ...state.weights };
  proposal = null;
  lyricsLookup = await ctl.lyricsLookupEnabled();
  ess.models = await ctl.essentiaModels();
  ess.auto = await ctl.essentiaAuto();
  render();
  dialog().showModal();
}

function render() {
  const corrected = ctl.correctionSamples().length;
  dialog().innerHTML = `
    <div class="dialog-head"><h2>Paramètres</h2><button class="icon-btn" data-action="close" aria-label="Fermer">✕</button></div>
    <div class="dialog-body">
      <h3>Calcul du score à partir de la courbe</h3>
      <p class="muted small">Chaque morceau est analysé par fenêtres de quelques secondes : l'intensité et chaque sous-score forment une courbe. Choisis comment cette courbe devient un score (aussi disponible au-dessus de la bibliothèque).</p>
      <div class="agg-options">${AGGREGATIONS.map((a) => `
        <label><input type="radio" name="aggregation" value="${a.key}" ${state.aggregation === a.key ? "checked" : ""}> <strong>${a.label}</strong><small>${a.hint}</small></label>`).join("")}
      </div>

      <h3>Pondérations du score d'intensité</h3>
      <p class="muted small">Importance relative de chaque dimension. « Bruit » agit comme une poussée vers 100 réservée aux morceaux déjà intenses. Les scores sont recalculés depuis le cache, sans relire l'audio.</p>
      <div class="weights">${DIMENSIONS.map((dim) => `
        <label class="weight-row" title="${dim.hint}">
          <span>${dim.label}</span>
          <input type="range" min="0" max="3" step="0.05" value="${draft[dim.key]}" data-weight="${dim.key}">
          <output>${Number(draft[dim.key]).toFixed(2)}</output>
        </label>`).join("")}
      </div>
      <div class="settings-actions">
        <button class="btn primary" data-action="apply-weights" disabled>Appliquer</button>
        <button class="btn" data-action="reset-weights">Valeurs par défaut</button>
      </div>

      <h3>Apprendre de mes corrections</h3>
      <p class="muted small">Ajuste les pondérations globales pour que le score automatique se rapproche de tes corrections (${corrected} morceau${corrected > 1 ? "x" : ""} corrigé${corrected > 1 ? "s" : ""}).</p>
      ${proposal ? proposalHtml() : `<button class="btn" data-action="learn" ${corrected < 3 ? "disabled title='Il faut au moins 3 morceaux corrigés'" : ""}>Proposer des pondérations</button>`}

      <h3>Paroles</h3>
      <label class="inline"><input type="checkbox" id="lyrics-lookup" ${lyricsLookup ? "checked" : ""}> Chercher automatiquement les paroles sur LRCLIB</label>
      <p class="muted small">LRCLIB (lrclib.net) est une base de paroles ouverte. L'app lui envoie seulement l'artiste et le titre, pour savoir si un morceau est chanté ou instrumental et proposer une ambiance d'après les mots. Les paroles ne sont jamais conservées, et tu confirmes toujours la note. Sans cette option, la recherche reste possible titre par titre depuis la fiche d'un morceau.</p>

      <h3>Modèles Essentia (IA, optionnel)</h3>
      <p class="muted small">Des modèles pré-entraînés (MTG, Universitat Pompeu Fabra) proposent un genre, la présence de voix, des humeurs et la dansabilité. Tout tourne dans ton navigateur ; les résultats sont des <b>suggestions que tu peux corriger</b> dans la fiche d'un morceau (ton choix prime toujours). Essentia a besoin de l'audio : fichiers importés pendant la session, ou titres captés en direct.</p>
      <ol class="small muted ess-steps">
        <li>Sur <a href="https://essentia.upf.edu/models.html" target="_blank" rel="noopener">essentia.upf.edu/models</a>, télécharge des classifieurs <b>MusiCNN (msd)</b> au format <b>TensorFlow.js</b> (tfjs) : par exemple genre_dortmund, genre_electronic, voice_instrumental, mood_happy, mood_sad, mood_aggressive, mood_relaxed, danceability. Garde aussi le fichier .json de métadonnées de chaque modèle.</li>
        <li>Décompresse-les dans un dossier (un sous-dossier par modèle, avec model.json et ses fichiers .bin).</li>
        <li>Clique « Importer un dossier de modèles » : ils sont copiés dans le navigateur, une seule fois.</li>
      </ol>
      <div class="settings-actions">
        <button class="btn" data-action="ess-import">Importer un dossier de modèles</button>
        <input type="file" id="ess-folder" webkitdirectory multiple hidden>
        <button class="btn" data-action="ess-test">Tester le chargement</button>
        <button class="btn" data-action="ess-run-all" ${ess.models.length ? "" : "disabled"}>Analyser les fichiers de la session</button>
      </div>
      <label class="inline small"><input type="checkbox" id="ess-auto" ${ess.auto ? "checked" : ""}> Analyser automatiquement chaque nouveau morceau</label>
      ${ess.models.length ? `<ul class="ess-models">${ess.models.map((m) => `<li data-name="${m.name}"><b>${m.name}</b> <span class="muted small">${m.kind}${m.classes ? ` · ${m.classes.length} classes${m.classesFromMetadata ? "" : " (liste par défaut)"}` : " · classes inconnues"}</span> <button class="link-btn" data-action="ess-remove">retirer</button></li>`).join("")}</ul>` : `<p class="small muted">Aucun modèle importé.</p>`}
      ${ess.status ? `<p class="small">${ess.status}</p>` : ""}
      <p class="muted small">Licences : modèles CC BY-NC-ND 4.0 (usage non commercial), essentia.js AGPL-3.0. Les bibliothèques sont chargées depuis jsDelivr uniquement si tu utilises cette fonction.</p>

      <h3>Sauvegarde</h3>
      <div class="settings-actions">
        <button class="btn" data-action="export">Exporter la base (JSON)</button>
        <button class="btn" data-action="import">Importer un JSON</button>
        <input type="file" id="import-json" accept="application/json,.json" hidden>
      </div>
      <p class="muted small">Contient empreintes, noms, caractéristiques, scores, corrections et version de l'algorithme — jamais l'audio.</p>

      <h3>Données locales</h3>
      <button class="btn danger" data-action="clear">Effacer les données locales</button>
      <p class="muted small">Algorithme v${ALGORITHM_VERSION} · extraction v${FEATURE_VERSION} · ${state.records.size} morceaux en cache (IndexedDB).</p>
    </div>`;
}

function proposalHtml() {
  if (proposal.error) return `<p class="notice">${proposal.error}</p><button class="btn" data-action="learn-cancel">OK</button>`;
  const rows = DIMENSIONS.map((dim) => {
    const a = state.weights[dim.key], b = proposal.weights[dim.key];
    return `<li><span>${dim.label}</span><span>${a.toFixed(2)} → <strong>${b.toFixed(2)}</strong></span></li>`;
  }).join("");
  return `<div class="card">
    <ul class="delta-list">${rows}</ul>
    <p class="small">Écart moyen avec tes corrections : ${proposal.errorBefore.toFixed(1)} → <strong>${proposal.errorAfter.toFixed(1)}</strong> points (${proposal.n} morceaux).</p>
    <div class="settings-actions">
      <button class="btn primary" data-action="learn-apply">Appliquer</button>
      <button class="btn" data-action="learn-cancel">Annuler</button>
    </div>
  </div>`;
}
