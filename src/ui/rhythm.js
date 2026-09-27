// Rhythm tab: extract notes from a track, show them as a lane × time matrix,
// play the music (or one isolated lane) from any point with cue sounds on the
// selected lanes, tune the grouping, and follow KPS / difficulty curves.

import { RHYTHM_DEFAULTS, RHYTHM } from "../config.js";
import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { engine, lowerBound } from "../audio/engine.js";
import { bandData, cachedBandData } from "../rhythm/session.js";
import { buildRhythmMap, laneLabel, boundariesOf } from "../rhythm/notes.js";
import { mapStatistics } from "../rhythm/difficulty.js";
import { renderTimeline } from "./charts.js";
import { toast } from "./toast.js";
import { escapeHtml } from "../util/format.js";

const $ = (id) => document.getElementById(id);
const ROW = 36;
const HEADER = 18;
const HEAVY = ["bandsPerOctave", "fMin", "fMax"];
const MAP_VERSION = 1;

const rh = {
  id: null,
  params: { ...RHYTHM_DEFAULTS },
  data: null,          // band data (session only)
  lanes: [],           // [{b0,b1,lo,hi,activity,notes:Float64Array,strengths:Float32Array}]
  duration: 0,
  selected: [],
  source: "music",     // "music" | "none" | "lane:<index>"
  cuesOn: true,
  viewStart: 0,
  viewSpan: 10,
  levels: [],          // per lane: Float32Array of normalised level (display background)
  stats: null,
  busy: false,
};

// ---------------------------------------------------------------------------

