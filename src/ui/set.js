// Set tab: target curve editor, options and constraints, generated set with
// per-transition fluidity, exports (M3U, text, Spotify) and playlist split.

import { state } from "../app/store.js";
import { isCounted } from "../core/track.js";
import * as ctl from "../app/controller.js";
import { generateSet, splitTracks, CURVE_PRESETS, TRANSITION_CRITERIA } from "../playlist/set.js";
import { toM3U, toText } from "../playlist/progression.js";
import { groups } from "../scoring/similarity.js";
import { matchPlaylist } from "../spotify/match.js";
import { createFromRecords } from "../spotify/export.js";
import { keyName, camelot } from "../audio/music.js";
import { stageFor } from "../config.js";
import { moodLabel } from "../scoring/describe.js";
import { escapeHtml, formatDuration, formatScore } from "../util/format.js";
import { CurveEditor } from "./curve-editor.js";
import { intensityColor } from "./live-draw.js";
import { toast } from "./toast.js";
import { t, tn } from "../i18n/index.js";

const $ = (id) => document.getElementById(id);
const STORE = "mea.set.options";

const st = {
  editor: null,
  points: CURVE_PRESETS[0].points,
  preset: CURVE_PRESETS[0].key,
  weights: Object.fromEntries(TRANSITION_CRITERIA.map((c) => [c.key, c.default])),
  locked: new Set(),
  excluded: new Set(),
  result: null,
  split: null,
  playlists: [],
  openDetail: () => {},
};

export function initSet({ openDetail }) {
  st.openDetail = openDetail;
  restore();
  $("set-preset").innerHTML = CURVE_PRESETS.map((p) => `<option value="${p.key}">${escapeHtml(p.label)}</option>`).join("") + `<option value="custom">${t("Custom")}</option>`;
  $("set-preset").value = st.preset;
  $("set-preset").addEventListener("change", (e) => {
    const p = CURVE_PRESETS.find((x) => x.key === e.target.value);
    st.preset = e.target.value;
    if (p) { st.points = p.points; st.editor.setPoints(p.points); }
    save();
    if (st.result) generate();
  });
  st.editor = new CurveEditor($("set-canvas"), {
    points: st.points,
    onChange: (pts) => {
      st.points = pts;
      st.preset = "custom";
      $("set-preset").value = "custom";
      save();
      if (st.result) generate();
    },
  });
  $("set-weights").innerHTML = TRANSITION_CRITERIA.map((c) => `
    <label class="weight-row"><span>${c.label}</span>
      <input type="range" min="0" max="2" step="0.1" value="${st.weights[c.key]}" data-w="${c.key}">
      <output>${Number(st.weights[c.key]).toFixed(1)}</output></label>`).join("");
  $("set-weights").addEventListener("input", (e) => {
    const k = e.target.dataset.w;
    if (!k) return;
    st.weights[k] = Number(e.target.value);
    e.target.nextElementSibling.textContent = st.weights[k].toFixed(1);
  });
  $("set-weights").addEventListener("change", () => { save(); if (st.result) generate(); });
  for (const id of ["set-duration", "set-first", "set-last", "set-artist"]) $(id).addEventListener("change", save);
  $("set-source").addEventListener("change", () => { fillTrackSelects(); save(); });
  $("set-generate").addEventListener("click", generate);
  $("set-result").addEventListener("click", onResultClick);
  $("split-preview").addEventListener("click", previewSplit);
  $("split-result").addEventListener("click", onSplitClick);
}

export async function showSet() {
  st.playlists = await ctl.importedPlaylists();
  const src = $("set-source");
  const cur = src.value || st.savedSource || "library";
  src.innerHTML = `<option value="library">${t("Whole library ({n} tracks)", { n: countAnalysed() })}</option>` +
    st.playlists.map((p) => `<option value="pl:${escapeHtml(p.id)}">${t("Spotify playlist")} · ${escapeHtml(p.name)}</option>`).join("");
  src.value = [...src.options].some((o) => o.value === cur) ? cur : "library";
  fillTrackSelects();
  st.editor.draw();
}

const countAnalysed = () => [...state.records.values()].filter(isCounted).length;

/** Record ids of the chosen source (library, or tracks of a playlist that are analysed). */
function sourceIds() {
  const v = $("set-source").value;
  if (!v.startsWith("pl:")) return null;
  const pl = st.playlists.find((p) => p.id === v.slice(3));
  if (!pl) return null;
  const records = [...state.records.values()];
  const m = matchPlaylist(pl.tracks, records, {});
  return pl.tracks.map((t) => m.get(t.id)?.recordId).filter((id) => id && isCounted(state.records.get(id)));
}

