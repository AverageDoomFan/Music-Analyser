// "Live" tab: scans the imported Spotify playlist by playing it on the
// user's Spotify app and analysing the captured sound in real time.

import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import * as auth from "../spotify/auth.js";
import * as api from "../spotify/api.js";
import { matchPlaylist } from "../spotify/match.js";
import { analyzePcm } from "../audio/analyzer.js";
import { startCapture, audioInputs, captureSupport } from "../live/capture.js";
import { Scanner } from "../live/scanner.js";
import { createDemo } from "../live/demo.js";
import { SCAN_MODES, SCAN_DEFAULTS, MODE_RANK, estimateTrackSeconds, coveredSeconds } from "../live/plan.js";
import { DIMENSIONS, stageFor, LYRICS_MOODS, LYRICS_LEVELS } from "../config.js";
import { t, tn } from "../i18n/index.js";
import { escapeHtml, formatDuration } from "../util/format.js";
import { toast } from "./toast.js";
import { rememberDevice } from "./player.js";
import {
  drawGauge, drawTimeline, drawCurve, drawRadar, drawHistogram, SpectrumView, Spectrogram, Meters,
  intensityColor, sparkSvg, fmtTime, DIM_COLORS,
} from "./live-draw.js";

const $ = (id) => document.getElementById(id);
const OPTS_KEY = "mea.live.options";

const lv = {
  capture: null,
  scanner: null,
  status: null,
  playlist: null,
  devices: [],
  mode: SCAN_DEFAULTS.mode,
  enabled: new Set(["intensity"]),
  gauge: { shown: null },
  lastUpdate: 0,
  dirty: true,
  queueKey: "",
  wakeLock: null,
  openDetail: () => {},
  demo: null,          // demo instance (fake Spotify + stream)
  pendingLyrics: new Map(), // track id -> { vocals, mood, strength } rated before the track is saved
  lyricsKey: "",
};
const demoOn = () => $("lv-demo").checked;
const spectrum = new SpectrumView(96);
const spectrogram = new Spectrogram();
const meters = new Meters();

export function initLive({ openDetail }) {
  lv.openDetail = openDetail;
  restoreOptions();
  buildModes();
  buildChips();
  const sup = captureSupport();
  if (!sup.system) document.querySelector('input[name="lv-source"][value="system"]').disabled = true;

  document.querySelectorAll('input[name="lv-source"]').forEach((r) => r.addEventListener("change", () => {
    $("lv-device-row").hidden = source() !== "device";
    if (source() === "device") listInputs(false);
    saveOptions();
  }));
  $("lv-device-refresh").addEventListener("click", () => listInputs(true));
  $("lv-device").addEventListener("change", saveOptions);
  $("lv-capture").addEventListener("click", () => (lv.capture ? stopCaptureNow() : beginCapture().catch(showError)));
  $("lv-spdevice-refresh").addEventListener("click", () => loadDevices().catch(showError));
  $("lv-spdevice").addEventListener("change", (e) => rememberDevice(e.target.value));
  $("lv-reconnect").addEventListener("click", () => auth.beginLogin().catch(showError));
  for (const id of ["lv-count", "lv-length", "lv-budget", "lv-gap", "lv-skip-files", "lv-rescan"]) $(id).addEventListener("change", () => { saveOptions(); renderEstimate(); });
  $("lv-start").addEventListener("click", () => startScan().catch(showError));
  $("lv-demo").addEventListener("change", () => toggleDemo().catch(showError));
  $("lv-demo-audible").addEventListener("change", (e) => lv.demo?.setAudible(e.target.checked));
  $("lv-pause").addEventListener("click", () => (lv.status?.paused ? lv.scanner?.resume() : lv.scanner?.pause()));
  $("lv-skip").addEventListener("click", () => lv.scanner?.skip());
  $("lv-stop").addEventListener("click", () => lv.scanner?.stop());
  $("lv-lyrics").addEventListener("click", (e) => onLyricsClick(e).catch(showError));
  $("lv-queue").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-record]");
    if (li) lv.openDetail(li.dataset.record);
  });
  $("lv-device-row").hidden = source() !== "device";
  window.addEventListener("beforeunload", (e) => { if (lv.status?.running) e.preventDefault(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && lv.status?.running) requestWakeLock(); });
  subscribe(() => { if (visible()) renderSession(); });
  requestAnimationFrame(loop);
}

