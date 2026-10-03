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
import { sortPlaylistInPlace, recordMatcher } from "../spotify/reorder.js";
import { localInfo, matchScore, normalize } from "../spotify/match.js";
import { player } from "./player.js";
import { previewWindow, PREVIEW_SECONDS } from "../playlist/preview.js";

let onOpen = () => {};

export function initProgression({ openDetail }) {
  onOpen = openDetail;
  const $ = (id) => document.getElementById(id);
  const tol = $("tolerance");
  tol.addEventListener("input", () => { $("tolerance-value").textContent = tol.value; });
  tol.addEventListener("change", () => { if (state.progression) build(); });
  $("build-progression").addEventListener("click", () => build({ refresh: true }));
  $("prog-mode").addEventListener("change", () => { if (state.progression) build(); });
  $("export-m3u").addEventListener("click", () => download(toM3U(state.progression.steps), "progression.m3u", "audio/x-mpegurl"));
  $("export-txt").addEventListener("click", () => download(toText(state.progression.steps), "progression.txt", "text/plain"));
  $("tab-progression")?.addEventListener("click", () => loadPlaylists());
  $("prog-sp-playlist").addEventListener("focus", () => loadPlaylists());
  $("prog-sp-playlist").addEventListener("change", () => {
    $("prog-sp-sort").disabled = !$("prog-sp-playlist").value;
    showAddRow();
    if (state.progression) build({ refresh: true });
  });
  let searchTimer = null;
  $("prog-sp-add").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchToAdd, 350); });
  $("prog-sp-results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]");
    if (b) addToPlaylist(b);
  });
  $("prog-sp-sort").addEventListener("click", sortOnSpotify);
  $("prog-sp-undo").addEventListener("click", undoSort);
  $("progression-output").addEventListener("click", (e) => {
    const prev = e.target.closest("[data-preview]");
    if (prev) {
      e.stopPropagation();
      if (prev.dataset.preview === "all") return pv.on ? stopPreview() : startPreview(0);
      return startPreview(Number(prev.dataset.preview));
    }
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      e.stopPropagation();
      return removeFromPlaylist(rm.dataset.remove);
    }
    const item = e.target.closest("[data-id]");
    if (item) onOpen(item.dataset.id);
  });
}

// the selected playlist's entries, read again on "Build" and after a change
const pl = { id: null, entries: null };

/** The selected Spotify playlist, as the progression's scope (null = the whole library). */
async function playlistScope(refresh) {
  const sel = document.getElementById("prog-sp-playlist");
  const id = sel.value;
  if (!id || !auth.isLoggedIn()) return null;
  if (refresh || pl.id !== id || !pl.entries) Object.assign(pl, { id, entries: await api.playlistEntries(id) });
  const recordOf = await recordMatcher(pl.entries);
  const only = new Set();
  const uris = {};
  const missing = [];
  for (const e of pl.entries) {
    if (!e.id) continue;
    const r = recordOf(e.id);
    if (r) {
      only.add(r.id);
      (uris[r.id] ??= []).includes(e.uri) || uris[r.id].push(e.uri);
    } else if (!missing.some((m) => m.uri === e.uri)) {
      missing.push({ uri: e.uri, name: `${e.artists?.join(", ") || "?"} - ${e.name}` });
    }
  }
  return { only, playlist: { id, name: sel.selectedOptions[0]?.dataset.name ?? sel.selectedOptions[0]?.textContent ?? "", uris, missing, ids: new Set(pl.entries.map((e) => e.id).filter(Boolean)) } };
}

