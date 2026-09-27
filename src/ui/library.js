// Library view: overview chart + filterable/sortable table.

import { STAGES, stageFor } from "../config.js";
import { state, notify } from "../app/store.js";
import { statusOf, needsReanalysis } from "../core/track.js";
import { formatDuration, formatSize, formatScore, formatDelta, escapeHtml } from "../util/format.js";
import { renderScoreChart } from "./charts.js";
import { player } from "./player.js";

const STATUS_LABEL = {
  pending: "○ Non analysé",
  analyzed: "✓ Analysé",
  corrected: "✎ Corrigé",
  error: "⚠ Erreur",
};
const STAGE_LABEL = { queued: "En attente", hash: "Lecture…", decode: "Décodage…", features: "Analyse" };

let onOpen = () => {};

export function initLibrary({ openDetail }) {
  onOpen = openDetail;
  const $ = (id) => document.getElementById(id);
  $("filter-stage").innerHTML = `<option value="all">Tous les niveaux</option>` +
    STAGES.map((s, i) => `<option value="${i}">${s.label}</option>`).join("");

  $("search").addEventListener("input", (e) => { state.ui.search = e.target.value; notify(); });
  $("filter-status").addEventListener("change", (e) => { state.ui.status = e.target.value; notify(); });
  $("filter-stage").addEventListener("change", (e) => { state.ui.stage = e.target.value; notify(); });
  $("sort").addEventListener("change", (e) => { state.ui.sort = e.target.value; notify(); });
  document.querySelectorAll(".library th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    const [cur, dir] = state.ui.sort.split("-");
    state.ui.sort = `${key}-${cur === key && dir === "asc" ? "desc" : "asc"}`;
    $("sort").value = state.ui.sort;
    notify();
  }));

  $("library-body").addEventListener("click", (e) => {
    const play = e.target.closest("[data-play]");
    if (play) {
      e.stopPropagation();
      player.toggle(play.dataset.play);
      return;
    }
    const row = e.target.closest("tr[data-id]");
    if (row) onOpen(row.dataset.id);
  });
  $("library-body").addEventListener("keydown", (e) => {
    const row = e.target.closest("tr[data-id]");
    if (row && (e.key === "Enter" || e.key === " ") && e.target === row) {
      e.preventDefault();
      onOpen(row.dataset.id);
    }
  });
  player.onChange(() => notify());
}

/** Rows = persisted records + files still being hashed (no id yet). */
function collectRows() {
  const jobsById = new Map();
  const rows = [];
  for (const job of state.jobs.values()) {
    if (job.id) jobsById.set(job.id, job);
    else rows.push({ key: job.key, name: job.name, size: job.size, job, record: null });
  }
  for (const r of state.records.values()) {
    rows.push({ key: r.id, id: r.id, name: r.name, size: r.size, record: r, job: jobsById.get(r.id) ?? null });
  }
  return rows;
}

function rowStatus(row) {
  return row.record ? statusOf(row.record) : "pending";
}

function filterSort(rows) {
  const q = state.ui.search.trim().toLowerCase();
  const stageIdx = state.ui.stage === "all" ? null : Number(state.ui.stage);
  let out = rows.filter((row) => {
    if (q && !row.name.toLowerCase().includes(q)) return false;
    if (state.ui.status !== "all" && rowStatus(row) !== state.ui.status) return false;
    if (stageIdx != null) {
      const s = row.record?.finalScore;
      if (s == null) return false;
      const lo = STAGES[stageIdx].min;
      const hi = STAGES[stageIdx + 1]?.min ?? 101;
      if (s < lo || s >= hi) return false;
    }
    return true;
  });
  const [key, dir] = state.ui.sort.split("-");
  const sign = dir === "asc" ? 1 : -1;
  const val = (row) => {
    if (key === "score") return row.record?.finalScore ?? null;
    if (key === "date") return row.record?.addedAt ?? Date.now();
    return row.name.toLowerCase();
  };
  out.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return a.name.localeCompare(b.name);
    if (va == null) return 1; // unscored always last
    if (vb == null) return -1;
    if (typeof va === "string") return sign * va.localeCompare(vb, "fr");
    return sign * (va - vb) || a.name.localeCompare(b.name);
  });
  return out;
}

