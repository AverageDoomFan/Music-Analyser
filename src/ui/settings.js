// Settings dialog: model weights, learning from corrections, backup, reset.

import { ALGORITHM_VERSION, FEATURE_VERSION, DEFAULT_WEIGHTS, DIMENSIONS, AGGREGATIONS } from "../config.js";
import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { toast } from "./toast.js";

const dialog = () => document.getElementById("settings-dialog");
let draft = null;
let proposal = null;

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

function open() {
  draft = { ...state.weights };
  proposal = null;
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
