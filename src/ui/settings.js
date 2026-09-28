// Settings dialog: language, model weights, learning from corrections,
// lyrics lookup, backup, diagnostic and reports, reset.

import { ALGORITHM_VERSION, FEATURE_VERSION, DEFAULT_WEIGHTS, DIMENSIONS, AGGREGATIONS } from "../config.js";
import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { t, tn, getLang, setLang, LANGUAGES } from "../i18n/index.js";
import { escapeHtml } from "../util/format.js";
import { toast } from "./toast.js";

const dialog = () => document.getElementById("settings-dialog");
let draft = null;
let proposal = null;
let lyricsLookup = false;
let reports = [];

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
    if (e.target.id === "language") return setLang(e.target.value);
    if (e.target.id === "lyrics-lookup") {
      lyricsLookup = e.target.checked;
      await ctl.setLyricsLookup(lyricsLookup);
      toast(lyricsLookup ? t("Lyrics lookup on: tracks are checked in the background.") : t("Lyrics lookup off."));
      return;
    }
    if (e.target.name === "aggregation") {
      await ctl.setAggregation(e.target.value);
      toast(t("Scores recomputed from the cached curves."));
      return;
    }
    if (e.target.id !== "import-json" || !e.target.files[0]) return;
    try {
      const { count, weights, aggregation } = await ctl.importDatabase(e.target.files[0]);
      toast(tn(count, "{n} track imported / merged.", "{n} tracks imported / merged."));
      if (weights && confirm(t("The file also holds weights. Apply them?"))) {
        await ctl.setWeights({ ...DEFAULT_WEIGHTS, ...weights });
        draft = { ...state.weights };
        render();
      }
      if (aggregation && aggregation !== state.aggregation && confirm(t("The file uses another way of computing the score. Apply it?"))) {
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
        toast(t("Weights applied, scores recomputed."));
        render();
        break;
      case "reset-weights":
        draft = { ...DEFAULT_WEIGHTS };
        await ctl.setWeights(draft);
        toast(t("Default weights restored."));
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
        toast(t("Weights fitted to your corrections."));
        render();
        break;
      case "learn-cancel": proposal = null; render(); break;
      case "export": {
        const n = await ctl.exportDatabase();
        toast(tn(n, "{n} track exported.", "{n} tracks exported."));
        break;
      }
      case "import": d.querySelector("#import-json").click(); break;
      case "diagnostic": {
        const n = await ctl.exportDiagnostic();
        toast(tn(n, "Diagnostic export: {n} track.", "Diagnostic export: {n} tracks."));
        break;
      }
      case "reports-export": {
        const n = await ctl.exportReports();
        toast(tn(n, "{n} report exported.", "{n} reports exported."));
        break;
      }
      case "reports-clear":
        if (!confirm(t("Delete the saved reports?"))) break;
        await ctl.clearReports();
        reports = [];
        render();
        break;
      case "clear":
        if (!confirm(t("Delete every local analysis, correction and setting of this app in this browser? Your audio files are not touched."))) break;
        await ctl.clearAllData();
        toast(t("Local data deleted."));
        d.close();
        break;
    }
  });
}

async function open() {
  draft = { ...state.weights };
  proposal = null;
  lyricsLookup = await ctl.lyricsLookupEnabled();
  reports = await ctl.getReports();
  render();
  dialog().showModal();
}