export function renderLibrary() {
  const rows = collectRows();
  document.getElementById("library-count").textContent = state.records.size;
  renderOverview();
  const visible = filterSort(rows);
  const body = document.getElementById("library-body");
  body.innerHTML = visible.map(rowHtml).join("");
  const empty = document.getElementById("library-empty");
  empty.hidden = visible.length > 0;
  empty.textContent = rows.length ? "Aucun morceau ne correspond aux filtres." : "Aucun morceau pour l'instant. Importe des fichiers pour commencer.";
  document.querySelectorAll(".library th[data-sort]").forEach((th) => {
    const [key, dir] = state.ui.sort.split("-");
    th.setAttribute("aria-sort", th.dataset.sort === key ? (dir === "asc" ? "ascending" : "descending") : "none");
  });
}

function rowHtml(row) {
  const r = row.record;
  const status = rowStatus(row);
  const final = r?.finalScore;
  const auto = r?.auto?.score;
  const corr = r && final != null && auto != null && (r.correction || r.manual) ? final - auto : null;
  const canPlay = row.id && state.files.has(row.id);
  const playing = canPlay && player.isPlaying(row.id);
  const meta = [r?.source?.kind === "youtube" ? "YouTube" : formatSize(row.size), formatDuration(r?.duration)];
  if (final != null) meta.push(`<span class="stage-tag">${stageFor(final).label}</span>`);
  if (r && needsReanalysis(r)) meta.push("réanalyse conseillée");

  let statusHtml = `<span class="status ${status}">${STATUS_LABEL[status]}</span>`;
  if (row.job) {
    const pct = row.job.stage === "features" ? ` ${Math.round(row.job.progress * 100)} %` : "";
    statusHtml = `<span class="status pending">${STAGE_LABEL[row.job.stage] ?? "…"}${pct}</span>` +
      (row.job.stage === "features" ? `<div class="row-progress"><i style="width:${Math.round(row.job.progress * 100)}%"></i></div>` : "");
  } else if (status === "error") {
    statusHtml = `<span class="status error" title="${escapeHtml(r.error)}">${STATUS_LABEL.error}</span>`;
  }

  return `<tr ${row.id ? `data-id="${row.id}" tabindex="0"` : ""}>
    <td class="col-play"><button class="icon-btn" data-play="${row.id ?? ""}" ${canPlay ? "" : "disabled"} aria-label="${playing ? "Pause" : "Écouter"}" title="${canPlay ? (playing ? "Pause" : "Écouter") : "Lecture disponible pour les fichiers importés pendant cette session"}">${playing ? "❚❚" : "▶"}</button></td>
    <td><div class="track-name">${escapeHtml(row.name)}</div><div class="track-meta">${meta.join(" · ")}</div></td>
    <td class="num"><div class="score-cell">${final != null ? `<span class="minibar" aria-hidden="true"><i style="width:${final}%"></i></span>` : ""}<b>${formatScore(final)}</b></div></td>
    <td class="num hide-sm">${formatScore(auto)}</td>
    <td class="num hide-sm">${corr == null ? "—" : formatDelta(corr)}</td>
    <td>${statusHtml}</td>
    <td class="num hide-sm">${row.id && r ? `<button class="btn small" type="button">Détails</button>` : ""}</td>
  </tr>`;
}

function renderOverview() {
  const container = document.getElementById("overview");
  const scored = [...state.records.values()].filter((r) => r.finalScore != null).sort((a, b) => a.finalScore - b.finalScore);
  if (scored.length < 2) {
    container.innerHTML = "";
    container._key = "";
    return;
  }
  const key = scored.map((r) => `${r.id}:${r.finalScore}`).join(",");
  if (container._key === key) return; // avoid re-rendering the chart during analysis progress
  container._key = key;
  container.innerHTML = `<div class="card"><div class="chart-title"><strong>Progression des scores</strong><span class="muted small">${scored.length} morceaux, du plus calme au plus intense</span></div><div class="chart-host"></div></div>`;
  renderScoreChart(container.querySelector(".chart-host"), scored.map((r) => ({ id: r.id, label: r.name, score: r.finalScore })), {
    height: 180,
    onSelect: (id) => onOpen(id),
  });
}