export function initRhythm() {
  $("rh-track").addEventListener("change", (e) => selectTrack(e.target.value));
  $("rh-extract").addEventListener("click", () => extract());
  $("rh-play").addEventListener("click", () => togglePlay());
  $("rh-source").addEventListener("change", (e) => {
    rh.source = e.target.value;
    applyEngineSettings();
    renderLanes();
  });
  $("rh-cues").addEventListener("change", (e) => {
    rh.cuesOn = e.target.checked;
    engine.refreshCues();
  });
  $("rh-music-vol").addEventListener("input", (e) => engine.set({ musicVolume: Number(e.target.value) }));
  $("rh-cue-vol").addEventListener("input", (e) => engine.set({ cueVolume: Number(e.target.value) }));
  $("rh-zoom").addEventListener("input", (e) => {
    const center = rh.viewStart + rh.viewSpan / 2;
    rh.viewSpan = Number(e.target.value);
    $("rh-zoom-value").textContent = `${rh.viewSpan} s`;
    rh.viewStart = clampView(center - rh.viewSpan / 2);
    draw();
  });
  $("rh-curve").addEventListener("change", renderCurve);

  // parameters
  const onParam = (key, parse, heavy = false) => (e) => {
    const v = parse(e.target);
    if (v === rh.params[key]) return;
    rh.params[key] = v;
    showOutputs();
    if (heavy) {
      rh.params.boundaries = null; // band layout changes: manual lanes no longer apply
      if (rh.id) extract();
    } else rebuild();
  };
  const num = (el) => Number(el.value);
  $("rh-lanes").addEventListener("change", onParam("lanes", (el) => clampInt(el.value, 1, RHYTHM.maxLanes)));
  $("rh-mode").addEventListener("change", onParam("groupingMode", (el) => el.value));
  $("rh-grouping").addEventListener("change", onParam("grouping", num));
  $("rh-sensitivity").addEventListener("change", onParam("sensitivity", num));
  $("rh-dedupe").addEventListener("change", onParam("dedupe", num));
  $("rh-dedupe").addEventListener("input", showOutputs);
  $("rh-grouping").addEventListener("input", showOutputs);
  $("rh-sensitivity").addEventListener("input", showOutputs);
  $("rh-gap").addEventListener("change", onParam("minGapMs", (el) => clampInt(el.value, 10, 500)));
  $("rh-merge").addEventListener("change", onParam("mergeNeighbors", (el) => el.checked));
  $("rh-bpo").addEventListener("change", onParam("bandsPerOctave", num, true));
  $("rh-fmin").addEventListener("change", onParam("fMin", (el) => clampInt(el.value, 20, 2000), true));
  $("rh-fmax").addEventListener("change", onParam("fMax", (el) => clampInt(el.value, 2000, 20000), true));
  $("rh-reset").addEventListener("click", () => {
    const heavyChanged = HEAVY.some((k) => rh.params[k] !== RHYTHM_DEFAULTS[k]);
    rh.params = { ...RHYTHM_DEFAULTS };
    showParams();
    if (heavyChanged && rh.id) extract();
    else rebuild();
  });
  document.getElementById("rh-manual-note").addEventListener("click", (e) => {
    if (e.target.closest("[data-auto]")) {
      rh.params.boundaries = null;
      rebuild();
    }
  });

  // lanes list
  $("rh-lanes-list").addEventListener("change", (e) => {
    const i = Number(e.target.closest("[data-lane]")?.dataset.lane);
    if (!Number.isInteger(i)) return;
    rh.selected[i] = e.target.checked;
    engine.refreshCues();
    updateStats();
    save();
    draw();
  });
  $("rh-lanes-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const i = Number(btn.closest("[data-lane]").dataset.lane);
    if (btn.dataset.act === "isolate") {
      rh.source = rh.source === `lane:${i}` ? "music" : `lane:${i}`;
      renderSourceSelect();
      applyEngineSettings();
      renderLanes();
      if (!engine.playing || engine.id !== rh.id) play(engine.id === rh.id ? engine.lastPosition : rh.viewStart);
    } else if (btn.dataset.act === "merge") editLanes("merge", i);
    else if (btn.dataset.act === "split") editLanes("split", i);
  });

  // matrix interactions
  const canvas = $("rh-canvas");
  canvas.addEventListener("click", (e) => {
    if (!rh.lanes.length) return;
    const rect = canvas.getBoundingClientRect();
    const t = rh.viewStart + ((e.clientX - rect.left) / rect.width) * rh.viewSpan;
    if (engine.playing && engine.id === rh.id) engine.stop();
    else play(t);
  });
  canvas.addEventListener("wheel", (e) => {
    if (!rh.lanes.length) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const center = rh.viewStart + rh.viewSpan / 2;
      rh.viewSpan = Math.max(2, Math.min(60, rh.viewSpan * f));
      $("rh-zoom").value = Math.round(rh.viewSpan);
      $("rh-zoom-value").textContent = `${Math.round(rh.viewSpan)} s`;
      rh.viewStart = clampView(center - rh.viewSpan / 2);
    } else {
      rh.viewStart = clampView(rh.viewStart + ((e.deltaY + e.deltaX) / 600) * rh.viewSpan);
    }
    draw();
  }, { passive: false });
  $("rh-overview").addEventListener("click", (e) => {
    if (!rh.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * rh.duration;
    rh.viewStart = clampView(t - rh.viewSpan / 2);
    draw();
  });
  if ("ResizeObserver" in window) new ResizeObserver(() => draw()).observe($("rh-matrix-card"));

  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || $("panel-rhythm").hidden) return;
    if (e.target.closest("input, select, textarea, button, dialog")) return;
    e.preventDefault();
    togglePlay();
  });

  engine.onChange(() => {
    $("rh-play").textContent = engine.playing && engine.id === rh.id ? "■" : "▶";
    if (engine.playing) loop();
    else draw();
  });
  subscribe(() => refreshTrackSelect());
  showParams();
  renderSourceSelect();
}

/** Called when the tab becomes visible. */
export function showRhythm() {
  refreshTrackSelect();
  draw();
  renderCurve();
}

/** Opens a track in the rhythm tab (e.g. from the library). */
export function openInRhythm(id) {
  document.getElementById("tab-rhythm").click();
  selectTrack(id);
}

// ---------------------------------------------------------------------------
// Track selection, extraction, persistence

function refreshTrackSelect() {
  const sel = $("rh-track");
  const records = [...state.records.values()].filter((r) => r.auto || r.rhythm).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const key = records.map((r) => `${r.id}:${state.files.has(r.id)}:${!!r.rhythm}`).join("|");
  if (sel._key === key) return;
  sel._key = key;
  sel.innerHTML = `<option value="">— choisir —</option>` + records.map((r) => {
    const tag = state.files.has(r.id) ? (r.rhythm ? " · map" : "") : r.rhythm ? " · map (fichier à réimporter pour écouter)" : " · fichier à réimporter";
    return `<option value="${r.id}" ${r.id === rh.id ? "selected" : ""}>${escapeHtml(r.name)}${tag}</option>`;
  }).join("");
  if (!rh.id && records.length === 1) selectTrack(records[0].id);
  updateButtons();
}

