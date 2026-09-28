// Playlist map (intensity × mood scatter) and side-by-side comparison of two
// imported playlists.

import { state } from "../app/store.js";
import { STAGES, stageFor } from "../config.js";
import { matchPlaylist } from "../spotify/match.js";
import { keyName } from "../audio/music.js";
import { escapeHtml } from "../util/format.js";
import { intensityColor } from "./live-draw.js";

/** Analysed records of a playlist: [{ track, record, score, valence }]. */
export function playlistPoints(pl) {
  if (!pl) return [];
  const records = [...state.records.values()];
  const m = matchPlaylist(pl.tracks, records, {});
  return pl.tracks.map((t) => {
    const r = state.records.get(m.get(t.id)?.recordId);
    return r?.finalScore != null ? { track: t, record: r, score: r.finalScore, valence: r.valence ?? 50 } : null;
  }).filter(Boolean);
}

export function playlistStats(pl) {
  const pts = playlistPoints(pl);
  const n = pts.length;
  const mean = (f) => (n ? pts.reduce((a, p) => a + f(p), 0) / n : null);
  const median = (vals) => {
    const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : null;
  };
  const keys = new Map();
  for (const p of pts) {
    const k = p.record.auto?.music?.key?.index;
    if (k != null) keys.set(k, (keys.get(k) ?? 0) + 1);
  }
  const stages = STAGES.map(() => 0);
  for (const p of pts) stages[STAGES.indexOf(stageFor(p.score))]++;
  const scores = pts.map((p) => p.score).sort((a, b) => a - b);
  return {
    name: pl.name, total: pl.tracks.length, analysed: n,
    intensity: mean((p) => p.score), valence: mean((p) => p.valence),
    spread: n > 2 ? scores[Math.floor(n * 0.9)] - scores[Math.floor(n * 0.1)] : null,
    bpm: median(pts.map((p) => p.record.auto?.music?.tempo?.bpm)),
    sung: pts.filter((p) => p.record.vocals?.state === "vocal").length,
    topKeys: [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => `${keyName(k)} (${c})`),
    stages,
  };
}

/**
 * Draws the map. Returns hit-test data for hover / click.
 * @param {HTMLCanvasElement} canvas
 * @param {{main:object[], other?:object[]}} sets  points from playlistPoints
 */
export function drawMap(canvas, { main, other = [] }, hoverId = null) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return [];
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cs = getComputedStyle(canvas);
  const muted = cs.getPropertyValue("--muted").trim() || "#777";
  const grid = cs.getPropertyValue("--grid").trim() || "#ddd";
  const text = cs.getPropertyValue("--text").trim() || "#000";
  const m = { l: 38, r: 12, t: 12, b: 30 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const X = (v) => m.l + (v / 100) * pw, Y = (v) => m.t + ph - (v / 100) * ph;
  // quadrants
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.fillStyle = muted;
  ctx.globalAlpha = 0.45;
  ctx.textAlign = "left";
  ctx.fillText("Serein", X(3), Y(95));
  ctx.fillText("Mélancolique", X(3), Y(5) - 4);
  ctx.textAlign = "right";
  ctx.fillText("Euphorique", X(97), Y(95));
  ctx.fillText("Sombre / rageur", X(97), Y(5) - 4);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = muted;
  for (const v of [0, 25, 50, 75, 100]) {
    ctx.beginPath(); ctx.moveTo(X(v) + 0.5, m.t); ctx.lineTo(X(v) + 0.5, m.t + ph); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(m.l, Y(v) + 0.5); ctx.lineTo(m.l + pw, Y(v) + 0.5); ctx.stroke();
    ctx.textAlign = "center"; ctx.fillText(String(v), X(v), h - 16);
    ctx.textAlign = "right"; ctx.fillText(String(v), m.l - 6, Y(v) + 3);
  }
  ctx.textAlign = "center";
  ctx.fillText("calme → intensité → bruitiste", m.l + pw / 2, h - 3);
  ctx.save();
  ctx.translate(11, m.t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("sombre → ambiance → lumineux", 0, 0);
  ctx.restore();
  const hits = [];
  // comparison playlist: hollow squares
  for (const p of other) {
    const x = X(p.score), y = Y(p.valence);
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 4, y - 4, 8, 8);
    hits.push({ x, y, p, other: true });
  }
  for (const p of main) {
    const x = X(p.score), y = Y(p.valence);
    ctx.beginPath();
    ctx.arc(x, y, p.record.id === hoverId ? 8 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = intensityColor(p.score);
    ctx.fill();
    ctx.strokeStyle = text;
    ctx.lineWidth = p.record.id === hoverId ? 2 : 0.8;
    ctx.stroke();
    hits.push({ x, y, p });
  }
  // centroids
  const cen = (pts) => pts.length && [pts.reduce((a, p) => a + p.score, 0) / pts.length, pts.reduce((a, p) => a + p.valence, 0) / pts.length];
  for (const [pts, label] of [[main, "moyenne"], [other, "moyenne (comparée)"]]) {
    const c = cen(pts);
    if (!c) continue;
    ctx.strokeStyle = text;
    ctx.lineWidth = 2;
    const [x, y] = [X(c[0]), Y(c[1])];
    ctx.beginPath(); ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); ctx.stroke();
    ctx.fillStyle = text;
    ctx.textAlign = "left";
    ctx.fillText(label, x + 10, y - 6);
  }
  return hits;
}

export function compareHtml(a, b) {
  const f = (v, d = 0) => (v == null ? "—" : v.toFixed(d));
  const rows = [
    ["Titres analysés", (s) => `${s.analysed} / ${s.total}`],
    ["Intensité moyenne", (s) => f(s.intensity)],
    ["Ambiance moyenne", (s) => f(s.valence)],
    ["Étendue d'intensité (p10–p90)", (s) => f(s.spread)],
    ["Tempo médian", (s) => (s.bpm ? `${Math.round(s.bpm)} BPM` : "—")],
    ["Morceaux chantés", (s) => String(s.sung)],
    ["Tonalités fréquentes", (s) => s.topKeys.join(", ") || "—"],
  ];
  const bars = (s) => {
    const max = Math.max(1, ...s.stages);
    return `<div class="stage-bars">${s.stages.map((c, i) => `<i title="${escapeHtml(STAGES[i].label)} : ${c}" style="height:${(c / max) * 100}%;background:${intensityColor((STAGES[i].min + (STAGES[i + 1]?.min ?? 100)) / 2)}"></i>`).join("")}</div>`;
  };
  return `<table class="pl-compare">
    <thead><tr><th></th><th>${escapeHtml(a.name)}</th>${b ? `<th>${escapeHtml(b.name)}</th>` : ""}</tr></thead>
    <tbody>${rows.map(([k, fn]) => `<tr><td>${k}</td><td>${fn(a)}</td>${b ? `<td>${fn(b)}</td>` : ""}</tr>`).join("")}
    <tr><td>Répartition par palier</td><td>${bars(a)}</td>${b ? `<td>${bars(b)}</td>` : ""}</tr></tbody></table>`;
}