/** Called when the tab becomes visible. */
export async function showLive() {
  lv.dirty = true;
  lv.playlist = demoOn() && lv.demo ? demoPlaylist() : await ctl.spotifyStore.get("playlist").catch(() => null);
  renderSetup();
  renderQueue(true);
  renderSession();
  if (auth.isLoggedIn() && !lv.devices.length) loadDevices().catch(() => {});
}

// ------------------------------------------------------------------ setup

const source = () => (demoOn() ? "stream" : document.querySelector('input[name="lv-source"]:checked')?.value ?? "system");

const demoPlaylist = () => ({ id: "demo", name: `${t("Demo")} · ${t("test bench")}`, tracks: lv.demo.tracks });

async function toggleDemo() {
  if (lv.status?.running) {
    $("lv-demo").checked = !demoOn();
    return toast(t("Stop the current scan first."));
  }
  if (lv.capture) stopCaptureNow();
  $("lv-demo-audible-row").hidden = !demoOn();
  if (demoOn()) {
    if (!lv.demo) {
      $("lv-playlist-info").textContent = t("Preparing the demo tracks…");
      lv.demo = await createDemo({
        audible: $("lv-demo-audible").checked,
        onProgress: (d, n) => { $("lv-playlist-info").textContent = `${t("Preparing the demo tracks…")} ${d}/${n}`; },
      });
    }
    lv.playlist = demoPlaylist();
  } else {
    lv.playlist = await ctl.spotifyStore.get("playlist").catch(() => null);
  }
  lv.status = null;
  lv.lastCurrent = null;
  renderSetup();
  renderQueue(true);
  renderSession();
}

function options() {
  const num = (id, lo, hi, d) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  };
  return {
    mode: lv.mode,
    count: num("lv-count", 1, 12, SCAN_DEFAULTS.count),
    length: num("lv-length", 6, 60, SCAN_DEFAULTS.length),
    budget: num("lv-budget", 30, 240, SCAN_DEFAULTS.budget),
    maxGap: num("lv-gap", 8, 40, SCAN_DEFAULTS.maxGap),
    rescan: $("lv-rescan").checked,
    skipFiles: $("lv-skip-files").checked,
  };
}

function saveOptions() {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify({ ...options(), source: source(), device: $("lv-device").value }));
  } catch { /* storage blocked */ }
}

function restoreOptions() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(OPTS_KEY)); } catch { /* ignore */ }
  if (!o) return;
  if (SCAN_MODES.some((m) => m.key === o.mode)) lv.mode = o.mode;
  for (const [id, k] of [["lv-count", "count"], ["lv-length", "length"], ["lv-budget", "budget"], ["lv-gap", "maxGap"]]) if (o[k] != null) $(id).value = o[k];
  $("lv-rescan").checked = !!o.rescan;
  $("lv-skip-files").checked = o.skipFiles !== false;
  const r = document.querySelector(`input[name="lv-source"][value="${o.source}"]`);
  if (r) r.checked = true;
  lv.savedDevice = o.device;
}

function buildModes() {
  const box = $("lv-modes");
  box.innerHTML = SCAN_MODES.map((m) => `<button type="button" role="radio" data-mode="${m.key}" title="${escapeHtml(m.hint)}">${m.label}</button>`).join("");
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b || lv.status?.running) return;
    lv.mode = b.dataset.mode;
    renderModes();
    saveOptions();
    renderEstimate();
  });
  renderModes();
}

function renderModes() {
  document.querySelectorAll("#lv-modes button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === lv.mode)));
  $("lv-params-fixed").hidden = lv.mode !== "fixed";
  $("lv-params-adaptive").hidden = lv.mode !== "adaptive";
}

function buildChips() {
  const items = [{ key: "intensity", label: t("Intensity"), color: "#ffffff" }, ...DIMENSIONS.map((d) => ({ key: d.key, label: d.label, color: DIM_COLORS[d.key] }))];
  const box = $("lv-curve-chips");
  box.innerHTML = items.map((i) => `<button type="button" data-key="${i.key}" style="--chip:${i.color}" aria-pressed="${lv.enabled.has(i.key)}">${i.label}</button>`).join("");
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (!b) return;
    const k = b.dataset.key;
    lv.enabled.has(k) ? lv.enabled.delete(k) : lv.enabled.add(k);
    b.setAttribute("aria-pressed", String(lv.enabled.has(k)));
    lv.dirty = true;
  });
}