function selectTrack(id) {
  if (id === rh.id) return;
  if (engine.playing) engine.stop();
  rh.id = id || null;
  rh.data = null;
  rh.lanes = [];
  rh.levels = [];
  rh.source = "music";
  rh.viewStart = 0;
  const r = state.records.get(id);
  if (!r) return renderAll();
  $("rh-track").value = id;
  if (r.rhythm?.version === MAP_VERSION) {
    restore(r.rhythm);
    rh.data = cachedBandData(id, rh.params);
    if (rh.data) computeLevels();
  } else {
    rh.params = { ...RHYTHM_DEFAULTS };
  }
  rh.duration = rh.duration || r.duration || 0;
  showParams();
  renderAll();
  if (!r.rhythm && state.files.has(id)) extract();
  else setStatus(r.rhythm ? (state.files.has(id) ? "Map enregistrée. Modifie un paramètre ou clique sur « Extraire » pour recalculer." : "Map enregistrée. Réimporte le fichier dans la bibliothèque pour l'écouter ou la recalculer.") : "Fichier absent de cette session : réimporte-le dans la bibliothèque (il sera reconnu).");
}

async function extract() {
  const id = rh.id;
  const file = state.files.get(id);
  if (!file) {
    toast("Fichier audio absent de cette session : réimporte-le dans la bibliothèque.", "error");
    return;
  }
  rh.busy = true;
  updateButtons();
  $("rh-progress").hidden = false;
  try {
    const data = await bandData(id, file, rh.params, (stage, p) => {
      setStatus(stage === "decode" ? "Décodage…" : `Analyse spectrale… ${Math.round(p * 100)} %`);
      $("rh-progress-bar").style.width = `${stage === "decode" ? 5 : 5 + p * 95}%`;
    });
    if (id !== rh.id) return;
    rh.data = data;
    rh.duration = data.duration;
    computeLevels();
    rebuild();
  } catch (err) {
    console.error(err);
    setStatus(err.message);
    toast(err.message, "error");
  } finally {
    rh.busy = false;
    $("rh-progress").hidden = true;
    updateButtons();
  }
}

/** Regroups and re-detects from the cached band data (instant). */
function rebuild() {
  showManualNote();
  if (!rh.data) {
    if (rh.id && state.files.has(rh.id)) extract();
    return;
  }
  const t0 = performance.now();
  const map = buildRhythmMap(rh.data, rh.params);
  const sameLayout = map.lanes.length === rh.lanes.length && map.lanes.every((l, i) => l.b0 === rh.lanes[i].b0);
  rh.lanes = map.lanes;
  if (!sameLayout) {
    rh.selected = rh.lanes.map(() => true);
    if (rh.source.startsWith("lane:")) rh.source = "music";
  }
  computeLevels();
  const n = rh.lanes.reduce((a, l) => a + l.notes.length, 0);
  setStatus(`${rh.lanes.length} pistes · ${n} notes (${Math.round(performance.now() - t0)} ms)`);
  renderAll();
  engine.refreshCues();
  save();
}

function editLanes(action, i) {
  if (!rh.data) return toast("Recalcule d'abord la map (fichier requis).", "error");
  let starts = boundariesOf(rh.lanes);
  const lane = rh.lanes[i];
  if (action === "merge") {
    // merge lane i with the lane just below it in frequency (i - 1)
    if (i === 0) return;
    starts = starts.filter((b) => b !== lane.b0);
  } else {
    if (lane.b1 <= lane.b0) return toast("Piste trop étroite pour être scindée.");
    if (rh.lanes.length >= RHYTHM.maxLanes) return toast(`${RHYTHM.maxLanes} pistes au maximum.`);
    const mid = Math.round((lane.b0 + lane.b1 + 1) / 2);
    starts = [...starts, mid].sort((a, b) => a - b);
  }
  rh.params.boundaries = starts;
  rebuild();
}

function serialize() {
  return {
    version: MAP_VERSION,
    params: { ...rh.params },
    duration: rh.duration,
    selected: [...rh.selected],
    computedAt: Date.now(),
    lanes: rh.lanes.map((l) => ({
      b0: l.b0, b1: l.b1, lo: l.lo, hi: l.hi, activity: Math.round(l.activity * 1000) / 1000,
      notes: Array.from(l.notes, (t) => Math.round(t * 1000)),
      strengths: Array.from(l.strengths, (s) => Math.round(s * 100)),
    })),
  };
}

