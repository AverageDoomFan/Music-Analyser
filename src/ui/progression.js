// Progression tab: ordered playlist grouped by perceptual stage + chart.

import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { toM3U, toText } from "../playlist/progression.js";
import { formatDuration, formatScore, formatDelta, escapeHtml } from "../util/format.js";
import { renderScoreChart } from "./charts.js";
import { toast } from "./toast.js";
import { intensityColor } from "./live-draw.js";
import { t, tn } from "../i18n/index.js";
import * as auth from "../spotify/auth.js";
import * as api from "../spotify/api.js";
import { sortPlaylistInPlace } from "../spotify/reorder.js";

let onOpen = () => {};

export function initProgression({ openDetail }) {
  onOpen = openDetail;
  const $ = (id) => document.getElementById(id);
  const tol = $("tolerance");
  tol.addEventListener("input", () => { $("tolerance-value").textContent = tol.value; });
  tol.addEventListener("change", () => { if (state.progression) build(); });
  $("build-progression").addEventListener("click", build);
  $("prog-mode").addEventListener("change", () => { if (state.progression) build(); });
  $("export-m3u").addEventListener("click", () => download(toM3U(state.progression.steps), "progression.m3u", "audio/x-mpegurl"));
  $("export-txt").addEventListener("click", () => download(toText(state.progression.steps), "progression.txt", "text/plain"));
  $("tab-progression")?.addEventListener("click", () => loadPlaylists());
  $("prog-sp-playlist").addEventListener("focus", () => loadPlaylists());
  $("prog-sp-playlist").addEventListener("change", () => { $("prog-sp-sort").disabled = !$("prog-sp-playlist").value; });
  $("prog-sp-sort").addEventListener("click", sortOnSpotify);
  $("prog-sp-undo").addEventListener("click", undoSort);
  $("progression-output").addEventListener("click", (e) => {
    const item = e.target.closest("[data-id]");
    if (item) onOpen(item.dataset.id);
  });
}

function build() {
  const p = ctl.buildProgression(Number(document.getElementById("tolerance").value), { byStyle: document.getElementById("prog-mode").value === "style" });
  if (!p.steps.length) toast(t("No analysed track."), "error");
  renderProgression();
}

function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderProgression() {
  const p = state.progression;
  document.getElementById("export-m3u").disabled = !p?.steps.length;
  document.getElementById("export-txt").disabled = !p?.steps.length;
  const out = document.getElementById("progression-output");
  if (!p) return;
  if (out._builtAt === p.builtAt) return;
  out._builtAt = p.builtAt;
  if (!p.steps.length) {
    out.innerHTML = `<p class="empty">${t("No analysed track yet.")}</p>`;
    return;
  }
  const totalDuration = p.steps.reduce((a, s) => a + (s.duration ?? 0), 0);
  const groups = [];
  for (const s of p.steps) {
    const g = p.byStyle ? s.group : s.stage;
    if (!groups.length || groups.at(-1).stage !== g) groups.push({ stage: g, items: [] });
    groups.at(-1).items.push(s);
  }
  out.innerHTML = `
    <div class="card">
      <div class="chart-title"><strong>${t("Playlist intensity curve")}</strong><span class="muted small">${t("hollow points = jumps ≥ 12 points")}</span></div>
      <div class="chart-host"></div>
    </div>
    <div class="stats">
      <span>${tn(p.stats.count, "<b>{n}</b> track", "<b>{n}</b> tracks")}</span>
      <span>${t("<b>{d}</b> in total", { d: formatDuration(totalDuration) })}</span>
      <span>${t("biggest jump <b>{n}</b> points", { n: Math.round(p.stats.maxJump) })}</span>
      <span>${tn(p.stats.bigJumps, "<b>{n}</b> big jump", "<b>{n}</b> big jumps")}</span>
    </div>
    ${p.stats.bigJumps ? `<p class="notice">${t("Big jumps show zones where your library lacks in-between tracks.")}</p>` : ""}
    ${groups.map((g) => `
      <div class="stage-group">
        <h3>${escapeHtml(g.stage)} <small>${tn(g.items.length, "{n} track", "{n} tracks")}</small></h3>
        <ol class="progression-list">${g.items.map(itemHtml).join("")}</ol>
      </div>`).join("")}`;
  renderScoreChart(out.querySelector(".chart-host"), p.steps.map((s) => ({ id: s.id, label: s.name, score: s.score, flag: s.bigJump })), {
    height: 220,
    xLabel: t("play order →"),
    onSelect: onOpen,
  });
}

