// Track detail dialog: why a track got its score, manual edit, actions.

import { DIMENSIONS, stageFor, ALGORITHM_VERSION, ANALYSIS, AGGREGATIONS, CURVE_STATS } from "../config.js";
import { aggregate } from "../scoring/aggregate.js";
import { renderTimeline } from "./charts.js";
import { state, subscribe } from "../app/store.js";
import { statusOf, needsReanalysis } from "../core/track.js";
import * as ctl from "../app/controller.js";
import { formatDuration, formatSize, formatScore, formatDate, escapeHtml } from "../util/format.js";
import { questionById } from "../scoring/correction.js";
import { openCorrection } from "./correction.js";
import { toast } from "./toast.js";
import { player } from "./player.js";
import { openInRhythm } from "./rhythm.js";

const dialog = () => document.getElementById("detail-dialog");
let currentId = null;

export function initDetail() {
  const d = dialog();
  d.addEventListener("close", () => { currentId = null; });
  d.addEventListener("change", (e) => {
    if (e.target.id !== "timeline-series" || !currentId) return;
    seriesKey = e.target.value;
    renderTimelineSection(state.records.get(currentId));
  });
  d.addEventListener("click", async (e) => {
    if (e.target === d) return d.close(); // backdrop
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (!action || !currentId) return;
    const id = currentId;
    const r = state.records.get(id);
    switch (action) {
      case "close": d.close(); break;
      case "mismatch": openCorrection(id); break;
      case "play": player.toggle(id); break;
      case "rhythm": d.close(); openInRhythm(id); break;
      case "manual-save": {
        const v = Number(d.querySelector("#manual-score").value);
        if (!Number.isFinite(v) || v < 0 || v > 100) return toast("Score entre 0 et 100.", "error");
        await ctl.setManual(id, v);
        toast(`Score manuel : ${Math.round(v)}`);
        break;
      }
      case "manual-clear": await ctl.setManual(id, null); break;
      case "correction-clear": await ctl.removeCorrection(id); toast("Correction retirée."); break;
      case "recompute": await ctl.recompute(id); toast("Score recalculé depuis les caractéristiques en cache."); break;
      case "reanalyze":
        if (ctl.reanalyze(id)) toast("Réanalyse de l'audio lancée.");
        else toast("Fichier audio non disponible dans cette session : réimporte-le (il sera reconnu par son empreinte).", "error");
        break;
      case "delete":
        if (confirm(`Supprimer « ${r.name} » et ses corrections de la base locale ?`)) {
          await ctl.deleteTrack(id);
          d.close();
        }
        break;
    }
  });
  subscribe(() => { if (currentId && dialog().open) render(); });
  player.onChange(() => {
    if (!currentId || !dialog().open) return;
    const btn = dialog().querySelector("[data-action=play]");
    if (btn) btn.textContent = player.isPlaying(currentId) ? "Pause" : "Écouter";
    animatePlayhead(currentId);
  });
}

export function openDetail(id) {
  if (!state.records.has(id)) return;
  seriesKey = "intensity";
  currentId = id;
  render(true);
  if (!dialog().open) dialog().showModal();
}

let renderedKey = "";

