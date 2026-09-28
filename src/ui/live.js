// "Direct" tab: scans the imported Spotify playlist by playing it on the
// user's Spotify app and analysing the captured sound in real time.

import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import * as auth from "../spotify/auth.js";
import * as api from "../spotify/api.js";
import { matchPlaylist } from "../spotify/match.js";
import { analyzePcm } from "../audio/analyzer.js";
import { startCapture, audioInputs, captureSupport } from "../live/capture.js";
import { Scanner } from "../live/scanner.js";
import { SCAN_MODES, SCAN_DEFAULTS, MODE_RANK, estimateTrackSeconds, coveredSeconds } from "../live/plan.js";
import { DIMENSIONS, stageFor } from "../config.js";
import { escapeHtml, formatDuration } from "../util/format.js";
import { toast } from "./toast.js";
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
};
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
  $("lv-reconnect").addEventListener("click", () => auth.beginLogin().catch(showError));
  for (const id of ["lv-count", "lv-length", "lv-budget", "lv-gap", "lv-skip-files", "lv-rescan"]) $(id).addEventListener("change", () => { saveOptions(); renderEstimate(); });
  $("lv-start").addEventListener("click", () => startScan().catch(showError));
  $("lv-pause").addEventListener("click", () => (lv.status?.paused ? lv.scanner?.resume() : lv.scanner?.pause()));
  $("lv-skip").addEventListener("click", () => lv.scanner?.skip());
  $("lv-stop").addEventListener("click", () => lv.scanner?.stop());
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
  lv.playlist = await ctl.spotifyStore.get("playlist").catch(() => null);
  renderSetup();
  renderQueue(true);
  renderSession();
  if (auth.isLoggedIn() && !lv.devices.length) loadDevices().catch(() => {});
}

// ------------------------------------------------------------------ setup