function itemHtml(s) {
  return `<li class="prog-item" data-id="${s.id}" style="cursor:pointer">
    <span class="pos">${s.position}</span>
    <span><span class="track-name">${escapeHtml(s.name)}</span></span>
    <span class="num"><b class="score-val" style="--sc:${intensityColor(s.score)}">${formatScore(s.score)}</b></span>
    <span class="jump${s.bigJump ? " big" : ""}" title="${t("score gap with the previous track · end of the previous → start of this one: {d}", { d: formatDelta(s.seam) })}">${s.position > 1 ? formatDelta(s.jump) : ""}</span>
  </li>`;
}

// ---------------------------------------------------------- Spotify playlist

const sp = { loaded: false, loading: null, undo: null, busy: false };

/** Fills the playlist picker once (the user's own and collaborative playlists). */
function loadPlaylists(force = false) {
  const sel = document.getElementById("prog-sp-playlist");
  const status = document.getElementById("prog-sp-status");
  if (!auth.isLoggedIn()) {
    status.textContent = t("Log in to Spotify first (Spotify tab).");
    return null;
  }
  if (sp.loaded && !force) return null;
  sp.loading ??= (async () => {
    try {
      const me = await api.me();
      const lists = (await api.myPlaylists(me.id)).filter((p) => p.editable);
      const keep = sel.value;
      sel.innerHTML = `<option value="">—</option>` + lists.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.count != null ? ` (${p.count})` : ""}</option>`).join("");
      if (lists.some((p) => p.id === keep)) sel.value = keep;
      sp.loaded = true;
      if (!sp.busy) status.textContent = lists.length ? "" : t("No playlist of yours on this account.");
    } catch (err) {
      status.textContent = err.message;
    } finally {
      sp.loading = null;
      document.getElementById("prog-sp-sort").disabled = !sel.value || sp.busy;
    }
  })();
  return sp.loading;
}

function setBusy(on) {
  sp.busy = on;
  const sel = document.getElementById("prog-sp-playlist");
  document.getElementById("prog-sp-sort").disabled = on || !sel.value;
  document.getElementById("prog-sp-undo").disabled = on;
  sel.disabled = on;
}

async function sortOnSpotify() {
  const sel = document.getElementById("prog-sp-playlist");
  const status = document.getElementById("prog-sp-status");
  const id = sel.value;
  if (!id || sp.busy) return;
  const name = sel.selectedOptions[0]?.textContent ?? "";
  if (!confirm(t("Reorder “{name}” on your Spotify account, in the progression order? No track is removed or added.", { name }))) return;
  setBusy(true);
  document.getElementById("prog-sp-undo").hidden = true;
  sp.undo = null;
  status.textContent = t("Reading the playlist…");
  try {
    const res = await sortPlaylistInPlace(id, {
      tolerance: Number(document.getElementById("tolerance").value),
      byStyle: document.getElementById("prog-mode").value === "style",
      onProgress: (i, n) => { status.textContent = t("Moving tracks… {i}/{n}", { i, n }); },
    });
    if (!res.sorted) {
      status.textContent = t("No track of this playlist is analysed yet: nothing to sort.");
    } else if (!res.moves) {
      status.textContent = t("Already in order.");
    } else {
      status.textContent = t("Sorted: {sorted} analysed tracks in order; not analysed, left at the end: {rest}.", res);
      sp.undo = { id, run: res.undo };
      document.getElementById("prog-sp-undo").hidden = false;
      toast(t("Playlist sorted on Spotify."));
    }
  } catch (err) {
    status.textContent = "";
    toast(err.message, "error");
  } finally {
    setBusy(false);
  }
}

async function undoSort() {
  if (!sp.undo || sp.busy) return;
  const status = document.getElementById("prog-sp-status");
  setBusy(true);
  try {
    await sp.undo.run((i, n) => { status.textContent = t("Restoring the order… {i}/{n}", { i, n }); });
    status.textContent = t("Previous order restored.");
    sp.undo = null;
    document.getElementById("prog-sp-undo").hidden = true;
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setBusy(false);
  }
}