function render(force = false) {
  const r = state.records.get(currentId);
  const d = dialog();
  if (!r) return d.close();
  // skip re-renders triggered by unrelated progress updates
  const key = `${r.id}|${r.updatedAt}|${state.files.has(r.id)}`;
  if (!force && key === renderedKey) return;
  const sameRecord = key === renderedKey;
  renderedKey = key;
  const focusedId = document.activeElement?.id;
  const manualValue = sameRecord ? d.querySelector("#manual-score")?.value : undefined;
  const status = statusOf(r);
  const auto = r.auto;
  const final = r.finalScore;
  const overrides = r.correction?.overrides ?? {};
  const canPlay = state.files.has(r.id);

  d.innerHTML = `
    <div class="dialog-head">
      <div>
        <h2>${escapeHtml(r.name)}</h2>
        <div class="muted small">${formatSize(r.size)} · ${formatDuration(r.duration)} · ajouté le ${formatDate(r.addedAt)}</div>
      </div>
      <button class="icon-btn" data-action="close" aria-label="Fermer">✕</button>
    </div>
    <div class="dialog-body">
      ${r.error && !auto ? `<div class="notice">⚠ ${escapeHtml(r.error)}</div>` : ""}
      ${needsReanalysis(r) ? `<div class="notice">Caractéristiques extraites par une ancienne version de l'analyse (${escapeHtml(r.featureVersion)}). Le score reste valable ; réimporte le fichier pour une réanalyse complète.</div>` : ""}
      ${auto ? scoreBlock(r, final) : `<p class="muted">Pas encore analysé.</p>`}
      ${auto?.curves ? `
        <h3>Évolution dans le temps</h3>
        <div class="card">
          <div class="timeline-head">
            <select id="timeline-series" aria-label="Courbe affichée">${seriesFor(r).map((sr) => `<option value="${sr.key}" ${sr.key === seriesKey ? "selected" : ""}>${sr.label}</option>`).join("")}</select>
            <span class="muted small">fenêtres de ${r.features?.timeline?.windowSeconds ?? "—"} s${r.features?.excerpted ? " · extraits répartis sur le morceau" : ""}${canPlay ? " · clic sur la courbe : lire à partir de là, re-clic : stop" : ""}</span>
          </div>
          <div id="timeline-chart"></div>
          <div class="agg-stats" id="timeline-stats"></div>
        </div>` : ""}
      ${auto ? `
        <h3>Pourquoi ce score ?</h3>
        <div class="subs">${DIMENSIONS.map((dim) => subRow(dim, auto, overrides)).join("")}</div>
        <p class="muted small">La barre montre le sous-score automatique (même méthode d'agrégation que le score, appliquée à sa courbe), le trait vertical la valeur corrigée. « fiab. » = cohérence des indicateurs qui composent la dimension.</p>
        ${correctionBlock(r)}
        <h3>Score manuel</h3>
        <div class="manual-edit">
          <input type="number" id="manual-score" min="0" max="100" step="1" value="${manualValue ?? (r.manual ? r.manual.score : Math.round(final))}" aria-label="Score manuel">
          <button class="btn small" data-action="manual-save">Appliquer</button>
          ${r.manual ? `<button class="btn small" data-action="manual-clear">Retirer le score manuel</button>` : ""}
          <span class="muted small">Prioritaire sur le score automatique et la correction.</span>
        </div>
        <h3>Caractéristiques audio</h3>
        ${featuresBlock(r.features)}
      ` : ""}
      ${r.history?.length ? `<h3>Historique</h3><ul class="history">${r.history.slice(-8).reverse().map((h) => `<li>${formatDate(h.at)} — ${escapeHtml(h.kind)} : ${formatScore(h.score)} <span class="muted">(v${escapeHtml(h.algorithmVersion)})</span></li>`).join("")}</ul>` : ""}
    </div>
    <div class="dialog-actions">
      <button class="btn danger" data-action="delete">Supprimer</button>
      <span class="spacer"></span>
      ${canPlay ? `<button class="btn" data-action="play">${player.isPlaying(r.id) ? "Pause" : "Écouter"}</button>` : ""}
      ${canPlay || r.rhythm ? `<button class="btn" data-action="rhythm" title="Découper en notes pour une map de jeu de rythme">Rythme</button>` : ""}
      ${r.features ? `<button class="btn" data-action="recompute" title="Recalcule depuis les caractéristiques en cache, sans relire l'audio">Recalculer</button>` : ""}
      <button class="btn" data-action="reanalyze" title="Relit et réanalyse le fichier audio">Réanalyser l'audio</button>
      ${auto ? `<button class="btn primary" data-action="mismatch">Le score ne correspond pas</button>` : ""}
    </div>`;
  if (auto?.curves) renderTimelineSection(r);
  if (focusedId) d.querySelector(`#${focusedId}`)?.focus();
}

// ---------- timeline ----------

let seriesKey = "intensity";

