// Library view: overview chart + filterable/sortable table.

import { STAGES, stageFor, AGGREGATIONS, CURVE_STATS } from "../config.js";
import { state, notify } from "../app/store.js";
import { statusOf, needsReanalysis, isCounted } from "../core/track.js";
import { formatDuration, formatSize, formatScore, formatDelta, escapeHtml } from "../util/format.js";
import { renderScoreChart, sparkline } from "./charts.js";
import { moodLabel } from "../scoring/describe.js";
import * as ctl from "../app/controller.js";
import { player } from "./player.js";
import { t, tn } from "../i18n/index.js";
import { genreLine } from "./home.js";

const STATUS_LABEL = {
  pending: t("○ Not analysed"),
  analyzed: t("✓ Analysed"),
  corrected: t("✎ Corrected"),
  error: t("⚠ Error"),
};
const STAGE_LABEL = { queued: t("Waiting"), hash: t("Reading…"), decode: t("Decoding…"), features: t("Analysing") };

let onOpen = () => {};

export function initLibrary({ openDetail }) {
  onOpen = openDetail;
  const $ = (id) => document.getElementById(id);
  $("filter-stage").innerHTML = `<option value="all">${t("All levels")}</option>` +
    STAGES.map((s, i) => `<option value="${i}">${s.label}</option>`).join("");

  $("search").addEventListener("input", (e) => { state.ui.search = e.target.value; notify(); });
  $("filter-status").addEventListener("change", (e) => { state.ui.status = e.target.value; notify(); });
  $("filter-stage").addEventListener("change", (e) => { state.ui.stage = e.target.value; notify(); });
  $("filter-vocals").addEventListener("change", (e) => { state.ui.vocals = e.target.value; notify(); });
  $("hide-tests").addEventListener("change", (e) => { state.ui.hideTests = e.target.checked; notify(); });
  $("filter-genre").addEventListener("change", (e) => { state.ui.genre = e.target.value; notify(); });
  $("group-by").addEventListener("change", (e) => { state.ui.group = e.target.value; notify(); });
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
    const draft = e.target.closest("[data-draft]");
    if (draft) {
      e.stopPropagation();
      onDraftAction(draft.dataset.draft, draft.dataset.id).catch((err) => console.error(err));
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

/** Validate / Delete buttons of a draft row. */
async function onDraftAction(action, id) {
  const r = state.records.get(id);
  if (!r) return;
  if (action === "validate") await ctl.validateDraft(id);
  else if (action === "delete" && confirm(t("Delete the draft “{name}”?", { name: r.name }))) await ctl.deleteTrack(id);
}

const SORT_KEYS = [
  { key: "score", label: "Score", hint: t("Final score (chosen method, corrections included)") },
  ...AGGREGATIONS.map((a) => ({ key: a.key, label: a.label, hint: a.hint })),
  ...CURVE_STATS,
  { key: "valence", label: t("Mood"), hint: t("Dark → bright (mode, brightness, tempo, consonance, lyrics)") },
  { key: "bpm", label: "BPM" },
  { key: "genre", label: t("Genre") },
  { key: "camelot", label: t("Key (Camelot)"), hint: t("Camelot wheel order: 1A, 1B, 2A…") },
  { key: "name", label: t("Name") },
  { key: "date", label: t("Date added") },
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
    if (q && !searchText(row).includes(q)) return false;
    if (state.ui.status === "draft" ? !row.record?.draft : state.ui.status !== "all" && rowStatus(row) !== state.ui.status) return false;
    if (state.ui.hideTests && row.record?.source?.kind === "test") return false;
    const gf = state.ui.genre ?? "all";
    if (gf !== "all") {
      const g = row.record?.auto ? ctl.genreInfo(row.record).label : null;
      if (gf === "none" ? g : !(g === gf || g?.startsWith(`${gf} › `))) return false;
    }
    const vf = state.ui.vocals ?? "all";
    if (vf !== "all") {
      const v = row.record?.vocals?.state ?? null;
      if (vf === "unknown" ? v != null : vf === "torate" ? v !== "vocal" || row.record.lyrics : v !== vf) return false;
    }
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
    if (key === "valence") return row.record?.valence ?? null;
    if (key === "genre") return row.record?.auto ? (ctl.genreInfo(row.record).label?.toLowerCase() ?? null) : null;
    if (key === "bpm") return row.record?.auto?.music?.tempo?.bpm ?? null;
    if (key === "camelot") {
      const c = row.record?.auto?.music?.key?.camelot;
      return c ? parseInt(c, 10) * 2 + (c.endsWith("B") ? 1 : 0) : null;
    }
    return statOf(row.record, key);
  };
  out.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return a.name.localeCompare(b.name);
    if (va == null) return 1; // unscored always last
    if (vb == null) return -1;
    if (typeof va === "string") return sign * va.localeCompare(vb);
    return sign * (va - vb) || a.name.localeCompare(b.name);
  });
  return out;
}