function render() {
  const corrected = ctl.correctionSamples().length;
  dialog().innerHTML = `
    <div class="dialog-head"><h2>${t("Settings")}</h2><button class="icon-btn" data-action="close" aria-label="${t("Close")}">✕</button></div>
    <div class="dialog-body">
      <h3>${t("Language")}</h3>
      <select id="language" aria-label="${t("Language")}">${LANGUAGES.map((l) => `<option value="${l.key}" ${l.key === getLang() ? "selected" : ""}>${l.label}</option>`).join("")}</select>

      <h3>${t("From the curve to the score")}</h3>
      <p class="muted small">${t("Each track is analysed in windows of a few seconds: intensity and every sub-score form a curve. Choose how that curve becomes a score (also available above the library).")}</p>
      <div class="agg-options">${AGGREGATIONS.map((a) => `
        <label><input type="radio" name="aggregation" value="${a.key}" ${state.aggregation === a.key ? "checked" : ""}> <strong>${a.label}</strong><small>${a.hint}</small></label>`).join("")}
      </div>

      <h3>${t("Intensity weights")}</h3>
      <p class="muted small">${t("Relative importance of each dimension. “Noise” is a push towards 100 for tracks that are already intense. Scores are recomputed from the cache, without reading the audio again.")}</p>
      <div class="weights">${DIMENSIONS.map((dim) => `
        <label class="weight-row" title="${escapeHtml(dim.hint)}">
          <span>${dim.label}</span>
          <input type="range" min="0" max="4" step="0.05" value="${draft[dim.key]}" data-weight="${dim.key}">
          <output>${Number(draft[dim.key]).toFixed(2)}</output>
        </label>`).join("")}
      </div>
      <div class="settings-actions">
        <button class="btn primary" data-action="apply-weights" disabled>${t("Apply")}</button>
        <button class="btn" data-action="reset-weights">${t("Defaults")}</button>
      </div>

      <h3>${t("Learn from my corrections")}</h3>
      <p class="muted small">${tn(corrected, "Fits the global weights so the automatic score gets closer to your corrections ({n} corrected track).", "Fits the global weights so the automatic score gets closer to your corrections ({n} corrected tracks).")}</p>
      ${proposal ? proposalHtml() : `<button class="btn" data-action="learn" ${corrected < 3 ? `disabled title="${t("At least 3 corrected tracks are needed.")}"` : ""}>${t("Propose weights")}</button>`}

      <h3>${t("Lyrics")}</h3>
      <label class="inline"><input type="checkbox" id="lyrics-lookup" ${lyricsLookup ? "checked" : ""}> ${t("Look up lyrics automatically on LRCLIB")}</label>
      <p class="muted small">${t("LRCLIB (lrclib.net) is an open lyrics database. The app only sends it the artist and title, to know whether a track is sung or instrumental and suggest a mood from the words. Lyrics are never kept, and you always confirm the rating. Without this option, the lookup stays available track by track from a track's details.")}</p>

      <h3>${t("Backup")}</h3>
      <div class="settings-actions">
        <button class="btn" data-action="export">${t("Export the database (JSON)")}</button>
        <button class="btn" data-action="import">${t("Import a JSON")}</button>
        <input type="file" id="import-json" accept="application/json,.json" hidden>
      </div>
      <p class="muted small">${t("Holds fingerprints, names, features, scores, corrections and the algorithm version — never the audio.")}</p>

      <h3>${t("Reports for analysis")}</h3>
      <p class="muted small">${t("From a track's details, “Report for analysis” saves everything the model knows about it (every measure and its curve, sub-scores, how they are built) with your comment and expected score. Export them and send the file to get the model fixed on those tracks. No audio, no file path.")}</p>
      ${reports.length ? `<ul class="report-list">${reports.slice(-8).reverse().map((r) => `<li><b>${escapeHtml(r.name)}</b> <span class="muted small">${Math.round(r.finalScore)}${r.expected != null ? ` → ${t("expected")} ${Math.round(r.expected)}` : ""}${r.comment ? ` · ${escapeHtml(r.comment.slice(0, 80))}` : ""}</span></li>`).join("")}</ul>` : ""}
      <div class="settings-actions">
        <button class="btn" data-action="reports-export" ${reports.length ? "" : "disabled"}>${tn(reports.length, "Export {n} report", "Export {n} reports")}</button>
        ${reports.length ? `<button class="btn" data-action="reports-clear">${t("Delete the reports")}</button>` : ""}
      </div>

      <h3>${t("Diagnostic export")}</h3>
      <p class="muted small">${t("A compact file to improve the model on your real library: for every track, its name, genres, scores, sub-scores, the measures they are made of, and your corrections, lyrics ratings and duels. No audio, no file path.")}</p>
      <div class="settings-actions"><button class="btn" data-action="diagnostic">${t("Export the diagnostic")}</button></div>

      <h3>${t("Local data")}</h3>
      <button class="btn danger" data-action="clear">${t("Delete local data")}</button>
      <p class="muted small">${t("Algorithm v{a} · extractor v{f} · {n} tracks cached (IndexedDB).", { a: ALGORITHM_VERSION, f: FEATURE_VERSION, n: state.records.size })}</p>
    </div>`;
}

function proposalHtml() {
  if (proposal.error) return `<p class="notice">${escapeHtml(proposal.error)}</p><button class="btn" data-action="learn-cancel">OK</button>`;
  const rows = DIMENSIONS.map((dim) => {
    const a = state.weights[dim.key], b = proposal.weights[dim.key];
    return `<li><span>${dim.label}</span><span>${a.toFixed(2)} → <strong>${b.toFixed(2)}</strong></span></li>`;
  }).join("");
  return `<div class="card">
    <ul class="delta-list">${rows}</ul>
    <p class="small">${t("Mean gap with your corrections: {a} → <strong>{b}</strong> points ({n} tracks).", { a: proposal.errorBefore.toFixed(1), b: proposal.errorAfter.toFixed(1), n: proposal.n })}</p>
    <div class="settings-actions">
      <button class="btn primary" data-action="learn-apply">${t("Apply")}</button>
      <button class="btn" data-action="learn-cancel">${t("Cancel")}</button>
    </div>
  </div>`;
}