async function listInputs(ask) {
  try {
    const list = await audioInputs({ ask });
    const sel = $("lv-device");
    const cur = sel.value || lv.savedDevice;
    sel.innerHTML = list.length ? list.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)}${d.virtual ? " ★" : ""}</option>`).join("") : `<option value="">${t("No input (click “List”)")}</option>`;
    const pick = list.find((d) => d.id === cur) ?? list.find((d) => /cable output/i.test(d.label)) ?? list.find((d) => d.virtual);
    if (pick) sel.value = pick.id;
  } catch (err) {
    showError(err);
  }
}

async function loadDevices() {
  if (!auth.isLoggedIn()) return;
  lv.devices = await api.devices();
  const sel = $("lv-spdevice");
  const cur = sel.value;
  sel.innerHTML = lv.devices.length
    ? lv.devices.map((d) => `<option value="${escapeHtml(d.id)}" ${d.restricted ? "disabled" : ""}>${escapeHtml(d.name)} · ${escapeHtml(d.type)}${d.active ? t(" (active)") : ""}</option>`).join("")
    : `<option value="">${t("No device: open Spotify on this PC")}</option>`;
  const pick = lv.devices.find((d) => d.id === cur) ?? lv.devices.find((d) => d.active && d.type === "Computer") ?? lv.devices.find((d) => d.type === "Computer") ?? lv.devices.find((d) => d.active);
  if (pick) sel.value = pick.id;
}

function renderSetup() {
  if (demoOn() && lv.demo) {
    $("lv-scope-warn").hidden = true;
    $("lv-playlist-info").innerHTML = t("Demo: <b>{n} synthetic tracks</b> played by a fake Spotify. Results join the library, tagged “Test”.", { n: lv.demo.tracks.length });
    renderEstimate();
    return;
  }
  const logged = auth.isLoggedIn();
  $("lv-scope-warn").hidden = !logged || auth.hasScopes(auth.PLAYBACK_SCOPES);
  const pl = lv.playlist;
  $("lv-playlist-info").innerHTML = !logged
    ? t("Log in to your account in the Spotify tab.")
    : pl ? `${t("Playlist:")} <b>${escapeHtml(pl.name)}</b> · ${tn(pl.tracks.length, "{n} track", "{n} tracks")}` : t("Import a playlist in the Spotify tab first.");
  renderEstimate();
}

/** Tracks that would be scanned with the current options. */
function scanList() {
  const pl = lv.playlist;
  if (!pl) return { tracks: [], todo: [] };
  const o = options();
  const files = [...state.records.values()].filter((r) => r.source?.kind !== "spotify");
  const manual = {};
  const matches = o.skipFiles ? matchPlaylist(pl.tracks, files, manual) : new Map();
  const todo = pl.tracks.filter((t) => !t.isLocal && !isDone(t, o, matches));
  return { tracks: pl.tracks, todo, matches };
}

function isDone(track, o, matches) {
  if (o.skipFiles && matches?.has(track.id) && state.records.get(matches.get(track.id).recordId)?.finalScore != null) return true;
  if (o.rescan) return false;
  const r = ctl.capturedRecord(track);
  return !!r && (MODE_RANK[r.source?.mode] ?? 0) >= (MODE_RANK[o.mode] ?? 0);
}

function renderEstimate() {
  const { tracks, todo } = scanList();
  if (!tracks.length) {
    $("lv-estimate").textContent = "";
    $("lv-setup-summary").textContent = "";
    return;
  }
  const o = options();
  const secs = todo.reduce((a, t) => a + estimateTrackSeconds((t.durationMs ?? 0) / 1000, o), 0);
  $("lv-estimate").textContent = t("{n} of {total} tracks to analyse · estimated time {d}.", { n: todo.length, total: tracks.length, d: formatLong(secs) });
  $("lv-setup-summary").textContent = `${SCAN_MODES.find((m) => m.key === o.mode).label} · ${t("{n}/{total} tracks", { n: todo.length, total: tracks.length })} · ~${formatLong(secs)}`;
}

// ------------------------------------------------------------------ capture

async function beginCapture() {
  if (lv.capture) return lv.capture;
  const src = source();
  $("lv-capture-status").textContent = t("permission…");
  try {
    lv.capture = await startCapture({
      source: src,
      stream: src === "stream" ? lv.demo?.stream : undefined,
      deviceId: src === "device" ? $("lv-device").value || undefined : undefined,
      onData: (b) => {
        lv.scanner?.feed(b);
        let p = 0;
        for (let i = 0; i < b.length; i += 4) { const a = Math.abs(b[i]); if (a > p) p = a; }
        lv.level = Math.max(p, (lv.level ?? 0) * 0.92);
      },
      onEnded: () => {
        lv.capture = null;
        renderCapture();
        if (lv.status?.running) {
          lv.scanner?.pause();
          toast(t("Audio sharing interrupted: scan paused. Turn the capture back on, then resume."), "error", 8000);
        }
      },
    });
  } catch (err) {
    lv.capture = null;
    renderCapture();
    if (err?.name === "NotAllowedError") throw new Error(t("Capture refused."));
    throw err;
  }
  renderCapture();
  if (src === "device") listInputs(false);
  return lv.capture;
}

function stopCaptureNow() {
  if (lv.status?.running) lv.scanner?.pause();
  lv.capture?.stop();
  lv.capture = null;
  renderCapture();
}

function renderCapture() {
  const c = lv.capture;
  const st = $("lv-capture-status");
  st.textContent = c ? `${c.label}${c.contextRate !== 44100 ? ` · ${c.contextRate} Hz → 44,1 kHz` : ""}` : t("off");
  st.className = `lv-chip ${c ? "ok" : ""}`;
  $("lv-capture").textContent = c ? t("Stop the capture") : t("Start the capture");
}

// ------------------------------------------------------------------ scan

async function startScan() {
  if (lv.status?.running) return;
  const demo = demoOn();
  if (demo && !lv.demo) await toggleDemo();
  if (!demo) {
    if (!auth.isLoggedIn()) throw new Error(t("Log in to Spotify first (Spotify tab), or tick “Demo mode”."));
    if (!auth.hasScopes(auth.PLAYBACK_SCOPES)) {
      $("lv-scope-warn").hidden = false;
      throw new Error(t("Log in to Spotify again to allow playback control."));
    }
  }
  lv.playlist = demo ? demoPlaylist() : await ctl.spotifyStore.get("playlist").catch(() => null);
  const { todo } = scanList();
  if (!lv.playlist) throw new Error(t("Import a playlist in the Spotify tab first."));
  if (!todo.length) return toast(t("Every track is already analysed with this mode (tick “Re-analyse” to start again)."));
  await beginCapture();
  let player;
  if (demo) {
    player = lv.demo.player;
  } else {
    if (!$("lv-spdevice").value) await loadDevices();
    const deviceId = $("lv-spdevice").value;
    rememberDevice(deviceId);
    if (!deviceId) throw new Error(t("No Spotify device: open the Spotify app on this PC, then “Refresh”."));
    player = {
      play: (uri, ms) => api.play(deviceId, uri, ms),
      pause: () => api.pause(deviceId),
      state: () => api.playbackState(),
    };
  }
  const o = options();
  lv.scanner = new Scanner({
    player,
    analyze: (mono, sr, extra) => analyzePcm(mono, sr, extra),
    analyzeLive: (mono, sr, extra) => analyzePcm(mono, sr, extra),
    save: async (track, features, info) => {
      const rec = await ctl.saveCaptured(track, features, info);
      await applyPendingLyrics(track);
      return rec;
    },
    scoring: ctl.scoring,
    onUpdate: (s) => { lv.status = s; lv.lastUpdate = performance.now(); lv.dirty = true; },
  });
  $("lv-setup").open = false;
  requestWakeLock();
  setRunning(true);
  try {
    const st = await lv.scanner.run(todo, { ...o, rescan: true });
    const c = st.counts;
    if (st.error) toast(t("Scan interrupted: {msg}", { msg: st.error }), "error", 9000);
    else toast(`${t(lv.scanner.stopRequested ? "Scan stopped" : "Scan finished")}: ${tn(c.done, "{n} track analysed", "{n} tracks analysed")}${c.error ? `, ${tn(c.error, "{n} error", "{n} errors")}` : ""}.`);
  } finally {
    setRunning(false);
    releaseWakeLock();
    renderEstimate();
  }
}

function setRunning(on) {
  $("lv-start").disabled = on;
  $("lv-pause").disabled = !on;
  $("lv-skip").disabled = !on;
  $("lv-stop").disabled = !on;
  $("live-tab-dot").classList.toggle("on", on);
  document.querySelectorAll("#lv-modes button").forEach((b) => { b.disabled = on; });
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !lv.wakeLock) {
      lv.wakeLock = await navigator.wakeLock.request("screen");
      lv.wakeLock.addEventListener("release", () => { lv.wakeLock = null; });
    }
  } catch { /* not allowed: fine */ }
}
function releaseWakeLock() {
  lv.wakeLock?.release().catch(() => {});
  lv.wakeLock = null;
}

// ------------------------------------------------------------------ rendering

const visible = () => !$("panel-live").hidden && !document.hidden;

function loop(now) {
  requestAnimationFrame(loop);
  if (!visible()) return;
  const s = lv.status;
  const cur = s?.current ?? lv.lastCurrent ?? null;
  if (s?.current) lv.lastCurrent = s.current;
  const recording = cur?.plan?.some((g) => g.state === "recording") && !s?.paused;
  // playhead interpolated between scanner updates
  const pos = cur ? Math.min(cur.duration, (cur.position ?? 0) + (recording ? (performance.now() - lv.lastUpdate) / 1000 : 0)) : null;

  // always-moving visuals
  const an = lv.capture?.analyser ?? null;
  spectrum.draw($("lv-spectrum"), an);
  spectrogram.draw($("lv-spectrogram"), an);
  meters.draw($("lv-meters"), lv.capture, cur?.loudness, now);
  $("lv-level-bar").style.width = `${Math.min(100, Math.max(0, (20 * Math.log10((lv.level ?? 0) + 1e-9) + 60) / 60) * 100)}%`;
  if (lv.level) lv.level *= 0.97;
  drawTimeline($("lv-timeline"), cur, pos, now);

  // gauge eases towards the latest window intensity
  const target = cur?.final?.score ?? cur?.live?.current?.intensity ?? null;
  if (target != null) lv.gauge.shown = lv.gauge.shown == null ? target : lv.gauge.shown + (target - lv.gauge.shown) * 0.08;
  const trackScore = cur?.final?.score ?? cur?.live?.scoring?.score ?? null;
  drawGauge($("lv-gauge"), {
    value: lv.gauge.shown,
    score: trackScore,
    label: lv.gauge.shown != null ? stageFor(lv.gauge.shown).label : t("intensity"),
    caption: trackScore != null ? `${cur?.final ? t("final score") : t("provisional score")} ${Math.round(trackScore)}` : "",
    active: recording,
  });
  if (cur) {
    $("lv-pos").textContent = fmtTime(pos);
    $("lv-dur").textContent = fmtTime(cur.duration);
  }

  if (lv.dirty || recording) drawCurve($("lv-curve"), { cur, enabled: lv.enabled, position: recording ? pos : null });
  if (lv.dirty) {
    lv.dirty = false;
    renderNow(s, cur);
    renderLyrics(cur);
    drawRadar($("lv-radar"), { current: cur?.live?.current?.subscores ?? null, aggregate: cur?.final ? null : cur?.live?.scoring?.subscores ?? null });
    renderTiles(cur);
    renderLoudness(cur);
    renderQueue();
    renderOverall(s);
  }
}

function renderNow(s, cur) {
  $("lv-pulse").classList.toggle("on", !!s?.running && !s?.paused);
  $("lv-phase").textContent = !s ? t("Waiting") : s.paused ? t("Paused") : s.running ? (s.phase || "…") : (s.phase || t("Waiting"));
  $("lv-pause").textContent = s?.paused ? t("▶ Resume") : t("❚❚ Pause");
  if (!cur) return;
  const tk = cur.track;
  if (lv.shownTrack !== tk.id) {
    lv.shownTrack = tk.id;
    lv.gauge.shown = null;
    $("lv-title").textContent = tk.name;
    $("lv-artist").textContent = [tk.artists?.join(", "), tk.album].filter(Boolean).join(" · ");
    const img = tk.imageLarge || tk.image;
    $("lv-cover").innerHTML = img ? `<img src="${escapeHtml(img)}" alt="" referrerpolicy="no-referrer">` : "<span>♪</span>";
    $("lv-backdrop").style.backgroundImage = img ? `url("${img.replace(/"/g, "")}")` : "none";
  }
  const heard = coveredSeconds(cur.plan.filter((g) => g.filled).map((g) => ({ pos: g.recordedFrom ?? g.pos, len: g.filled })));
  const done = cur.plan.filter((g) => g.state === "done").length;
  const kinds = cur.plan.length > 1 ? ` · ${t("excerpt {i}/{n}", { i: Math.min(cur.plan.length, done + 1), n: cur.plan.length })}` : "";
  $("lv-heard").textContent = `${t("{d} heard ({p} %)", { d: formatDuration(heard), p: Math.min(100, Math.round((heard / cur.duration) * 100)) })}${kinds}`;
}