function restore(saved) {
  rh.params = { ...RHYTHM_DEFAULTS, ...saved.params };
  rh.duration = saved.duration;
  rh.lanes = saved.lanes.map((l) => ({
    ...l,
    notes: Float64Array.from(l.notes, (ms) => ms / 1000),
    strengths: Float32Array.from(l.strengths, (s) => s / 100),
  }));
  rh.selected = rh.lanes.map((_, i) => saved.selected?.[i] ?? true);
}

let saveTimer = null;
function save() {
  if (!rh.id || !rh.lanes.length) return;
  clearTimeout(saveTimer);
  const id = rh.id;
  const payload = serialize();
  saveTimer = setTimeout(() => ctl.saveRhythm(id, payload), 400);
}

function computeLevels() {
  rh.levels = [];
  const d = rh.data;
  if (!d) return;
  const nl = Math.ceil(d.nf / d.levelStep);
  for (const lane of rh.lanes) {
    const lv = new Float32Array(nl);
    for (let b = lane.b0; b <= lane.b1; b++) for (let i = 0; i < nl; i++) lv[i] = Math.max(lv[i], d.level[b * nl + i]);
    const sorted = Float32Array.from(lv).sort();
    const lo = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    const hi = sorted[Math.floor(sorted.length * 0.98)] ?? 1;
    for (let i = 0; i < nl; i++) lv[i] = Math.max(0, Math.min(1, (lv[i] - lo) / (hi - lo || 1)));
    rh.levels.push(lv);
  }
}

// ---------------------------------------------------------------------------
// Playback

async function play(t) {
  const file = state.files.get(rh.id);
  if (!file) return toast("Fichier audio absent de cette session : réimporte-le pour écouter.", "error");
  await engine.load(rh.id, file);
  applyEngineSettings();
  engine.cueSource = cueSource;
  await engine.play(Math.max(0, t));
}

function togglePlay() {
  if (!rh.id) return;
  if (engine.playing && engine.id === rh.id) engine.stop();
  else play(engine.id === rh.id ? engine.lastPosition : rh.viewStart);
}

function cueSource() {
  if (!rh.cuesOn || engine.id !== rh.id) return [];
  return rh.lanes.flatMap((l, i) => (rh.selected[i] ? [{ notes: l.notes, lane: i }] : []));
}

function applyEngineSettings() {
  const lane = rh.source.startsWith("lane:") ? rh.lanes[Number(rh.source.slice(5))] : null;
  engine.set({
    isolate: lane ? { lo: lane.lo, hi: lane.hi } : null,
    musicOn: rh.source !== "none",
    musicVolume: Number($("rh-music-vol").value),
    cueVolume: Number($("rh-cue-vol").value),
  });
}

let raf = 0;
function loop() {
  cancelAnimationFrame(raf);
  const step = () => {
    if (!engine.playing || engine.id !== rh.id) return draw();
    const t = engine.position;
    // follow the playhead
    if (t > rh.viewStart + rh.viewSpan * 0.85 || t < rh.viewStart) rh.viewStart = clampView(t - rh.viewSpan * 0.15);
    draw();
    raf = requestAnimationFrame(step);
  };
  step();
}

// ---------------------------------------------------------------------------
// Rendering

function renderAll() {
  renderLanes();
  renderSourceSelect();
  updateStats();
  draw();
  updateButtons();
  showManualNote();
}

function laneColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    lanes: Array.from({ length: 8 }, (_, i) => cs.getPropertyValue(`--lane-${i + 1}`).trim()),
    off: cs.getPropertyValue("--lane-off").trim(),
    text: cs.getPropertyValue("--text").trim(),
    muted: cs.getPropertyValue("--muted").trim(),
    grid: cs.getPropertyValue("--grid").trim(),
    surface: cs.getPropertyValue("--surface").trim(),
  };
}

function renderLanes() {
  const list = $("rh-lanes-list");
  const colors = laneColors();
  // high frequencies on top, like a piano roll
  list.innerHTML = rh.lanes.map((lane, i) => ({ lane, i })).reverse().map(({ lane, i }) => {
    const { name, range } = laneLabel(lane);
    const isolated = rh.source === `lane:${i}`;
    return `<div class="rh-lane" data-lane="${i}">
      <input type="checkbox" ${rh.selected[i] ? "checked" : ""} aria-label="Inclure ${escapeHtml(name)} dans la map">
      <span class="swatch" style="background:${colors.lanes[i % 8]}"></span>
      <span class="name" title="${escapeHtml(`${name} · ${range} · ${lane.notes.length} notes`)}">${escapeHtml(name)} <small>${range} · ${lane.notes.length}</small></span>
      <span class="tools">
        <button class="icon-btn" data-act="isolate" aria-pressed="${isolated}" title="Écouter cette piste seule (filtrée)">🎧</button>
        <button class="icon-btn" data-act="split" title="Scinder la piste en deux">✂</button>
        <button class="icon-btn" data-act="merge" ${i === 0 ? "disabled" : ""} title="Fusionner avec la piste du dessous">⤓</button>
      </span>
    </div>`;
  }).join("");
}