function pool() {
  const ids = sourceIds();
  return ctl.setPool(ids).filter((t) => !st.excluded.has(t.id));
}

function fillTrackSelects() {
  const items = pool().sort((a, b) => a.name.localeCompare(b.name));
  const opts = `<option value="">— ${t("free")} —</option>` + items.map((it) => `<option value="${escapeHtml(it.id)}">${escapeHtml(it.name)} (${Math.round(it.score)})</option>`).join("");
  for (const id of ["set-first", "set-last"]) {
    const sel = $(id);
    const cur = sel.value || st[`saved_${id}`] || "";
    sel.innerHTML = opts;
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }
}

function generate() {
  const items = pool();
  if (items.length < 2) return toast(t("At least two analysed tracks are needed in the chosen source."), "error");
  const minutes = Number($("set-duration").value) || 0;
  const t0 = performance.now();
  st.result = generateSet(items, {
    points: st.points,
    weights: st.weights,
    duration: minutes > 0 ? minutes * 60 : null,
    first: $("set-first").value || null,
    last: $("set-last").value || null,
    locked: [...st.locked],
    noSameArtist: $("set-artist").checked,
  });
  st.result.ms = Math.round(performance.now() - t0);
  st.editor.setSet(st.result.steps, st.result.stats.duration);
  renderResult();
}

function fluidColor(f) {
  return f >= 75 ? "var(--good)" : f >= 55 ? "var(--warn)" : "var(--bad)";
}

function transitionTip(s) {
  const tr = s.transition;
  if (!tr) return "";
  const lines = [
    `${t("Smoothness")} ${tr.fluidity} / 100`,
    `${t("Intensity seam")}: ${Math.round((s.start ?? s.score) - (st.prev.end ?? st.prev.score))} ${t("points")}`,
    st.prev.bpmEnd || st.prev.bpm ? `${t("Tempo")}: ${Math.round(st.prev.bpmEnd ?? st.prev.bpm)} → ${Math.round(s.bpmStart ?? s.bpm ?? 0)} BPM` : t("Unknown tempo"),
    st.prev.keyEnd != null && s.keyStart != null ? `${t("Key")}: ${camelot(st.prev.keyEnd ?? st.prev.key)} → ${camelot(s.keyStart ?? s.key)} (${tr.key < 0.2 ? t("compatible") : tr.key < 0.6 ? t("acceptable") : t("dissonant")})` : t("Unknown key"),
    `${t("Timbre")}: ${tr.timbre < 0.35 ? t("close") : tr.timbre < 0.7 ? t("different") : t("very different")}`,
    `${t("Mood")}: ${tr.mood < 0.3 ? t("close") : tr.mood < 0.6 ? t("different") : t("opposite")}`,
  ];
  return lines.join("\n");
}