// ------------------------------------------------------------------ lyrics

/** Current rating of a track: its record's, or the one waiting for the save. */
function lyricsOf(track) {
  const rec = state.records.get(ctl.capturedId(track));
  if (rec) return { rec, vocals: rec.vocals?.state ?? null, mood: rec.lyrics?.mood ?? null, strength: rec.lyrics?.strength ?? 2 };
  return { rec: null, strength: 2, ...lv.pendingLyrics.get(track.id) };
}

function renderLyrics(cur) {
  const box = $("lv-lyrics");
  const track = cur?.track;
  box.hidden = !track;
  if (!track) return;
  const r = lyricsOf(track);
  const key = `${track.id}:${r.vocals}:${r.mood}:${r.strength}:${!!r.rec}`;
  if (key === lv.lyricsKey) return;
  lv.lyricsKey = key;
  const on = (b) => `aria-pressed="${b}"`;
  box.innerHTML = `
    <span class="lv-lyrics-k">${t("Lyrics")}</span>
    <button type="button" class="chip-btn" data-lyr="instrumental" ${on(r.vocals === "instrumental")}>${t("Instrumental")}</button>
    <button type="button" class="chip-btn" data-lyr="vocal" ${on(r.vocals === "vocal" && !r.mood)}>${t("Sung")}</button>
    <span class="lv-lyrics-sep"></span>
    ${LYRICS_MOODS.map((m) => `<button type="button" class="chip-btn" data-mood="${m.key}" ${on(r.mood === m.key)} title="${escapeHtml(m.label)}">${m.icon} ${escapeHtml(m.label)}</button>`).join("")}
    ${r.mood ? `<span class="lv-lyrics-sep"></span>${[1, 2, 3].map((l) => `<button type="button" class="chip-btn" data-level="${l}" ${on(r.strength === l)}>${escapeHtml(LYRICS_LEVELS[l])}</button>`).join("")}` : ""}
    <span class="muted small">${r.rec ? "" : t("applied when the track is saved")}</span>`;
}