const source = () => document.querySelector('input[name="lv-source"]:checked')?.value ?? "system";

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
  const items = [{ key: "intensity", label: "Intensité", color: "#ffffff" }, ...DIMENSIONS.map((d) => ({ key: d.key, label: d.label, color: DIM_COLORS[d.key] }))];
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
    sel.innerHTML = list.length ? list.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)}${d.virtual ? " ★" : ""}</option>`).join("") : `<option value="">Aucune entrée (clique « Lister »)</option>`;
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
    ? lv.devices.map((d) => `<option value="${escapeHtml(d.id)}" ${d.restricted ? "disabled" : ""}>${escapeHtml(d.name)} · ${escapeHtml(d.type)}${d.active ? " (actif)" : ""}</option>`).join("")
    : `<option value="">Aucun appareil : ouvre Spotify sur ce PC</option>`;
  const pick = lv.devices.find((d) => d.id === cur) ?? lv.devices.find((d) => d.active && d.type === "Computer") ?? lv.devices.find((d) => d.type === "Computer") ?? lv.devices.find((d) => d.active);
  if (pick) sel.value = pick.id;
}

function renderSetup() {
  const logged = auth.isLoggedIn();
  $("lv-scope-warn").hidden = !logged || auth.hasScopes(auth.PLAYBACK_SCOPES);
  const pl = lv.playlist;
  $("lv-playlist-info").innerHTML = !logged
    ? "Connecte ton compte dans l'onglet Spotify."
    : pl ? `Playlist : <b>${escapeHtml(pl.name)}</b> · ${pl.tracks.length} titres` : "Importe d'abord une playlist dans l'onglet Spotify.";
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
  $("lv-estimate").textContent = `${todo.length} titre${todo.length > 1 ? "s" : ""} à analyser sur ${tracks.length} · durée estimée ${formatLong(secs)}.`;
  $("lv-setup-summary").textContent = `${SCAN_MODES.find((m) => m.key === o.mode).label} · ${todo.length}/${tracks.length} titres · ~${formatLong(secs)}`;
}

// ------------------------------------------------------------------ capture

async function beginCapture() {
  if (lv.capture) return lv.capture;
  const src = source();
  $("lv-capture-status").textContent = "autorisation…";
  try {
    lv.capture = await startCapture({
      source: src,
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
          toast("Partage audio interrompu : scan en pause. Réactive la capture puis reprends.", "error", 8000);
        }
      },
    });
  } catch (err) {
    lv.capture = null;
    renderCapture();
    if (err?.name === "NotAllowedError") throw new Error("Capture refusée.");
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
  st.textContent = c ? `${c.label}${c.contextRate !== 44100 ? ` · ${c.contextRate} Hz → 44,1 kHz` : ""}` : "inactive";
  st.className = `lv-chip ${c ? "ok" : ""}`;
  $("lv-capture").textContent = c ? "Couper la capture" : "Activer la capture";
}

// ------------------------------------------------------------------ scan

async function startScan() {
  if (lv.status?.running) return;
  if (!auth.isLoggedIn()) throw new Error("Connecte d'abord ton compte Spotify (onglet Spotify).");
  if (!auth.hasScopes(auth.PLAYBACK_SCOPES)) {
    $("lv-scope-warn").hidden = false;
    throw new Error("Reconnecte Spotify pour autoriser le contrôle de lecture.");
  }
  lv.playlist = await ctl.spotifyStore.get("playlist").catch(() => null);
  const { todo } = scanList();
  if (!lv.playlist) throw new Error("Importe d'abord une playlist dans l'onglet Spotify.");
  if (!todo.length) return toast("Tous les titres sont déjà analysés avec ce mode (coche « Réanalyser » pour recommencer).");
  await beginCapture();
  if (!$("lv-spdevice").value) await loadDevices();
  const deviceId = $("lv-spdevice").value;
  if (!deviceId) throw new Error("Aucun appareil Spotify : ouvre l'application Spotify sur ce PC, puis « Actualiser ».");

  const o = options();
  const player = {
    play: (uri, ms) => api.play(deviceId, uri, ms),
    pause: () => api.pause(deviceId),
    state: () => api.playbackState(),
  };
  lv.scanner = new Scanner({
    player,
    analyze: (mono, sr, extra) => analyzePcm(mono, sr, extra),
    analyzeLive: (mono, sr, extra) => analyzePcm(mono, sr, extra),
    save: (track, features, info) => ctl.saveCaptured(track, features, info),
    scoring: ctl.scoring,
    onUpdate: (s) => { lv.status = s; lv.lastUpdate = performance.now(); lv.dirty = true; },
  });
  $("lv-setup").open = false;
  requestWakeLock();
  setRunning(true);
  try {
    const st = await lv.scanner.run(todo, { ...o, rescan: true });
    const c = st.counts;
    if (st.error) toast(`Scan interrompu : ${st.error}`, "error", 9000);
    else toast(`Scan ${lv.scanner.stopRequested ? "arrêté" : "terminé"} : ${c.done} titre${c.done > 1 ? "s" : ""} analysé${c.done > 1 ? "s" : ""}${c.error ? `, ${c.error} erreur(s)` : ""}.`);
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

function loop(t) {
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
  meters.draw($("lv-meters"), lv.capture, cur?.loudness, t);
  $("lv-level-bar").style.width = `${Math.min(100, Math.max(0, (20 * Math.log10((lv.level ?? 0) + 1e-9) + 60) / 60) * 100)}%`;
  if (lv.level) lv.level *= 0.97;
  drawTimeline($("lv-timeline"), cur, pos, t);

  // gauge eases towards the latest window intensity
  const target = cur?.final?.score ?? cur?.live?.current?.intensity ?? null;
  if (target != null) lv.gauge.shown = lv.gauge.shown == null ? target : lv.gauge.shown + (target - lv.gauge.shown) * 0.08;
  const trackScore = cur?.final?.score ?? cur?.live?.scoring?.score ?? null;
  drawGauge($("lv-gauge"), {
    value: lv.gauge.shown,
    score: trackScore,
    label: lv.gauge.shown != null ? stageFor(lv.gauge.shown).label : "intensité",
    caption: trackScore != null ? `${cur?.final ? "score final" : "score provisoire"} ${Math.round(trackScore)}` : "",
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
    drawRadar($("lv-radar"), { current: cur?.live?.current?.subscores ?? null, aggregate: cur?.final ? null : cur?.live?.scoring?.subscores ?? null });
    renderTiles(cur);
    renderLoudness(cur);
    renderQueue();
    renderOverall(s);
  }
}

function renderNow(s, cur) {
  $("lv-pulse").classList.toggle("on", !!s?.running && !s?.paused);
  $("lv-phase").textContent = !s ? "En attente" : s.paused ? "En pause" : s.running ? (s.phase || "…") : (s.phase || "En attente");
  $("lv-pause").textContent = s?.paused ? "▶ Reprendre" : "❚❚ Pause";
  if (!cur) return;
  const t = cur.track;
  if (lv.shownTrack !== t.id) {
    lv.shownTrack = t.id;
    lv.gauge.shown = null;
    $("lv-title").textContent = t.name;
    $("lv-artist").textContent = [t.artists?.join(", "), t.album].filter(Boolean).join(" · ");
    const img = t.imageLarge || t.image;
    $("lv-cover").innerHTML = img ? `<img src="${escapeHtml(img)}" alt="" referrerpolicy="no-referrer">` : "<span>♪</span>";
    $("lv-backdrop").style.backgroundImage = img ? `url("${img.replace(/"/g, "")}")` : "none";
  }
  const heard = coveredSeconds(cur.plan.filter((g) => g.filled).map((g) => ({ pos: g.recordedFrom ?? g.pos, len: g.filled })));
  const done = cur.plan.filter((g) => g.state === "done").length;
  const kinds = cur.plan.length > 1 ? ` · extrait ${Math.min(cur.plan.length, done + 1)}/${cur.plan.length}` : "";
  $("lv-heard").textContent = `${formatDuration(heard)} écoutées (${Math.min(100, Math.round((heard / cur.duration) * 100))} %)${kinds}`;
}