function renderSourceSelect() {
  const sel = $("rh-source");
  sel.innerHTML = `<option value="music">Musique originale</option><option value="none">Cues seuls</option>` +
    rh.lanes.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => `<option value="lane:${i}">Piste isolée · ${escapeHtml(laneLabel(l).name)} (${laneLabel(l).range})</option>`).join("");
  sel.value = rh.source;
}

function draw() {
  drawMatrix();
  drawOverview();
  const t = engine.id === rh.id ? engine.position : 0;
  $("rh-time").textContent = `${fmtTime(t)} / ${fmtTime(rh.duration)}`;
  const chart = $("rh-curve-chart");
  chart.setPlayhead?.(engine.id === rh.id && (engine.playing || t > 0) ? t : null);
}

function setupCanvas(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  canvas.style.height = `${cssH}px`;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: cssW, h: cssH };
}

function drawMatrix() {
  const canvas = $("rh-canvas");
  if (!canvas || $("panel-rhythm").hidden) return;
  const n = rh.lanes.length;
  const { g, w, h } = setupCanvas(canvas, HEADER + Math.max(1, n) * ROW);
  const c = laneColors();
  g.clearRect(0, 0, w, h);
  if (!n) {
    g.fillStyle = c.muted;
    g.font = "13px system-ui, sans-serif";
    g.fillText(rh.id ? "Extraction des notes…" : "Choisis un morceau analysé.", 12, HEADER + 22);
    return;
  }
  const vs = rh.viewStart, span = rh.viewSpan;
  const X = (t) => ((t - vs) / span) * w;

  // time grid
  // at least ~56 px between time labels
  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => (w / span) * s >= 56) ?? 60;
  g.font = "11px system-ui, sans-serif";
  g.textBaseline = "top";
  for (let t = Math.ceil(vs / step) * step; t <= vs + span; t += step) {
    const x = X(t);
    g.fillStyle = c.grid;
    g.fillRect(x, HEADER, 1, h - HEADER);
    g.fillStyle = c.muted;
    g.fillText(fmtTime(t, step < 1), x + 3, 3);
  }

  for (let r = 0; r < n; r++) {
    const li = n - 1 - r;
    const lane = rh.lanes[li];
    const y = HEADER + r * ROW;
    const color = rh.selected[li] ? c.lanes[li % 8] : c.off;
    g.fillStyle = c.grid;
    g.fillRect(0, y, w, 1);
    // band energy background: what was extracted from this frequency range
    const lv = rh.levels[li];
    if (lv && rh.data) {
      const rate = rh.data.frameRate / rh.data.levelStep;
      g.fillStyle = color;
      for (let x = 0; x < w; x += 2) {
        const t = vs + (x / w) * span - rh.data.t0;
        const v = lv[Math.floor(t * rate)] ?? 0;
        if (v <= 0.02) continue;
        g.globalAlpha = 0.28 * v;
        g.fillRect(x, y + 2, 2, ROW - 3);
      }
      g.globalAlpha = 1;
    }
    // notes
    const notes = lane.notes;
    const from = lowerBound(notes, vs - 0.05);
    const to = lowerBound(notes, vs + span + 0.05);
    g.fillStyle = color;
    for (let k = from; k < to; k++) {
      g.globalAlpha = 0.35 + 0.65 * (lane.strengths[k] ?? 1);
      g.fillRect(X(notes[k]) - 1.5, y + 7, 3, ROW - 13);
    }
    g.globalAlpha = 1;
    if (rh.source === `lane:${li}`) {
      g.strokeStyle = c.text;
      g.lineWidth = 1;
      g.strokeRect(0.5, y + 0.5, w - 1, ROW - 1);
    }
  }
  // playhead
  if (engine.id === rh.id) {
    const x = X(engine.position);
    if (x >= 0 && x <= w) {
      g.fillStyle = c.text;
      g.fillRect(x - 1, 0, 2, h);
    }
  }
}