async function onLyricsClick(e) {
  const b = e.target.closest("button");
  const track = (lv.status?.current ?? lv.lastCurrent)?.track;
  if (!b || !track) return;
  const r = lyricsOf(track);
  let next = { vocals: r.vocals, mood: r.mood, strength: r.strength };
  if (b.dataset.lyr) next = { vocals: b.dataset.lyr, mood: null, strength: r.strength };
  else if (b.dataset.mood) next = { vocals: "vocal", mood: r.mood === b.dataset.mood ? null : b.dataset.mood, strength: r.strength };
  else if (b.dataset.level) next = { ...next, strength: Number(b.dataset.level) };
  if (r.rec) await applyLyrics(r.rec.id, next);
  else lv.pendingLyrics.set(track.id, next);
  lv.lyricsKey = "";
  renderLyrics(lv.status?.current ?? lv.lastCurrent);
}

async function applyLyrics(id, { vocals, mood, strength }) {
  if (mood) await ctl.setLyrics(id, { mood, strength });
  else {
    await ctl.setLyrics(id, null);
    await ctl.setVocalState(id, vocals ?? null);
  }
}

async function applyPendingLyrics(track) {
  const p = lv.pendingLyrics.get(track.id);
  if (!p) return;
  lv.pendingLyrics.delete(track.id);
  await applyLyrics(ctl.capturedId(track), p);
  lv.lyricsKey = "";
}