function renderResult() {
  const res = st.result;
  const out = $("set-result");
  if (!res?.steps.length) { out.innerHTML = ""; return; }
  const s = res.stats;
  const rows = res.steps.map((step, i) => {
    st.prev = res.steps[i - 1];
    const r = state.records.get(step.id);
    const m = r?.auto?.music;
    const diff = step.score - step.target;
    const tr = step.transition;
    return `<li class="set-row${st.locked.has(step.id) ? " locked" : ""}" data-id="${escapeHtml(step.id)}">
      ${tr ? `<div class="set-trans" title="${escapeHtml(transitionTip(step))}"><span class="fl" style="background:${fluidColor(tr.fluidity)}">${tr.fluidity}</span>
        <span class="muted small">${[tr.bpm > 0.6 && t("tempo ≠"), tr.key > 0.6 && t("key ≠"), tr.seam > 0.5 && t("intensity jump"), tr.timbre > 0.7 && t("timbre ≠"), tr.mood > 0.6 && t("mood ≠")].filter(Boolean).join(" · ")}</span></div>` : ""}
      <div class="set-track">
        <span class="pos">${step.position}</span>
        <span class="time muted small">${formatDuration(step.startAt)}</span>
        <button type="button" class="link-btn nm" data-act="open">${escapeHtml(step.name)}</button>
        <span class="set-meta small">${m?.key ? `<b>${escapeHtml(m.key.camelot)}</b> ` : ""}${m?.tempo ? `${Math.round(m.tempo.bpm)} BPM ` : ""}<span class="muted">${escapeHtml(moodLabel(r?.finalScore, r?.valence))}</span></span>
        <span class="score-pill" style="background:${intensityColor(step.score)}" title="${escapeHtml(stageFor(step.score).label)} · ${t("target {n}", { n: Math.round(step.target) })}">${formatScore(step.score)}</span>
        <span class="diff small ${Math.abs(diff) > 15 ? "far" : ""}" title=t("gap to the curve")>${diff >= 0 ? "+" : ""}${Math.round(diff)}</span>
        <button type="button" class="icon-btn" data-act="lock" title="${st.locked.has(step.id) ? t("Unlock") : t("Keep this track in the set")}" aria-pressed="${st.locked.has(step.id)}">${st.locked.has(step.id) ? "🔒" : "🔓"}</button>
        <button type="button" class="icon-btn" data-act="exclude" title=t("Remove and exclude from generation")>✕</button>
      </div>
    </li>`;
  }).join("");
  out.innerHTML = `
    <div class="stats">
      <span>${tn(s.count, "<b>{n}</b> track", "<b>{n}</b> tracks")}</span>
      <span><b>${formatDuration(s.duration)}</b></span>
      <span>${t("gap to the curve")} <b>${s.curveError}</b> pts</span>
      <span>${t("mean smoothness")} <b style="color:${fluidColor(s.meanFluidity)}">${s.meanFluidity}</b> / 100</span>
      <span>${tn(s.rough, "<b>{n}</b> rough transition", "<b>{n}</b> rough transitions")}</span>
      <span class="muted small">${t("computed in {n} ms", { n: res.ms })}</span>
    </div>
    <div class="toolbar">
      <button class="btn" data-act="regen" type="button">${t("Regenerate")}</button>
      ${st.excluded.size ? `<button class="btn ghost" data-act="unexclude" type="button">${t("Bring back the {n} excluded", { n: st.excluded.size })}</button>` : ""}
      <span class="spacer"></span>
      <button class="btn" data-act="m3u" type="button">M3U</button>
      <button class="btn" data-act="txt" type="button">${t("Text")}</button>
      <input type="text" id="set-name" value="Set · ${escapeHtml(CURVE_PRESETS.find((p) => p.key === st.preset)?.label ?? t("custom curve"))}" aria-label="${t("Playlist name")}">
      <button class="btn primary" data-act="spotify" type="button">${t("Create on Spotify")}</button>
    </div>
    <ol class="set-list">${rows}</ol>`;
}

async function onResultClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const id = el.closest("[data-id]")?.dataset.id;
  switch (el.dataset.act) {
    case "open": st.openDetail(id); break;
    case "lock": st.locked.has(id) ? st.locked.delete(id) : st.locked.add(id); renderResult(); break;
    case "exclude": st.excluded.add(id); st.locked.delete(id); fillTrackSelects(); generate(); break;
    case "unexclude": st.excluded.clear(); fillTrackSelects(); generate(); break;
    case "regen": generate(); break;
    case "m3u": download(toM3U(steps()), "set.m3u", "audio/x-mpegurl"); break;
    case "txt": download(toText(steps()), "set.txt", "text/plain"); break;
    case "spotify": {
      const name = $("set-name").value.trim() || "Set";
      const ids = st.result.steps.map((s) => s.id);
      if (!confirm(t("Create the private playlist “{name}” ({n} tracks) on your Spotify account?", { name, n: ids.length }))) return;
      try {
        const res = await createFromRecords(name, ids, t("Set generated on an intensity curve (Music Energy Analyzer)."));
        toast(t("Playlist created: {n} tracks", { n: res.added }) + (res.missing ? t(", {n} without a Spotify match", { n: res.missing }) : "") + ".");
        if (res.url) window.open(res.url, "_blank", "noopener");
      } catch (err) {
        toast(err.message, "error", 7000);
      }
      break;
    }
  }
}

const steps = () => st.result.steps.map((s) => ({ ...s, stage: stageFor(s.score).label }));

// ------------------------------------------------------------------ split