const TILES = [
  { k: "bpm", label: "Tempo", unit: "BPM", fmt: (v) => (v ? v.toFixed(0) : "—"), extra: (f) => (f.bpmConfidence != null ? `fiabilité ${Math.round(f.bpmConfidence * 100)} %` : "") },
  { k: "onsetRate", label: "Attaques", unit: "/s", fmt: (v) => v.toFixed(1) },
  { k: "kickRate", label: "Kicks", unit: "/s", fmt: (v) => v.toFixed(1) },
  { k: "lowPulse", label: "Punch grave", fmt: (v) => v.toFixed(3) },
  { k: "centroidMean", label: "Centroïde", unit: "kHz", fmt: (v) => (v / 1000).toFixed(2) },
  { k: "rolloffMean", label: "Rolloff 85 %", unit: "kHz", fmt: (v) => (v / 1000).toFixed(1) },
  { k: "bandwidthMean", label: "Largeur spectrale", unit: "kHz", fmt: (v) => (v / 1000).toFixed(2) },
  { k: "fluxMean", label: "Flux spectral", fmt: (v) => v.toFixed(3) },
  { k: "flatnessMedian", label: "Planéité", unit: "dB", fmt: (v) => (10 * Math.log10(Math.max(v, 1e-12))).toFixed(1) },
  { k: "spectralFill", label: "Remplissage", unit: "%", fmt: (v) => (v * 100).toFixed(0) },
  { k: "bassRatio", label: "Part du grave", unit: "%", fmt: (v) => (v * 100).toFixed(0) },
  { k: "highRatio", label: "Part des aigus", unit: "%", fmt: (v) => (v * 100).toFixed(1) },
  { k: "crestDb", label: "Facteur de crête", unit: "dB", fmt: (v) => v.toFixed(1) },
  { k: "plrDb", label: "PLR", unit: "dB", fmt: (v) => v.toFixed(1) },
  { k: "loudnessRel", label: "Volume relatif", unit: "LU", fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1) },
  { k: "silenceRatio", label: "Silence", unit: "%", fmt: (v) => (v * 100).toFixed(0) },
];