const TILES = [
  { k: "bpm", label: t("Tempo"), unit: "BPM", fmt: (v) => (v ? v.toFixed(0) : "—"), extra: (f) => (f.bpmConfidence != null ? t("reliability {n} %", { n: Math.round(f.bpmConfidence * 100) }) : "") },
  { k: "onsetRate", label: t("Attacks"), unit: "/s", fmt: (v) => v.toFixed(1) },
  { k: "kickRate", label: t("Kicks"), unit: "/s", fmt: (v) => v.toFixed(1) },
  { k: "lowPulse", label: t("Low punch"), fmt: (v) => v.toFixed(3) },
  { k: "centroidMean", label: t("Centroid"), unit: "kHz", fmt: (v) => (v / 1000).toFixed(2) },
  { k: "rolloffMean", label: t("Rolloff 85 %"), unit: "kHz", fmt: (v) => (v / 1000).toFixed(1) },
  { k: "bandwidthMean", label: t("Spectral width"), unit: "kHz", fmt: (v) => (v / 1000).toFixed(2) },
  { k: "fluxMean", label: t("Spectral flux"), fmt: (v) => v.toFixed(3) },
  { k: "flatnessMedian", label: t("Flatness"), unit: "dB", fmt: (v) => (10 * Math.log10(Math.max(v, 1e-12))).toFixed(1) },
  { k: "spectralFill", label: t("Fill"), unit: "%", fmt: (v) => (v * 100).toFixed(0) },
  { k: "bassRatio", label: t("Low-end share"), unit: "%", fmt: (v) => (v * 100).toFixed(0) },
  { k: "highRatio", label: t("High share"), unit: "%", fmt: (v) => (v * 100).toFixed(1) },
  { k: "crestDb", label: t("Crest factor"), unit: "dB", fmt: (v) => v.toFixed(1) },
  { k: "plrDb", label: t("PLR"), unit: "dB", fmt: (v) => v.toFixed(1) },
  { k: "loudnessRel", label: t("Relative level"), unit: "LU", fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1) },
  { k: "silenceRatio", label: t("Silence"), unit: "%", fmt: (v) => (v * 100).toFixed(0) },
];