function previewSplit() {
  const items = pool();
  if (items.length < 2) return toast(t("Not enough analysed tracks."), "error");
  const by = $("split-by").value;
  const n = Math.max(2, Math.min(8, Number($("split-n").value) || 3));
  let gm = null;
  if (by === "groups") {
    gm = groups(new Map(items.filter((t) => t.fp).map((t) => [t.id, t.fp])), n);
    if (!gm.size) return toast(t("Splitting by timbre needs tracks analysed with version 1.3 or later."), "error");
  } else if (by === "genre") {
    // one playlist per genre (the number is ignored); unlabelled tracks together
    gm = new Map(items.map((it) => [it.id, ctl.genreInfo(state.records.get(it.id)).label ?? t("No genre")]));
  }
  st.split = splitTracks(items, by === "genre" ? "groups" : by, n, gm).map((p, i) => ({ ...p, name: by === "genre" ? p.label : splitName(by, p, i) }));
  renderSplit();
}

function splitName(by, p, i) {
  const avg = p.items.reduce((a, t) => a + t.score, 0) / p.items.length;
  if (by === "stage") return `${stageFor(p.range[0]).label} → ${stageFor(p.range[1]).label}`;
  if (by === "mood") {
    const v = p.items.reduce((a, t) => a + (t.valence ?? 50), 0) / p.items.length;
    return `${moodLabel(avg, v)} (${t("mood")} ${Math.round(p.range[0])}–${Math.round(p.range[1])})`;
  }
  const keys = p.items.map((t) => t.key).filter((k) => k != null);
  const common = keys.length ? keyName(mode(keys)) : "";
  return `${t("Group {n}", { n: i + 1 })} · ${t("intensity")} ${Math.round(avg)}${common ? ` · ${t("often {k}", { k: common })}` : ""}`;
}

function mode(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function renderSplit() {
  $("split-result").innerHTML = st.split.map((p, i) => `
    <div class="split-part">
      <div class="split-head"><input type="text" value="${escapeHtml(p.name)}" data-split-name="${i}" aria-label="${t("Playlist name")} ${i + 1}">
        <span class="muted small">${tn(p.ids.length, "{n} track", "{n} tracks")} · ${formatDuration(p.items.reduce((a, t) => a + (t.duration ?? 0), 0))}</span>
        <button class="btn small" data-split-create="${i}" type="button">${t("Create on Spotify")}</button></div>
      <div class="split-chips">${p.items.slice(0, 40).map((t) => `<span class="split-chip" style="border-color:${intensityColor(t.score)}" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>`).join("")}${p.items.length > 40 ? `<span class="muted small">+${p.items.length - 40}</span>` : ""}</div>
    </div>`).join("") + (st.split.length ? `<button class="btn primary" data-split-all type="button">${t("Create the {n} playlists on Spotify", { n: st.split.length })}</button>` : "");
}

async function onSplitClick(e) {
  const one = e.target.closest("[data-split-create]");
  const all = e.target.closest("[data-split-all]");
  if (!one && !all) return;
  const idx = one ? [Number(one.dataset.splitCreate)] : st.split.map((_, i) => i);
  if (!confirm(tn(idx.length, "Create {n} private playlist on your Spotify account?", "Create {n} private playlists on your Spotify account?"))) return;
  for (const i of idx) {
    const name = $("split-result").querySelector(`[data-split-name="${i}"]`)?.value.trim() || st.split[i].name;
    try {
      const res = await createFromRecords(name, st.split[i].ids, t("Automatic split (Music Energy Analyzer)."));
      toast(`“${name}”: ${tn(res.added, "{n} track", "{n} tracks")}${res.missing ? t(", {n} without a Spotify match", { n: res.missing }) : ""}.`);
    } catch (err) {
      toast(`“${name}”: ${err.message}`, "error", 7000);
      break;
    }
  }
}

// ------------------------------------------------------------------ misc

function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      points: st.points, preset: st.preset, weights: st.weights,
      duration: $("set-duration").value, artist: $("set-artist").checked, source: $("set-source").value,
      first: $("set-first").value, last: $("set-last").value,
    }));
  } catch { /* storage blocked */ }
}

function restore() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(STORE)); } catch { /* ignore */ }
  if (!o) return;
  if (Array.isArray(o.points) && o.points.length >= 2) st.points = o.points;
  if (o.preset) st.preset = o.preset;
  if (o.weights) Object.assign(st.weights, o.weights);
  if (o.duration != null) $("set-duration").value = o.duration;
  if (o.artist != null) $("set-artist").checked = o.artist;
  st.savedSource = o.source;
  st["saved_set-first"] = o.first;
  st["saved_set-last"] = o.last;
}