function drawOverview() {
  const canvas = $("rh-overview");
  if (!canvas || $("panel-rhythm").hidden) return;
  const { g, w, h } = setupCanvas(canvas, 40);
  const c = laneColors();
  g.clearRect(0, 0, w, h);
  if (!rh.duration || !rh.stats) return;
  const { times, values } = rh.stats.kps;
  const max = Math.max(1, ...values);
  g.fillStyle = c.lanes[0];
  g.globalAlpha = 0.5;
  g.beginPath();
  g.moveTo(0, h);
  times.forEach((t, i) => g.lineTo((t / rh.duration) * w, h - 3 - (values[i] / max) * (h - 8)));
  g.lineTo(w, h);
  g.closePath();
  g.fill();
  g.globalAlpha = 1;
  // view window
  g.strokeStyle = c.text;
  g.lineWidth = 1;
  g.strokeRect((rh.viewStart / rh.duration) * w + 0.5, 0.5, Math.max(2, (rh.viewSpan / rh.duration) * w - 1), h - 1);
  if (engine.id === rh.id) {
    g.fillStyle = c.text;
    g.fillRect((engine.position / rh.duration) * w - 1, 0, 2, h);
  }
}

function updateStats() {
  rh.stats = rh.lanes.length ? mapStatistics(rh.lanes, rh.selected, rh.duration) : null;
  const box = $("rh-stats");
  if (!rh.stats) {
    box.innerHTML = "";
    $("rh-curve-chart").innerHTML = "";
    return;
  }
  const s = rh.stats;
  const tiles = [
    ["Notes", s.notes],
    ["Pistes dans la map", `${rh.selected.filter(Boolean).length} / ${rh.lanes.length}`],
    ["KPS moyen", s.meanKps.toFixed(1)],
    ["KPS max (1 s)", s.maxKps.toFixed(0)],
    ["Difficulté", `${s.difficulty.overall.toFixed(2)} ★`],
    ["Pic de difficulté", `${s.difficulty.peak.toFixed(2)} ★`],
  ];
  box.innerHTML = tiles.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  renderCurve();
}

function renderCurve() {
  const host = $("rh-curve-chart");
  if (!rh.stats || $("panel-rhythm").hidden) return;
  const kind = $("rh-curve").value;
  const curve = kind === "kps" ? rh.stats.kps : rh.stats.difficulty;
  renderTimeline(host, {
    times: curve.times,
    values: curve.values,
    min: 0,
    format: kind === "kps" ? (v) => v.toFixed(0) : (v) => `${v.toFixed(1)}★`,
    duration: rh.duration,
    height: 170,
    onSeek: (t) => {
      if (engine.playing && engine.id === rh.id) engine.stop();
      else play(t);
    },
  });
  draw();
}

function showParams() {
  const p = rh.params;
  $("rh-lanes").value = p.lanes;
  $("rh-mode").value = p.groupingMode;
  $("rh-grouping").value = p.grouping;
  $("rh-sensitivity").value = p.sensitivity;
  $("rh-dedupe").value = p.dedupe;
  $("rh-gap").value = p.minGapMs;
  $("rh-merge").checked = p.mergeNeighbors;
  $("rh-bpo").value = String(p.bandsPerOctave);
  $("rh-fmin").value = p.fMin;
  $("rh-fmax").value = p.fMax;
  showOutputs();
}

function showOutputs() {
  for (const id of ["rh-grouping", "rh-sensitivity", "rh-dedupe"]) {
    const el = $(id);
    el.nextElementSibling.textContent = Number(el.value).toFixed(2);
  }
}

function showManualNote() {
  $("rh-manual-note").innerHTML = rh.params.boundaries?.length
    ? `· Pistes modifiées à la main — <button class="link-btn" type="button" data-auto>revenir au regroupement automatique</button>`
    : "";
}

function updateButtons() {
  const hasFile = rh.id && state.files.has(rh.id);
  $("rh-extract").disabled = !hasFile || rh.busy;
  $("rh-play").disabled = !hasFile || !rh.lanes.length;
}

function setStatus(text) { $("rh-status").textContent = text; }

function clampView(start) {
  return Math.max(0, Math.min(start, Math.max(0, rh.duration - rh.viewSpan)));
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

function fmtTime(t, tenths = true) {
  const s = Math.max(0, t || 0);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(tenths ? 1 : 0).padStart(tenths ? 4 : 2, "0")}`;
}