async function build({ refresh = false } = {}) {
  stopPreview();
  let scope = null;
  try {
    scope = await playlistScope(refresh);
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  const p = ctl.buildProgression(Number(document.getElementById("tolerance").value), {
    byStyle: document.getElementById("prog-mode").value === "style",
    only: scope?.only ?? null,
    playlist: scope?.playlist ?? null,
  });
  if (!p.steps.length && !p.playlist) toast(t("No analysed track."), "error");
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
    out.innerHTML = p.playlist
      ? `${playlistHead(p)}<p class="empty">${t("No track of this playlist is analysed yet.")}</p>${missingHtml(p)}`
      : `<p class="empty">${t("No analysed track yet.")}</p>`;
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
    ${playlistHead(p)}
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
    <div class="prog-preview">
      <button class="btn" type="button" data-preview="all" id="prog-preview-btn">${t("▶ Preview the drops")}</button>
      <span class="muted small" id="prog-preview-status" role="status">${t("{n} s of each track, from just before its drop. ▶ on a track starts from there.", { n: PREVIEW_SECONDS })}</span>
    </div>
    ${p.stats.bigJumps ? `<p class="notice">${t("Big jumps show zones where your library lacks in-between tracks.")}</p>` : ""}
    ${groups.map((g) => `
      <div class="stage-group">
        <h3>${escapeHtml(g.stage)} <small>${tn(g.items.length, "{n} track", "{n} tracks")}</small></h3>
        <ol class="progression-list">${g.items.map((s) => itemHtml(s, !!p.playlist)).join("")}</ol>
      </div>`).join("")}
    ${missingHtml(p)}`;
  renderScoreChart(out.querySelector(".chart-host"), p.steps.map((s) => ({ id: s.id, label: s.name, score: s.score, flag: s.bigJump })), {
    height: 220,
    xLabel: t("play order →"),
    onSelect: onOpen,
  });
}

function playlistHead(p) {
  if (!p.playlist) return "";
  return `<p class="notice prog-scope">${t("Playlist “{name}”: {n} analysed tracks, not analysed: {m}.", { name: escapeHtml(p.playlist.name), n: p.steps.length, m: p.playlist.missing.length })}</p>`;
}

function missingHtml(p) {
  if (!p.playlist?.missing.length) return "";
  return `<div class="stage-group">
    <h3>${t("Not analysed")} <small>${tn(p.playlist.missing.length, "{n} track", "{n} tracks")}</small></h3>
    <ol class="progression-list">${p.playlist.missing.map((m) => `<li class="prog-item missing">
      <span class="pos">·</span><span></span>
      <span><span class="track-name">${escapeHtml(m.name)}</span></span><span></span><span></span>
      <button class="prog-rm" type="button" data-remove="uri:${escapeHtml(m.uri)}" title="${t("Remove from the playlist")}" aria-label="${t("Remove from the playlist")}">✕</button>
    </li>`).join("")}</ol>
  </div>`;
}

function itemHtml(s, removable = false) {
  return `<li class="prog-item" data-id="${s.id}" style="cursor:pointer">
    <span class="pos">${s.position}</span>
    <button class="prog-prev" type="button" data-preview="${s.position - 1}" title="${t("Preview the drops from this track")}" aria-label="${t("Preview the drops from this track")}">▶</button>
    <span><span class="track-name">${escapeHtml(s.name)}</span></span>
    <span class="num"><b class="score-val" style="--sc:${intensityColor(s.score)}">${formatScore(s.score)}</b></span>
    <span class="jump${s.bigJump ? " big" : ""}" title="${t("score gap with the previous track · end of the previous → start of this one: {d}", { d: formatDelta(s.seam) })}">${s.position > 1 ? formatDelta(s.jump) : ""}</span>
    ${removable ? `<button class="prog-rm" type="button" data-remove="rec:${escapeHtml(s.id)}" title="${t("Remove from the playlist")}" aria-label="${t("Remove from the playlist")}">✕</button>` : "<span></span>"}
  </li>`;
}

// ---------------------------------------------------------- playlist editing

function showAddRow() {
  const on = !!document.getElementById("prog-sp-playlist").value && auth.isLoggedIn();
  document.getElementById("prog-sp-add-row").hidden = !on;
  if (!on) document.getElementById("prog-sp-results").hidden = true;
}

function playlistChanged() {
  sp.undo = null;
  document.getElementById("prog-sp-undo").hidden = true;
}

async function removeFromPlaylist(key) {
  const p = state.progression;
  if (!p?.playlist || sp.busy) return;
  const [kind, ref] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const uris = kind === "rec" ? p.playlist.uris[ref] ?? [] : [ref];
  const name = kind === "rec" ? state.records.get(ref)?.name : p.playlist.missing.find((m) => m.uri === ref)?.name;
  if (!uris.length) return;
  if (!confirm(t("Remove “{track}” from “{name}” on Spotify?", { track: name ?? "?", name: p.playlist.name }))) return;
  setBusy(true);
  try {
    await api.removeTracks(p.playlist.id, uris);
    playlistChanged();
    toast(t("Removed from the playlist."));
    await build({ refresh: true });
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setBusy(false);
  }
}

async function searchToAdd() {
  const input = document.getElementById("prog-sp-add");
  const box = document.getElementById("prog-sp-results");
  const q = input.value.trim();
  if (q.length < 2) {
    box.hidden = true;
    return;
  }
  const inList = state.progression?.playlist?.id === document.getElementById("prog-sp-playlist").value ? state.progression.playlist : null;
  const words = normalize(q).split(" ").filter(Boolean);
  const lib = [...state.records.values()]
    .filter((r) => r.finalScore != null && !r.draft && !inList?.uris[r.id])
    .filter((r) => { const n = normalize(r.name); return words.every((w) => n.includes(w)); })
    .slice(0, 5)
    .map((r) => ({ add: `rec:${r.id}`, name: r.name, where: `${t("Library")} · ${formatScore(r.finalScore)}` }));
  let spot = [];
  try {
    spot = (await api.searchTracks(q, 6))
      .filter((tr) => !inList?.ids.has(tr.id))
      .map((tr) => ({ add: `uri:${tr.uri}`, name: `${tr.artists.join(", ")} - ${tr.name}`, where: "Spotify" }));
  } catch (err) {
    spot = [];
    toast(err.message, "error");
  }
  if (input.value.trim() !== q) return; // typed on meanwhile
  const rows = [...lib, ...spot];
  box.innerHTML = rows.length
    ? rows.map((x) => `<li><span class="track-name">${escapeHtml(x.name)}</span><span class="muted small">${escapeHtml(x.where)}</span><button class="btn small" type="button" data-add="${escapeHtml(x.add)}">${t("Add")}</button></li>`).join("")
    : `<li class="muted small">${t("No result.")}</li>`;
  box.hidden = false;
}

/** A library record's Spotify track: its capture, else the best catalogue match of the file. */
async function spotifyUriOf(r) {
  if (r.source?.kind === "spotify" && r.source.uri?.startsWith("spotify:track:")) return r.source.uri;
  const info = localInfo(r);
  const found = await api.searchTracks(`${info.title} ${info.artist}`.trim(), 10);
  const best = found.map((tr) => ({ tr, s: matchScore(tr, info) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s >= 0.55 ? best.tr.uri : null;
}

async function addToPlaylist(btn) {
  const id = document.getElementById("prog-sp-playlist").value;
  if (!id || sp.busy) return;
  const key = btn.dataset.add;
  const ref = key.slice(key.indexOf(":") + 1);
  setBusy(true);
  btn.disabled = true;
  try {
    const uri = key.startsWith("rec:") ? await spotifyUriOf(state.records.get(ref)) : ref;
    if (!uri) {
      toast(t("This file was not found on Spotify."), "error");
      return;
    }
    await api.addTracks(id, [uri]);
    playlistChanged();
    btn.closest("li")?.remove();
    toast(t("Added to the playlist."));
    if (state.progression) await build({ refresh: true });
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    setBusy(false);
  }
}

// ---------------------------------------------------------- drop preview

// one excerpt per track, in the progression order; anything else played stops it
const pv = { on: false, i: -1, id: null, timer: null, run: 0, switching: false, hooked: false };

function previewStatus(text) {
  const el = document.getElementById("prog-preview-status");
  if (el) el.textContent = text;
}

function markPreview() {
  const out = document.getElementById("progression-output");
  out.querySelectorAll(".prog-item.previewing").forEach((el) => el.classList.remove("previewing"));
  const btn = document.getElementById("prog-preview-btn");
  if (btn) btn.textContent = pv.on ? t("■ Stop the preview") : t("▶ Preview the drops");
  if (!pv.on) return;
  const el = out.querySelectorAll(".prog-item")[pv.i];
  if (!el) return;
  el.classList.add("previewing");
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function startPreview(from) {
  const steps = state.progression?.steps ?? [];
  if (!steps.slice(from).some((s) => player.canPlay(s.id))) {
    toast(t("Nothing to play here: import the files again, or log in to Spotify with playback (Premium)."), "error", 7000);
    return;
  }
  if (!pv.hooked) {
    pv.hooked = true;
    // another track played elsewhere (or stopped): the preview gives way
    player.onChange(() => {
      if (pv.on && !pv.switching && player.current !== pv.id) stopPreview(false);
    });
  }
  clearTimeout(pv.timer);
  pv.on = true;
  const run = ++pv.run;
  await playStep(from, run);
}

async function playStep(i, run) {
  const steps = state.progression?.steps ?? [];
  while (i < steps.length && !player.canPlay(steps[i].id)) i++;
  if (run !== pv.run || !pv.on) return;
  if (i >= steps.length) return stopPreview();
  const s = steps[i];
  const w = previewWindow(state.records.get(s.id));
  Object.assign(pv, { i, id: s.id, switching: true });
  markPreview();
  previewStatus(t("{i}/{n} · {name}", { i: i + 1, n: steps.length, name: s.name }));
  const ok = await player.playAt(s.id, w.start).catch(() => false);
  pv.switching = false;
  if (run !== pv.run || !pv.on) return;
  if (!ok) return stopPreview();
  pv.timer = setTimeout(() => playStep(i + 1, run), w.len * 1000);
}

function stopPreview(stopSound = true) {
  if (!pv.on) return;
  clearTimeout(pv.timer);
  pv.run++;
  const was = pv.id;
  Object.assign(pv, { on: false, i: -1, id: null, switching: false });
  if (stopSound && player.isPlaying(was)) player.stop();
  markPreview();
  previewStatus("");
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
      sel.innerHTML = `<option value="">—</option>` + lists.map((p) => `<option value="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}${p.count != null ? ` (${p.count})` : ""}</option>`).join("");
      if (lists.some((p) => p.id === keep)) sel.value = keep;
      sp.loaded = true;
      showAddRow();
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