export function renderLibrary() {
  const rows = collectRows();
  renderGenreStatus();
  document.getElementById("library-count").textContent = state.records.size;
  renderOverview();
  renderGenreFilter();
  const visible = filterSort(rows);
  const body = document.getElementById("library-body");
  body.innerHTML = state.ui.group && state.ui.group !== "none" ? groupedHtml(visible) : visible.map(rowHtml).join("");
  const empty = document.getElementById("library-empty");
  empty.hidden = visible.length > 0;
  empty.textContent = rows.length ? t("No track matches the filters.") : t("No track yet. Import files to start.");
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
  const canPlay = player.canPlay(row.id);
  const playing = canPlay && player.isPlaying(row.id);
  const src = r?.source;
  const meta = src?.kind === "test"
    ? [`<span class="test-tag" title="${t("Synthetic track from the test bench")}">Test</span>`, formatDuration(r?.duration)]
    : src?.kind === "spotify"
    ? [`<span class="src-tag" title="${t("Analysed by capturing Spotify playback")}">Spotify · ${src.mode === "full" ? t("whole") : t("{n} % heard", { n: Math.round((src.coverage ?? 0) * 100) })}</span>`, formatDuration(r?.duration)]
    : [formatSize(row.size), formatDuration(r?.duration)];
  if (r?.draft) meta.unshift(`<span class="draft-tag" title="${t("Heard less than 60 % in the Live tab: out of stats and games until you validate it")}">${t("Draft")}</span>`);
  if (final != null) meta.push(`<span class="stage-tag">${stageFor(final).label}</span>`);
  if (r && needsReanalysis(r)) meta.push(t("re-analysis advised"));

  let statusHtml = `<span class="status ${status}">${STATUS_LABEL[status]}</span>`;
  if (row.job) {
    const pct = row.job.stage === "features" ? ` ${Math.round(row.job.progress * 100)} %` : "";
    statusHtml = `<span class="status pending">${STAGE_LABEL[row.job.stage] ?? "…"}${pct}</span>` +
      (row.job.stage === "features" ? `<div class="row-progress"><i style="width:${Math.round(row.job.progress * 100)}%"></i></div>` : "");
  } else if (status === "error") {
    statusHtml = `<span class="status error" title="${escapeHtml(r.error)}">${STATUS_LABEL.error}</span>`;
  }

  return `<tr ${row.id ? `data-id="${row.id}" tabindex="0"` : ""}>
    <td class="col-play"><button class="icon-btn" data-play="${row.id ?? ""}" ${canPlay ? "" : "disabled"} aria-label="${playing ? t("Pause") : t("Play")}" title="${canPlay ? (playing ? t("Pause") : player.kind(row.id) === "spotify" ? t("Play on Spotify") : t("Play")) : t("Playback available for files imported in this session, and for Spotify captures when logged in")}">${playing ? "❚❚" : "▶"}</button></td>
    <td><div class="track-name">${escapeHtml(row.name)}</div><div class="track-meta">${meta.join(" · ")}</div>${r?.draft ? draftActions(r) : ""}</td>
    <td class="col-curve hide-sm" title="${r?.auto?.stats ? curveTitle(r) : ""}">${r?.auto?.curves ? sparkline(r.auto.curves.intensity) : ""}</td>
    <td class="hide-sm">${musicCell(r)}</td>
    <td class="num"><div class="score-cell">${final != null ? `<span class="minibar" aria-hidden="true"><i style="width:${final}%"></i></span>` : ""}<b>${formatScore(final)}</b></div>${sortTag(r)}</td>
    <td class="num hide-sm">${formatScore(auto)}</td>
    <td class="num hide-sm">${corr == null ? "—" : formatDelta(corr)}</td>
    <td>${statusHtml}</td>
    <td class="num hide-sm">${row.id && r ? `<button class="btn small" type="button">${t("Details")}</button>` : ""}</td>
  </tr>`;
}