function renderTiles(cur) {
  const live = cur?.live;
  const f = live?.current?.features;
  const box = $("lv-tiles");
  if (!f) {
    box.innerHTML = `<p class="muted small">Les mesures apparaissent après les premières secondes d'écoute (fenêtres de 6 s, mises à jour toutes les 3 s).</p>`;
    $("lv-window-info").textContent = "";
    return;
  }
  const inten = live.current.intensity;
  const series = live.series;
  // series in time order; the sparkline follows the heard order of the track
  const tiles = [
    `<div class="lv-tile"><div class="k">Intensité (fenêtre)</div><div class="v" style="color:${intensityColor(inten)}">${Math.round(inten)}<small>${escapeHtml(stageFor(inten).label)}</small></div>${sparkSvg(live.scoring?.curves.intensity ?? [], intensityColor(inten), 0, 100)}</div>`,
    ...TILES.map((t) => {
      const v = f.timeline?.series?.[t.k]?.[0] ?? f[t.k];
      const txt = Number.isFinite(v) ? t.fmt(v) : "—";
      const ex = t.extra ? t.extra(f) : "";
      return `<div class="lv-tile" title="${escapeHtml(ex)}"><div class="k">${t.label}${ex ? ` · ${escapeHtml(ex)}` : ""}</div><div class="v">${txt}${t.unit ? `<small>${t.unit}</small>` : ""}</div>${sparkSvg(series[t.k] ?? [], "#7dd3fc")}</div>`;
    }),
  ];
  box.innerHTML = tiles.join("");
  $("lv-window-info").textContent = `${live.windowCount} fenêtre${live.windowCount > 1 ? "s" : ""} · dernière à ${fmtTime(live.current.time)}`;
  $("lv-spec-info").textContent = lv.capture ? `${lv.capture.contextRate} Hz` : "";
}

function renderLoudness(cur) {
  const l = cur?.loudness;
  const f = (v, d = 1, u = "") => (v == null || !Number.isFinite(v) || v < -69 ? "—" : `${v.toFixed(d)}${u}`);
  const lat = lv.status?.latency;
  const rows = [
    ["Momentané", f(l?.momentary)],
    ["Court terme", f(l?.shortTerm)],
    ["Intégré", f(l?.integrated)],
    ["Plage (LRA)", f(l?.range, 1, " LU")],
    ["Crête", f(l?.truePeakDb, 1, " dBFS")],
    ["Latence Spotify", lat?.last != null ? `${lat.last.toFixed(2)} s` : "—"],
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
    const sub = [q.track.artists?.join(", "), rec?.source?.kind === "spotify" ? `capté ${rec.source.mode === "full" ? "en entier" : `à ${Math.round((rec.source.coverage ?? 0) * 100)} %`}` : rec ? "fichier local" : "", q.message].filter(Boolean).join(" · ");
    return `<li class="${st === "current" ? "current" : ""}" ${rec ? `data-record="${escapeHtml(rec.id)}" style="cursor:pointer"` : ""}>
      <span class="ico" title="${st}">${STATE_ICON[st] ?? "·"}</span>
      ${q.track.image ? `<img class="thumb" src="${escapeHtml(q.track.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="thumb"></span>`}
      <div class="nm"><div>${i + 1}. ${escapeHtml(q.track.name)}</div><div class="sub">${escapeHtml(sub)}</div></div>
      ${score != null ? `<span class="lv-pill" style="background:${intensityColor(score)}">${Math.round(score)}</span>` : `<span class="lv-pill none">${st === "current" ? "…" : "—"}</span>`}
    </li>`;
  }).join("");
  $("lv-queue").innerHTML = html || `<li class="muted small">Aucune playlist importée.</li>`;
  const cur = $("lv-queue").querySelector("li.current");
  if (cur && force === false) cur.scrollIntoView({ block: "nearest" });
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
  const parts = [`${finished}/${total} titres`];
  if (c.done) parts.push(`${c.done} analysé${c.done > 1 ? "s" : ""}`);
  if (c.error) parts.push(`${c.error} erreur${c.error > 1 ? "s" : ""}`);
  if (s.running) parts.push(`~${formatLong(s.etaSeconds)} restantes`);
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
    ["Titres captés", scores.length],
    ["Moyenne", n(avg)],
    ["Min – max", scores.length ? `${n(Math.min(...scores))} – ${n(Math.max(...scores))}` : "—"],
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