const db10 = (v) => 10 * Math.log10(Math.max(v, 1e-12));
const signed = (v, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

/** Curves available for a track: intensity, sub-scores, then raw features. */
function seriesFor(r) {
  const c = r.auto.curves;
  const tl = r.features?.timeline;
  const list = [
    { key: "intensity", label: "Intensité", values: c.intensity, score: true },
    ...DIMENSIONS.map((d) => ({ key: `sub:${d.key}`, label: `Sous-score · ${d.label}`, values: c.subscores[d.key], score: true })),
  ];
  if (tl?.series) {
    const sr = tl.series;
    list.push(
      // BPM only where the beat is reliable enough
      { key: "bpm", label: "BPM (si fiable)", values: sr.bpm.map((v, i) => (v && sr.bpmConfidence[i] >= 0.3 ? v : null)), format: (v) => v.toFixed(0) },
      { key: "loudnessRel", label: "Volume relatif au morceau (LU)", values: sr.loudnessRel, format: (v) => signed(v) },
      { key: "onsetRate", label: "Attaques / s", values: sr.onsetRate, format: (v) => v.toFixed(1) },
      { key: "lowPulse", label: "Attaques dans le grave", values: sr.lowPulse, format: (v) => v.toFixed(3) },
      { key: "bassRatio", label: "Poids du grave (%)", values: sr.bassRatio.map((v) => v * 100), format: (v) => v.toFixed(0) },
      { key: "centroidMean", label: "Brillance · centroïde (Hz)", values: sr.centroidMean, format: (v) => v.toFixed(0) },
      { key: "flatnessMedian", label: "Planéité spectrale (dB)", values: sr.flatnessMedian.map(db10), format: (v) => v.toFixed(1) },
      { key: "plrDb", label: "Pic / loudness (dB)", values: sr.plrDb, format: (v) => v.toFixed(1) },
    );
  }
  return list;
}

function renderTimelineSection(r) {
  const d = dialog();
  const host = d.querySelector("#timeline-chart");
  if (!host || !r?.auto?.curves) return;
  const list = seriesFor(r);
  const sr = list.find((x) => x.key === seriesKey) ?? list[0];
  const times = r.auto.curves.times;
  const fmt = sr.format ?? ((v) => v.toFixed(0));
  const agg = r.auto.aggregation ?? state.aggregation;
  const aggLabel = AGGREGATIONS.find((a) => a.key === agg)?.label ?? agg;
  renderTimeline(host, {
    times,
    values: sr.values,
    min: sr.score ? 0 : undefined,
    max: sr.score ? 100 : undefined,
    format: fmt,
    bands: sr.key === "intensity",
    ref: sr.key === "intensity" ? r.auto.score : undefined,
    refLabel: sr.key === "intensity" ? `score auto · ${aggLabel}` : undefined,
    duration: r.duration ?? undefined,
    onSeek: state.files.has(r.id) ? (t) => {
      if (player.isPlaying(r.id)) player.stop();
      else player.playAt(r.id, t);
    } : undefined,
  });
  animatePlayhead(r.id);
  const keys = [...AGGREGATIONS.map((a) => a.key).filter((k) => sr.score || k !== "perceptual"), ...CURVE_STATS.map((c) => c.key)];
  const label = (k) => AGGREGATIONS.find((a) => a.key === k)?.label ?? CURVE_STATS.find((c) => c.key === k)?.label ?? k;
  const values = sr.values.map((v) => (v == null ? NaN : v));
  d.querySelector("#timeline-stats").innerHTML = values.some(Number.isFinite)
    ? keys.map((k) => `<div class="${sr.score && k === agg ? "active" : ""}" title="${escapeHtml(AGGREGATIONS.find((a) => a.key === k)?.hint ?? CURVE_STATS.find((c) => c.key === k)?.hint ?? "")}"><span>${label(k)}</span><b>${fmt(aggregate(values, k, times))}</b></div>`).join("")
    : `<p class="muted small">Pas de valeur fiable sur ce morceau.</p>`;
}

let rafId = 0;
/** Moves the timeline playhead while this track plays. */
function animatePlayhead(id) {
  cancelAnimationFrame(rafId);
  const step = () => {
    const host = dialog().querySelector("#timeline-chart");
    if (!host?.setPlayhead || currentId !== id) return;
    host.setPlayhead(player.isPlaying(id) || player.position(id) ? player.position(id) : null);
    if (player.isPlaying(id)) rafId = requestAnimationFrame(step);
  };
  step();
}

function scoreBlock(r, final) {
  const auto = r.auto.score;
  const showGhost = Math.round(auto) !== Math.round(final);
  return `
    <div class="score-head">
      <span class="big-score">${formatScore(final)}</span>
      <span><strong>${stageFor(final).label}</strong><br><span class="muted small">${statusOf(r) === "corrected" ? `automatique : ${formatScore(auto)}` : "score automatique"} · ${escapeHtml(AGGREGATIONS.find((a) => a.key === r.auto.aggregation)?.label ?? "")} de la courbe · algorithme v${escapeHtml(r.auto.algorithmVersion)}</span></span>
    </div>
    <div class="intensity" aria-hidden="true">
      <div class="intensity-scale">
        ${showGhost ? `<span class="intensity-marker ghost" style="left:${auto}%" title="Automatique"></span>` : ""}
        <span class="intensity-marker" style="left:${final}%"></span>
      </div>
      <div class="intensity-ends"><span>0 · calme</span><span>100 · extrême / bruitiste</span></div>
    </div>`;
}

function subRow(dim, auto, overrides) {
  const v = auto.subscores[dim.key] ?? 0;
  const conf = auto.confidences?.[dim.key];
  const ov = overrides[dim.key];
  const parts = auto.explain?.[dim.key] ?? [];
  const tip = [dim.hint, ...parts.map((p) => `${p.label} : ${Math.round(p.value * 100)}`)].join("\n");
  return `<div class="sub-row" title="${escapeHtml(tip)}">
    <span>${dim.label}</span>
    <span class="sub-bar" role="img" aria-label="${dim.label} ${Math.round(v)} sur 100${ov != null ? `, corrigé à ${Math.round(ov)}` : ""}"><i style="width:${v}%"></i>${ov != null ? `<span class="override" style="left:calc(${ov}% - 1px)"></span>` : ""}</span>
    <span class="num">${Math.round(ov ?? v)}</span>
    <span class="conf">${conf != null ? `fiab. ${Math.round(conf * 100)}%` : ""}</span>
  </div>`;
}

function correctionBlock(r) {
  const c = r.correction;
  if (!c) return "";
  const answers = Object.entries(c.answers).map(([qid, idx]) => {
    const q = questionById(qid);
    return q ? `<li><span>${escapeHtml(q.text)}</span><strong>${escapeHtml(q.options[idx])}</strong></li>` : "";
  }).join("");
  return `<h3>Correction utilisateur</h3>
    <ul class="delta-list">${answers}</ul>
    <p class="small">Score automatique ${formatScore(c.previousScore)} → corrigé ${formatScore(c.score)}
      <span class="muted">(v${escapeHtml(c.algorithmVersion)}${c.algorithmVersion !== ALGORITHM_VERSION ? ", sera réappliquée" : ""})</span>
      · <button class="link-btn" data-action="correction-clear">retirer la correction</button></p>`;
}

function featuresBlock(f) {
  if (!f) return "";
  const n = (v, d = 0, unit = "") => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${unit}`);
  const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)} %`);
  const items = [
    ["BPM estimé", f.bpm ? `${n(f.bpm)} (fiab. ${Math.round(f.bpmConfidence * 100)} %)` : "—"],
    ["Onsets / s", n(f.onsetRate, 1)],
    ["Loudness du fichier*", n(f.sourceLoudnessLufs ?? f.loudnessLufs, 1, " LUFS")],
    ["Plage dynamique", n(f.loudnessRange, 1, " LU")],
    ["Crest factor", n(f.crestDb, 1, " dB")],
    ["Pic / loudness (PLR)", n(f.plrDb, 1, " dB")],
    ["Pic", n(f.channelPeakDb, 1, " dBFS")],
    ["Attaques dans le grave", n(f.lowPulse, 3)],
    ["Kicks nets / s", n(f.kickRate, 1)],
    ["Variation du grave", n(f.lowBandDbStd, 1, " dB")],
    ["Planéité du grave", f.lowFlatnessMedian != null ? n(10 * Math.log10(Math.max(f.lowFlatnessMedian, 1e-12)), 1, " dB") : "—"],
    ["Clipping", pct(f.clippingRatio)],
    ["Centroïde", n(f.centroidMean, 0, " Hz")],
    ["Largeur de bande", n(f.bandwidthMean, 0, " Hz")],
    ["Rolloff 85 %", n(f.rolloffMean, 0, " Hz")],
    ["Planéité", n(10 * Math.log10(Math.max(f.flatnessMedian, 1e-12)), 1, " dB")],
    ["Flux spectral", n(f.fluxMean, 3)],
    ["Zero crossing", n(f.zcrMean, 3)],
    ["Remplissage spectral", pct(f.spectralFill)],
    ["Graves / médiums / aigus", `${pct(f.bassRatio)} / ${pct(f.midRatio)} / ${pct(f.highRatio)}`],
    ["Silences", pct(f.silenceRatio)],
    ["Durée analysée", `${formatDuration(f.analyzedSeconds)}${f.excerpted ? " (extraits)" : ""}`],
  ];
  return `<div class="features">${items.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join("")}</div>
    <p class="muted small">* Informatif seulement : chaque fichier est normalisé à ${ANALYSIS.referenceLufs} LUFS avant l'analyse, son volume n'influence pas le score.</p>`;
}