function draftActions(r) {
  const id = escapeHtml(r.id);
  return `<div class="draft-actions"><button class="btn small primary" type="button" data-draft="validate" data-id="${id}">${t("Validate")}</button><button class="btn small danger" type="button" data-draft="delete" data-id="${id}">${t("Delete")}</button></div>`;
}

/** Name + genres (label and Spotify genres): what the search box looks into. */
function searchText(row) {
  const r = row.record;
  if (!r?.auto) return row.name.toLowerCase();
  const g = ctl.genreInfo(r);
  return [row.name, g.label ?? "", ...(r.extGenres?.genres ?? [])].join(" ").toLowerCase();
}

const GROUP_LEVEL = { family: 1, style: 2, genre: 9 };

/** Rows grouped by style: groups from calmest (median score) to most intense, the current sort inside. */
function groupedHtml(rows) {
  const depth = GROUP_LEVEL[state.ui.group] ?? 2;
  const groups = new Map();
  for (const row of rows) {
    const label = row.record?.auto ? ctl.genreInfo(row.record).label : null;
    const key = label ? label.split(" › ").slice(0, depth).join(" › ") : t("No genre");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const med = (list) => {
    const v = list.map((r) => r.record?.finalScore).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : 999;
  };
  return [...groups.entries()]
    .sort((a, b) => (a[0] === t("No genre")) - (b[0] === t("No genre")) || med(a[1]) - med(b[1]))
    .map(([key, list]) => {
      const m = med(list);
      const subs = new Set(list.map((r) => r.record?.auto && ctl.genreInfo(r.record).label).filter((l) => l && l !== key).map((l) => l.split(" › ").slice(depth).join(" › ")).filter(Boolean));
      return `<tr class="group-row"><td colspan="9"><b>${escapeHtml(key)}</b> <span class="muted small">${tn(list.length, "{n} track", "{n} tracks")}${m !== 999 ? ` · ${t("median intensity {n}", { n: Math.round(m) })}` : ""}${subs.size ? ` · ${escapeHtml([...subs].slice(0, 6).join(", "))}${subs.size > 6 ? "…" : ""}` : ""}</span></td></tr>` + list.map(rowHtml).join("");
    }).join("");
}

let genreStatusAt = 0;
/** One line under the filters: where the genres come from (refreshed at most every 2 s). */
function renderGenreStatus() {
  if (Date.now() - genreStatusAt < 2000) return;
  genreStatusAt = Date.now();
  ctl.genreStatus().then((g) => {
    const el = document.getElementById("library-genre-status");
    if (!el || !g.analysed) { if (el) el.textContent = ""; return; }
    el.textContent = `${t("Genres")}: ${genreLine(g)}`;
  }).catch(() => {});
}

let genreKey = "";
function renderGenreFilter() {
  const list = ctl.allGenres();
  const key = list.join("|");
  if (key === genreKey) return;
  genreKey = key;
  const sel = document.getElementById("filter-genre");
  const cur = state.ui.genre ?? "all";
  sel.innerHTML = `<option value="all">${t("Genre: all")}</option><option value="none">${t("No genre")}</option>` +
    list.map((g) => `<option value="${escapeHtml(g)}">${"· ".repeat(g.split(" › ").length - 1)}${escapeHtml(g.split(" › ").at(-1))}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "all";
}

function musicCell(r) {
  const m = r?.auto?.music;
  if (!m) return "";
  const parts = [];
  if (m.key) parts.push(`<b title="${escapeHtml(m.key.name)} · ${t("reliability {n} %", { n: Math.round(m.key.confidence * 100) })}">${escapeHtml(m.key.camelot)}</b>`);
  if (m.tempo) parts.push(`${Math.round(m.tempo.bpm)} BPM`);
  const v = r.valence;
  const mood = v != null ? `<div><span class="mood-dot" style="background:${valenceColor(v)}"></span>${escapeHtml(moodLabel(r.finalScore, v))}${r.vocals?.state === "vocal" ? (r.lyrics ? t(" · ♪ rated") : " · ♪") : ""}</div>` : "";
  const g = ctl.genreInfo(r);
  const genre = g.label ? `<div class="genre-cell ${g.source === "user" ? "" : "guess"}" title="${g.source === "user" ? t("Your label") : `${t(SOURCE_NAME[g.source] ?? g.source)} · ${Math.round(g.confidence * 100)} %`}">${escapeHtml(g.label)}${g.source === "user" ? "" : " ?"}</div>` : "";
  return `<div class="music-cell">${parts.join(" · ")}${mood}${genre}</div>`;
}

const SOURCE_NAME = { spotify: "Spotify genres", musicbrainz: "MusicBrainz tags", neighbours: "Suggestion (close tracks)" };

const valenceColor = (v) => `hsl(${Math.round(270 - (v / 100) * 230)}, 70%, 55%)`;

/** When sorting by a curve statistic, show it next to the score. */
function sortTag(r) {
  const [key] = state.ui.sort.split("-");
  if (!r || ["score", "name", "date", "valence", "bpm", "camelot", "genre"].includes(key)) return "";
  const v = statOf(r, key);
  if (v == null) return "";
  const label = SORT_KEYS.find((k) => k.key === key)?.label ?? key;
  return `<div class="stat-tag">${label} ${Math.round(v)}</div>`;
}

function curveTitle(r) {
  const s = r.auto.stats;
  const f = (v) => Math.round(v);
  return `${t("Mean")} ${f(s.mean)} · ${t("Peak")} ${f(s.peak)} · ${t("Mean of peaks")} ${f(s.topMean)} · ${t("Start")} ${f(s.start)} → ${t("End")} ${f(s.end)}`;
}

function renderOverview() {
  const container = document.getElementById("overview");
  const scored = [...state.records.values()].filter(isCounted).sort((a, b) => a.finalScore - b.finalScore);
  if (scored.length < 2) {
    container.innerHTML = "";
    container._key = "";
    return;
  }
  const key = scored.map((r) => `${r.id}:${r.finalScore}`).join(",");
  if (container._key === key) return; // avoid re-rendering the chart during analysis progress
  container._key = key;
  container.innerHTML = `<div class="card"><div class="chart-title"><strong>${t("Scores from calmest to most intense")}</strong><span class="muted small">${tn(scored.length, "{n} track", "{n} tracks")}</span></div><div class="chart-host"></div></div>`;
  renderScoreChart(container.querySelector(".chart-host"), scored.map((r) => ({ id: r.id, label: r.name, score: r.finalScore })), {
    height: 180,
    onSelect: (id) => onOpen(id),
  });
}