function renderTiles(cur) {
  const live = cur?.live;
  const f = live?.current?.features;
  const box = $("lv-tiles");
  if (!f) {
    box.innerHTML = `<p class="muted small">${t("Measures show up after the first seconds of listening (6 s windows, updated every 3 s).")}</p>`;
    $("lv-window-info").textContent = "";
    return;
  }
  const inten = live.current.intensity;
  const series = live.series;
  // series in time order; the sparkline follows the heard order of the track
  const tiles = [
    `<div class="lv-tile"><div class="k">${t("Intensity (window)")}</div><div class="v" style="color:${intensityColor(inten)}">${Math.round(inten)}<small>${escapeHtml(stageFor(inten).label)}</small></div>${sparkSvg(live.scoring?.curves.intensity ?? [], intensityColor(inten), 0, 100)}</div>`,
    ...TILES.map((tile) => {
      const v = f.timeline?.series?.[tile.k]?.[0] ?? f[tile.k];
      const txt = Number.isFinite(v) ? tile.fmt(v) : "—";
      const ex = tile.extra ? tile.extra(f) : "";
      return `<div class="lv-tile" title="${escapeHtml(ex)}"><div class="k">${tile.label}${ex ? ` · ${escapeHtml(ex)}` : ""}</div><div class="v">${txt}${tile.unit ? `<small>${tile.unit}</small>` : ""}</div>${sparkSvg(series[tile.k] ?? [], "#7dd3fc")}</div>`;
    }),
  ];
  box.innerHTML = tiles.join("");
  $("lv-window-info").textContent = `${tn(live.windowCount, "{n} window", "{n} windows")} · ${t("last at {t}", { t: fmtTime(live.current.time) })}`;
  $("lv-spec-info").textContent = lv.capture ? `${lv.capture.contextRate} Hz` : "";
}

