// Library view: overview chart + filterable/sortable table.

import { STAGES, stageFor, AGGREGATIONS, CURVE_STATS } from "../config.js";
import { state, notify } from "../app/store.js";
import { statusOf, needsReanalysis } from "../core/track.js";
import { formatDuration, formatSize, formatScore, formatDelta, escapeHtml } from "../util/format.js";
import { renderScoreChart, sparkline } from "./charts.js";
import * as ctl from "../app/controller.js";
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
  $("aggregation").innerHTML = AGGREGATIONS.map((a) => `<option value="${a.key}" title="${a.hint}">${a.label}</option>`).join("");
  $("aggregation").addEventListener("change", (e) => ctl.setAggregation(e.target.value));
  $("sort-key").innerHTML = SORT_KEYS.map((k) => `<option value="${k.key}" title="${k.hint ?? ""}">${k.label}</option>`).join("");
  $("sort-key").addEventListener("change", (e) => {
    const [, dir] = state.ui.sort.split("-");
    state.ui.sort = `${e.target.value}-${dir}`;
    notify();
  });
  $("sort-dir").addEventListener("click", () => {
    const [key, dir] = state.ui.sort.split("-");
    state.ui.sort = `${key}-${dir === "asc" ? "desc" : "asc"}`;
    notify();
  });
  document.querySelectorAll(".library th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    const [cur, dir] = state.ui.sort.split("-");
    state.ui.sort = `${key}-${cur === key && dir === "asc" ? "desc" : "asc"}`;
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

const SORT_KEYS = [
  { key: "score", label: "Score", hint: "Score final (méthode choisie, corrections comprises)" },
  ...AGGREGATIONS.map((a) => ({ key: a.key, label: a.label, hint: a.hint })),
  ...CURVE_STATS,
  { key: "name", label: "Nom" },
  { key: "date", label: "Date d'ajout" },
];

/**
 * Value of a curve statistic for sorting. A correction or a manual score
 * shifts the whole curve, so the same offset is applied to every statistic.
 */
function statOf(r, key) {
  if (!r?.auto || r.finalScore == null) return null;
  const raw = r.auto.stats?.[key] ?? r.auto.score;
  return key === "variability" ? raw : raw + (r.finalScore - r.auto.score);
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
    if (key === "name") return row.name.toLowerCase();
    return statOf(row.record, key);
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
  const [sortKey, sortDir] = state.ui.sort.split("-");
  document.getElementById("sort-key").value = sortKey;
  document.getElementById("sort-dir").textContent = sortDir === "asc" ? "↑" : "↓";
  document.getElementById("aggregation").value = state.aggregation;
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
  const meta = [formatSize(row.size), formatDuration(r?.duration)];
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
    <td class="col-curve hide-sm" title="${r?.auto?.stats ? curveTitle(r) : ""}">${r?.auto?.curves ? sparkline(r.auto.curves.intensity) : ""}</td>
    <td class="num"><div class="score-cell">${final != null ? `<span class="minibar" aria-hidden="true"><i style="width:${final}%"></i></span>` : ""}<b>${formatScore(final)}</b></div>${sortTag(r)}</td>
    <td class="num hide-sm">${formatScore(auto)}</td>
    <td class="num hide-sm">${corr == null ? "—" : formatDelta(corr)}</td>
    <td>${statusHtml}</td>
    <td class="num hide-sm">${row.id && r ? `<button class="btn small" type="button">Détails</button>` : ""}</td>
  </tr>`;
}

/** When sorting by a curve statistic, show it next to the score. */
function sortTag(r) {
  const [key] = state.ui.sort.split("-");
  if (!r || ["score", "name", "date"].includes(key)) return "";
  const v = statOf(r, key);
  if (v == null) return "";
  const label = SORT_KEYS.find((k) => k.key === key)?.label ?? key;
  return `<div class="stat-tag">${label} ${Math.round(v)}</div>`;
}

function curveTitle(r) {
  const s = r.auto.stats;
  const f = (v) => Math.round(v);
  return `Moyenne ${f(s.mean)} · Pic ${f(s.peak)} · Moy. des pics ${f(s.topMean)} · Début ${f(s.start)} → Fin ${f(s.end)}`;
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