function renderLoudness(cur) {
  const l = cur?.loudness;
  const f = (v, d = 1, u = "") => (v == null || !Number.isFinite(v) || v < -69 ? "—" : `${v.toFixed(d)}${u}`);
  const lat = lv.status?.latency;
  const rows = [
    [t("Momentary"), f(l?.momentary)],
    [t("Short term"), f(l?.shortTerm)],
    [t("Integrated"), f(l?.integrated)],
    [t("Range (LRA)"), f(l?.range, 1, " LU")],
    [t("True peak"), f(l?.truePeakDb, 1, " dBFS")],
    [t("Spotify latency"), lat?.last != null ? `${lat.last.toFixed(2)} s` : "—"],
  ];
  $("lv-loud-values").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

const STATE_ICON = { pending: "·", current: "●", done: "✓", cached: "✓", skipped: "↷", error: "!" };

function renderQueue(force = false) {
  const s = lv.status;
  const items = s?.queue?.length ? s.queue : (lv.playlist?.tracks ?? []).map((track) => ({ track, state: "pending" }));
  const key = items.map((q) => `${q.track.id}:${q.state}:${q.score ?? ""}`).join("|") + (s?.index ?? "");
  if (!force && key === lv.queueKey) return;
  lv.queueKey = key;
  const html = items.map((q, i) => {
    const rec = recordFor(q.track);
    const score = q.score ?? rec?.finalScore ?? null;
    const st = q.state === "pending" && rec?.finalScore != null ? "cached" : q.state;
    const sub = [q.track.artists?.join(", "), rec?.source?.mode ? (rec.source.mode === "full" ? t("captured in full") : t("captured at {n} %", { n: Math.round((rec.source.coverage ?? 0) * 100) })) : rec ? t("local file") : "", q.message].filter(Boolean).join(" · ");
    return `<li class="${st === "current" ? "current" : ""}" data-track="${escapeHtml(q.track.id)}" ${rec ? `data-record="${escapeHtml(rec.id)}" style="cursor:pointer"` : ""}>
      <span class="ico" title="${st}">${STATE_ICON[st] ?? "·"}</span>
      ${q.track.image ? `<img class="thumb" src="${escapeHtml(q.track.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="thumb"></span>`}
      <div class="nm"><div>${i + 1}. ${escapeHtml(q.track.name)}</div><div class="sub">${escapeHtml(sub)}</div></div>
      ${score != null ? `<span class="lv-pill" style="background:${intensityColor(score)}">${Math.round(score)}</span>` : `<span class="lv-pill none">${st === "current" ? "…" : "—"}</span>`}
    </li>`;
  }).join("");
  const list = $("lv-queue");
  const keep = list.scrollTop;
  list.innerHTML = html || `<li class="muted small">${t("No playlist imported.")}</li>`;
  list.scrollTop = keep;
  // follow the current track inside the list only: the page never moves
  const cur = list.querySelector("li.current");
  if (cur && force === false && cur.dataset.track !== lv.followed) {
    lv.followed = cur.dataset.track;
    const top = cur.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop || top + cur.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: Math.max(0, top - list.clientHeight / 3), behavior: "smooth" });
    }
  }
}

function recordFor(track) {
  const cap = state.records.get(ctl.capturedId(track));
  if (cap?.finalScore != null) return cap;
  return null;
}

function renderOverall(s) {
  if (!s?.queue?.length) return;
  const c = s.counts ?? {};
  const total = s.queue.length;
  const finished = (c.done ?? 0) + (c.cached ?? 0) + (c.skipped ?? 0) + (c.error ?? 0);
  const cur = s.current;
  const within = cur ? Math.min(0.99, cur.plan.reduce((a, g) => a + (g.filled ?? 0), 0) / Math.max(1, cur.plan.reduce((a, g) => a + g.len, 0))) : 0;
  $("lv-overall-bar").style.width = `${((finished + within) / total) * 100}%`;
  const parts = [t("{n}/{total} tracks", { n: finished, total })];
  if (c.done) parts.push(tn(c.done, "{n} analysed", "{n} analysed"));
  if (c.error) parts.push(tn(c.error, "{n} error", "{n} errors"));
  if (s.running) parts.push(t("~{d} left", { d: formatLong(s.etaSeconds) }));
  if (s.error) parts.push(s.error);
  $("lv-overall-text").textContent = parts.join(" · ");
}

function renderSession() {
  const pl = lv.playlist;
  const scores = [];
  if (pl) {
    for (const t of pl.tracks) {
      const r = recordFor(t);
      if (r?.finalScore != null) scores.push(r.finalScore);
    }
  }
  drawHistogram($("lv-histogram"), scores);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const n = (v) => (v == null ? "—" : Math.round(v));
  $("lv-session-stats").innerHTML = [
    [t("Captured tracks"), scores.length],
    [t("Mean"), n(avg)],
    [t("Min – max"), scores.length ? `${n(Math.min(...scores))} – ${n(Math.max(...scores))}` : "—"],
  ].map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join("");
  $("lv-session-summary").textContent = pl ? `${escapeHtml(pl.name)}` : "";
}

// ------------------------------------------------------------------ utils

function formatLong(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "0 min";
  const m = Math.round(sec / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

function showError(err) {
  console.error(err);
  toast(err?.message || String(err), "error", 7000);
}
