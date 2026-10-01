// Track detail dialog: why a track got its score, manual edit, actions.

import { DIMENSIONS, stageFor, SCORE_MAX, ALGORITHM_VERSION, ANALYSIS, AGGREGATIONS, CURVE_STATS, LYRICS_MOODS, LYRICS_LEVELS } from "../config.js";
import { moodLabel, lyricsEffect, dynamicsScore } from "../scoring/describe.js";
import { aggregate } from "../scoring/aggregate.js";
import { renderTimeline } from "./charts.js";
import { state, subscribe } from "../app/store.js";
import { statusOf, needsReanalysis, communityScore } from "../core/track.js";
import * as ctl from "../app/controller.js";
import { formatDuration, formatSize, formatScore, formatDate, escapeHtml } from "../util/format.js";
import { questionById } from "../scoring/correction.js";
import { openCorrection } from "./correction.js";
import { toast } from "./toast.js";
import { intensityColor } from "./live-draw.js";
import { player } from "./player.js";
import { openInRhythm } from "./rhythm.js";
import { t, tn } from "../i18n/index.js";
import { rescanRecord } from "./live.js";
import { openConcert } from "./concert.js";
import { cloudConfigured } from "../cloud/firebase.js";
import { isSignedIn } from "../cloud/account.js";
import { sidOf } from "../cloud/tracks.js";
import { desiredVote, refreshCommunity } from "../cloud/sync.js";

const dialog = () => document.getElementById("detail-dialog");
let currentId = null;
let reportOpen = false;

export function initDetail() {
  const d = dialog();
  d.addEventListener("close", () => { currentId = null; });
  d.addEventListener("change", (e) => {
    if (e.target.id !== "timeline-series" || !currentId) return;
    seriesKey = e.target.value;
    renderTimelineSection(state.records.get(currentId));
  });
  d.addEventListener("click", async (e) => {
    if (e.target === d) return d.close(); // backdrop
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (!action || !currentId) return;
    const id = currentId;
    const r = state.records.get(id);
    switch (action) {
      case "close": d.close(); break;
      case "mismatch": openCorrection(id); break;
      case "play": player.toggle(id); break;
      case "rhythm": d.close(); openInRhythm(id); break;
      case "concert": {
        // from the playhead when the track is playing or was stopped somewhere
        const from = player.isPlaying(id) || player.position(id) ? player.position(id) : null;
        d.close();
        openConcert(id, { from, onClose: () => openDetail(id) });
        break;
      }
      case "manual-save": {
        const v = Number(d.querySelector("#manual-score").value);
        if (!Number.isFinite(v) || v < 0) return toast(t("The score must be 0 or more."), "error");
        await ctl.setManual(id, v);
        toast(t("Manual score: {n}", { n: Math.round(v) }));
        break;
      }
      case "manual-clear": await ctl.setManual(id, null); break;
      case "vocals": {
        const v = e.target.closest("[data-value]").dataset.value || null;
        await ctl.setVocalState(id, v);
        break;
      }
      case "lyrics-mood": {
        const mood = e.target.closest("[data-mood]").dataset.mood;
        await ctl.setLyrics(id, r.lyrics?.mood === mood ? null : { mood, strength: r.lyrics?.strength ?? 2 });
        break;
      }
      case "lyrics-level":
        if (r.lyrics) await ctl.setLyrics(id, { mood: r.lyrics.mood, strength: Number(e.target.closest("[data-level]").dataset.level) });
        break;
      case "open": openDetail(e.target.closest("[data-id]").dataset.id); break;
      case "genre-save": {
        const v = d.querySelector("#genre-input").value.trim();
        await ctl.setGenre(id, v || null);
        if (v) toast(t("Genre: {g}", { g: v }));
        break;
      }
      case "genre-apply": await ctl.setGenre(id, e.target.closest("[data-label]").dataset.label); break;
      case "genre-clear": await ctl.setGenre(id, null); break;
      case "seek":
        if (player.canPlay(id)) player.playAt(id, Number(e.target.closest("[data-t]").dataset.t));
        break;
      case "correction-clear": await ctl.removeCorrection(id); toast(t("Correction removed.")); break;
      case "recompute": await ctl.recompute(id); toast(t("Score recomputed from the cached features.")); break;
      case "reanalyze":
        if (r.source?.kind === "spotify") {
          // captured from Spotify: scan just this track again in the Live tab
          d.close();
          try {
            const rec = await rescanRecord(r);
            if (rec?.finalScore != null) toast(t("Re-analysed: {name} ({n}).", { name: r.name, n: Math.round(rec.finalScore) }));
          } catch (err) {
            toast(err?.message || String(err), "error", 7000);
          }
        } else if (ctl.reanalyze(id)) toast(t("Audio re-analysis started."));
        else toast(t("Audio file not available in this session: import it again (it is recognised by its fingerprint)."), "error");
        break;
      case "report": reportOpen = !reportOpen; render(true); break;
      case "report-save":
      case "report-download": {
        const exp = d.querySelector("#report-expected").value;
        await ctl.reportTrack(id, { comment: d.querySelector("#report-comment").value, expected: exp === "" ? null : Number(exp) });
        if (action === "report-download") await ctl.exportReports([id]);
        toast(t("Report saved. Export every report from Settings."));
        reportOpen = false;
        render(true);
        break;
      }
      case "vote": await ctl.validateScore(id, true); toast(t("Vote saved: this score counts in the community score.")); break;
      case "unvote": await ctl.validateScore(id, false); break;
      case "go-account": d.close(); document.getElementById("tab-stats")?.click(); break;
      case "validate-draft": await ctl.validateDraft(id); toast(t("Draft validated: the track now counts in stats and games.")); break;
      case "delete":
        if (confirm(t("Delete “{name}” and its corrections from the local database?", { name: r.name }))) {
          await ctl.deleteTrack(id);
          d.close();
        }
        break;
    }
  });
  subscribe(() => { if (currentId && dialog().open) render(); });
  player.onChange(() => {
    if (!currentId || !dialog().open) return;
    const btn = dialog().querySelector("[data-action=play]");
    if (btn) btn.textContent = player.isPlaying(currentId) ? t("Pause") : t("Play");
    animatePlayhead(currentId);
  });
}

export function openDetail(id) {
  if (!state.records.has(id)) return;
  // fresh community score for the track looked at
  if (isSignedIn() && sidOf(state.records.get(id))) refreshCommunity({ ids: [id] }).catch(() => {});
  seriesKey = "intensity";
  if (currentId !== id) reportOpen = false;
  currentId = id;
  dialog().dataset.id = id; // read by the backdrop's heat (main.js)
  render(true);
  if (!dialog().open) dialog().showModal();
}

let renderedKey = "";

function render(force = false) {
  const r = state.records.get(currentId);
  const d = dialog();
  if (!r) return d.close();
  // skip re-renders triggered by unrelated progress updates
  const key = `${r.id}|${r.updatedAt}|${state.files.has(r.id)}`;
  if (!force && key === renderedKey) return;
  const sameRecord = key === renderedKey;
  renderedKey = key;
  const focusedId = document.activeElement?.id;
  const manualValue = sameRecord ? d.querySelector("#manual-score")?.value : undefined;
  const status = statusOf(r);
  const auto = r.auto;
  const final = r.finalScore;
  const overrides = r.correction?.overrides ?? {};
  const canPlay = player.canPlay(r.id);

  d.innerHTML = `
    <div class="dialog-head">
      <div>
        <h2>${escapeHtml(r.name)}</h2>
        <div class="muted small">${r.size ? `${formatSize(r.size)} · ` : ""}${formatDuration(r.duration)} · ${t("added on {d}", { d: formatDate(r.addedAt) })}</div>
      </div>
      <button class="icon-btn" data-action="close" aria-label="${t("Close")}">✕</button>
    </div>
    <div class="dialog-body">
      ${r.draft ? `<div class="notice draft-notice"><span>${t("Draft: only {n} % of this track was heard in the Live tab. It stays out of stats and games until you validate it.", { n: Math.round((r.source?.coverage ?? 0) * 100) })}</span> <button class="btn small primary" data-action="validate-draft">${t("Validate")}</button></div>` : ""}
      ${r.error && !auto ? `<div class="notice">⚠ ${escapeHtml(r.error)}</div>` : ""}
      ${needsReanalysis(r) ? `<div class="notice">${t("Features extracted by an older version of the analysis ({v}). The score stays valid; analyse the track again to use the new measures.", { v: escapeHtml(r.featureVersion) })}</div>` : ""}
      ${reportOpen && auto ? reportBlock(r) : ""}
      ${auto ? scoreBlock(r, final) : `<p class="muted">${t("Not analysed yet.")}</p>`}
      ${auto ? communityBlock(r) : ""}
      ${auto ? musicBlock(r, canPlay) : ""}
      ${auto ? genreBlock(r) : ""}
      ${auto ? lyricsBlock(r) : ""}
      ${auto?.curves ? `
        <h3>${t("Over time")}</h3>
        <div class="card">
          <div class="timeline-head">
            <select id="timeline-series" aria-label="${t("Curve shown")}">${seriesFor(r).map((sr) => `<option value="${sr.key}" ${sr.key === seriesKey ? "selected" : ""}>${sr.label}</option>`).join("")}</select>
            <span class="muted small">${t("{n} s windows", { n: r.features?.timeline?.windowSeconds ?? "—" })}${r.features?.excerpted ? t(" · excerpts spread over the track") : ""}${canPlay ? t(" · click the curve: play from there, click again: stop") : ""}</span>
          </div>
          <div id="timeline-chart"></div>
          <div class="agg-stats" id="timeline-stats"></div>
        </div>` : ""}
      ${auto ? `
        <h3>${t("Why this score?")}</h3>
        <div class="subs">${DIMENSIONS.map((dim) => subRow(dim, auto, overrides)).join("")}</div>
        <p class="muted small">${t("The bar shows the automatic sub-score (same aggregation as the score, applied to its curve), the vertical line the corrected value. “rel.” = how consistent the measures making up the dimension are.")}</p>
        ${correctionBlock(r)}
        <h3>${t("Manual score")}</h3>
        <div class="manual-edit">
          <input type="number" id="manual-score" min="0" step="1" value="${manualValue ?? (r.manual ? r.manual.score : Math.round(final))}" aria-label="${t("Manual score")}">
          <button class="btn small" data-action="manual-save">${t("Apply")}</button>
          ${r.manual ? `<button class="btn small" data-action="manual-clear">${t("Remove the manual score")}</button>` : ""}
          <span class="muted small">${t("Overrides the automatic score and the correction.")}</span>
        </div>
        ${similarBlock(r)}
        <h3>${t("Audio features")}</h3>
        ${featuresBlock(r.features)}
      ` : ""}
      ${r.history?.length ? `<h3>${t("History")}</h3><ul class="history">${r.history.slice(-8).reverse().map((h) => `<li>${formatDate(h.at)} — ${escapeHtml(t(h.kind))}: ${formatScore(h.score)} <span class="muted">(v${escapeHtml(h.algorithmVersion)})</span></li>`).join("")}</ul>` : ""}
    </div>
    <div class="dialog-actions">
      <button class="btn danger" data-action="delete">${t("Delete")}</button>
      <span class="spacer"></span>
      ${canPlay ? `<button class="btn" data-action="play">${player.isPlaying(r.id) ? t("Pause") : t("Play")}</button>` : ""}
      ${auto?.curves && canPlay ? `<button class="btn cc-open-btn" data-action="concert" title="${t("Full-screen show driven by this track's analysis")}"><span class="cc-spark" aria-hidden="true">✦</span> ${t("Concert")}</button>` : ""}
      ${state.files.has(r.id) || r.rhythm ? `<button class="btn" data-action="rhythm" title="${t("Split into notes for a rhythm game map")}">${t("Rhythm")}</button>` : ""}
      ${r.features ? `<button class="btn" data-action="recompute" title="${t("Recomputes from the cached features, without reading the audio")}">${t("Recompute")}</button>` : ""}
      <button class="btn" data-action="reanalyze" title="${r.source?.kind === "spotify" ? t("Plays and analyses this track again in the Live tab") : t("Reads and analyses the audio file again")}">${t("Re-analyse the audio")}</button>
      ${auto ? `<button class="btn" data-action="report" aria-pressed="${reportOpen}" title="${t("Save everything about this track for a closer look at the model")}">⚑ ${t("Report for analysis")}</button>` : ""}
      ${auto ? `<button class="btn primary" data-action="mismatch">${t("The score is off")}</button>` : ""}
    </div>`;
  if (auto?.curves) renderTimelineSection(r);
  if (focusedId) d.querySelector(`#${focusedId}`)?.focus();
}

// ---------- timeline ----------

let seriesKey = "intensity";

const db10 = (v) => 10 * Math.log10(Math.max(v, 1e-12));
const signed = (v, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;

/** Curves available for a track: intensity, sub-scores, then raw features. */
function seriesFor(r) {
  const c = r.auto.curves;
  const tl = r.features?.timeline;
  const list = [
    { key: "intensity", label: t("Intensity"), values: c.intensity, score: true },
    ...DIMENSIONS.map((d) => ({ key: `sub:${d.key}`, label: `${t("Sub-score")} · ${d.label}`, values: c.subscores[d.key], score: true })),
  ];
  if (tl?.series) {
    const sr = tl.series;
    list.push(
      // BPM only where the beat is reliable enough
      { key: "bpm", label: t("BPM (when reliable)"), values: sr.bpm.map((v, i) => (v && sr.bpmConfidence[i] >= 0.3 ? v : null)), format: (v) => v.toFixed(0) },
      { key: "loudnessRel", label: t("Level relative to the track (LU)"), values: sr.loudnessRel, format: (v) => signed(v) },
      { key: "onsetRate", label: t("Attacks / s"), values: sr.onsetRate, format: (v) => v.toFixed(1) },
      { key: "lowPulse", label: t("Low-end attacks"), values: sr.lowPulse, format: (v) => v.toFixed(3) },
      { key: "bassRatio", label: t("Low-end weight (%)"), values: sr.bassRatio.map((v) => v * 100), format: (v) => v.toFixed(0) },
      { key: "centroidMean", label: t("Brightness · centroid (Hz)"), values: sr.centroidMean, format: (v) => v.toFixed(0) },
      { key: "flatnessMedian", label: t("Spectral flatness (dB)"), values: sr.flatnessMedian.map(db10), format: (v) => v.toFixed(1) },
      { key: "plrDb", label: t("Peak / loudness (dB)"), values: sr.plrDb, format: (v) => v.toFixed(1) },
    );
    if (sr.spectralContrast) list.push({ key: "spectralContrast", label: t("Spectral contrast (dB)"), values: sr.spectralContrast, format: (v) => v.toFixed(1) });
    if (sr.midFlatnessMedian) list.push({ key: "midFlatnessMedian", label: t("Distortion · mid flatness (dB)"), values: sr.midFlatnessMedian.map(db10), format: (v) => v.toFixed(1) });
    if (sr.fastPulseShare) list.push({ key: "fastPulseShare", label: t("Regular attacks / s"), values: sr.fastPulseRate ? sr.fastPulseRate.map((v, i) => (sr.fastPulseShare[i] >= 0.2 ? v : null)) : sr.fastPulseShare.map(() => null), format: (v) => v.toFixed(1) });
    if (sr.pulseRate) list.push({ key: "pulseRate", label: t("Kick speed (/s)"), values: sr.pulseRate.map((v, i) => (sr.pulseStrength[i] >= 0.3 ? v : null)), format: (v) => v.toFixed(1) });
    list.push(
    );
  }
  return list;
}

function renderTimelineSection(r) {
  const d = dialog();
  const host = d.querySelector("#timeline-chart");
  if (!host || !r?.auto?.curves) return;
  const list = seriesFor(r);
  const sr = list.find((x) => x.key === seriesKey) ?? list[0];
  const times = r.auto.curves.times;
  const fmt = sr.format ?? ((v) => v.toFixed(0));
  const agg = r.auto.aggregation ?? state.aggregation;
  const aggLabel = AGGREGATIONS.find((a) => a.key === agg)?.label ?? agg;
  renderTimeline(host, {
    times,
    values: sr.values,
    min: sr.score ? 0 : undefined,
    max: sr.score ? Math.max(100, ...sr.values.filter(Number.isFinite)) : undefined,
    format: fmt,
    bands: sr.key === "intensity",
    ref: sr.key === "intensity" ? r.auto.score : undefined,
    refLabel: sr.key === "intensity" ? `${t("auto score")} · ${aggLabel}` : undefined,
    duration: r.duration ?? undefined,
    onSeek: player.canPlay(r.id) ? (t) => {
      if (player.isPlaying(r.id)) player.stop();
      else player.playAt(r.id, t);
    } : undefined,
  });
  animatePlayhead(r.id);
  const keys = [...AGGREGATIONS.map((a) => a.key).filter((k) => sr.score || k !== "perceptual"), ...CURVE_STATS.map((c) => c.key)];
  const label = (k) => AGGREGATIONS.find((a) => a.key === k)?.label ?? CURVE_STATS.find((c) => c.key === k)?.label ?? k;
  const values = sr.values.map((v) => (v == null ? NaN : v));
  d.querySelector("#timeline-stats").innerHTML = values.some(Number.isFinite)
    ? keys.map((k) => `<div class="${sr.score && k === agg ? "active" : ""}" title="${escapeHtml(AGGREGATIONS.find((a) => a.key === k)?.hint ?? CURVE_STATS.find((c) => c.key === k)?.hint ?? "")}"><span>${label(k)}</span><b>${fmt(aggregate(values, k, times))}</b></div>`).join("")
    : `<p class="muted small">${t("No reliable value on this track.")}</p>`;
}

let rafId = 0;
/** Moves the timeline playhead while this track plays. */
function animatePlayhead(id) {
  cancelAnimationFrame(rafId);
  const step = () => {
    const host = dialog().querySelector("#timeline-chart");
    if (!host?.setPlayhead || currentId !== id) return;
    host.setPlayhead(player.isPlaying(id) || player.position(id) ? player.position(id) : null);
    if (player.isPlaying(id)) rafId = requestAnimationFrame(step);
  };
  step();
}

// ---------- music, lyrics, similar ----------

const SECTION_COLORS = { Intro: "#60a5fa", "Build-up": "#fbbf24", Peak: "#ef4444", Break: "#a78bfa", Section: "#94a3b8", Outro: "#34d399" };

function musicBlock(r, canPlay) {
  const m = r.auto.music;
  if (!m) return "";
  const k = m.key, tp = m.tempo;
  const val = r.valence ?? m.mood?.valence;
  const keyTxt = k ? `<b>${escapeHtml(k.name)} · ${escapeHtml(k.camelot)}</b><small>${t("rel. {n} %", { n: Math.round(k.confidence * 100) })}${k.startCamelot && (k.startCamelot !== k.camelot || k.endCamelot !== k.camelot) ? ` · ${t("start {a}, end {b}", { a: k.startCamelot, b: k.endCamelot })}` : ""}</small>` : "—";
  const tempoTxt = tp ? `<b>${Math.round(tp.bpm)} BPM</b><small>${tp.stability != null ? t("{n} % steady", { n: Math.round(tp.stability * 100) }) : ""}${tp.alt ? ` · ${t("or {n}", { n: Math.round(tp.alt) })}` : ""}${Math.round(tp.start) !== Math.round(tp.end) ? ` · ${Math.round(tp.start)} → ${Math.round(tp.end)}` : ""}</small>` : "—";
  const moodTip = (m.mood?.explain ?? []).map((p) => `${t(p.label)}: ${Math.round(p.value * 100)}`).join("\n");
  const secs = m.sections;
  const dur = r.duration || secs?.at(-1)?.end || 1;
  return `<h3>${t("Music")}</h3>
    <div class="music-grid">
      <div class="music-tile"><span>${t("Key")}</span>${keyTxt}</div>
      <div class="music-tile"><span>Tempo</span>${tempoTxt}</div>
      <div class="music-tile" title="${escapeHtml(moodTip)}"><span>${t("Mood")}</span><b>${escapeHtml(moodLabel(r.finalScore, val))}</b>
        <div class="valence-bar" aria-label="${t("Mood {n} out of 100", { n: Math.round(val ?? 0) })}"><i style="left:${val ?? 50}%"></i></div>
        <small>${t("dark")} · ${Math.round(val ?? 0)} · ${t("bright")}${r.lyrics ? t(" (lyrics included)") : ""}</small></div>
    </div>
    ${secs?.length ? `<div class="sections-bar" role="img" aria-label="${t("Track structure")}">${secs.map((sc) => `<button type="button" class="section" data-action="seek" data-t="${sc.start}" style="flex:${Math.max(0.5, sc.end - sc.start)};background:${SECTION_COLORS[sc.label] ?? "#94a3b8"}" title="${escapeHtml(t(sc.label))} · ${formatDuration(sc.start)} – ${formatDuration(sc.end)} · ${t("level {n} dB", { n: sc.level.toFixed(1) })}${canPlay ? t(" · click: play") : ""}" ${canPlay ? "" : "tabindex=\"-1\""}>${sc.end - sc.start > dur * 0.07 ? escapeHtml(t(sc.label)) : ""}</button>`).join("")}</div>
      <p class="muted small">${t("Detected structure (changes of timbre, harmony and level).")}</p>`
      : `<p class="muted small">${r.features?.excerpted ? t("Structure: not available for an analysis by excerpts.") : t("Structure: to compute (re-analysis needed).")}</p>`}`;
}

const SOURCE_LABEL = { user: "your label", spotify: "the artist's Spotify genres", musicbrainz: "MusicBrainz genres", lastfm: "Last.fm tags", neighbours: "suggestion (close tracks)" };
const SOURCE_NAME = { musicbrainz: "MusicBrainz", lastfm: "Last.fm", spotify: "Spotify" };
const SOURCE_LIST = { musicbrainz: "MusicBrainz genres (track, album, artist):", lastfm: "Last.fm tags:", spotify: "The artist's Spotify genres:" };
const pct = (p) => `${Math.round(p * 100)} %`;

function genreBlock(r) {
  const g = ctl.genreInfo(r);
  const known = ctl.allGenres();
  const chips = [];
  const seen = new Set([r.genre?.label, g.label]);
  const extSrc = r.extGenres?.source ?? "spotify";
  const srcName = SOURCE_NAME[extSrc] ?? extSrc;
  for (const s of g.suggestions) if (!seen.has(s.label)) { seen.add(s.label); chips.push({ label: s.label, why: `${t("close tracks")} · ${pct(s.confidence)}`, tag: pct(s.confidence) }); }
  for (const sp of g.spotify) if (!seen.has(sp.label)) { seen.add(sp.label); chips.push({ label: sp.label, why: `${srcName} · ${sp.raw}`, tag: srcName }); }
  return `<h3>${t("Genre")}</h3>
    <div class="genre-box">
      <div class="lyrics-row">
        ${g.label ? `<span class="genre-label ${g.source === "user" ? "sure" : ""}">${escapeHtml(g.label)}</span><span class="muted small">${t(SOURCE_LABEL[g.source] ?? g.source)}${g.source === "neighbours" ? ` · ${pct(g.confidence)}` : ""}</span>` : `<span class="muted small">${t("No genre yet.")}</span>`}
        ${g.label && g.source !== "user" ? `<button type="button" class="btn small" data-action="genre-apply" data-label="${escapeHtml(g.label)}">✓ ${t("That's it")}</button>` : ""}
        ${r.genre ? `<button type="button" class="link-btn" data-action="genre-clear">${t("remove my label")}</button>` : ""}
      </div>
      <div class="lyrics-row">
        <input type="text" id="genre-input" list="genre-list" placeholder="${t("e.g. Electronic › Hardstyle › Rawstyle")}" value="${escapeHtml(r.genre?.label ?? "")}" aria-label="Genre">
        <datalist id="genre-list">${known.map((k) => `<option value="${escapeHtml(k)}">`).join("")}</datalist>
        <button type="button" class="btn small primary" data-action="genre-save">${t("Save")}</button>
      </div>
      ${chips.length ? `<div class="lyrics-row small">${t("Suggestions:")} ${chips.map((c) => `<button type="button" class="chip-btn" data-action="genre-apply" data-label="${escapeHtml(c.label)}" title="${escapeHtml(c.why)}">${escapeHtml(c.label)} <span class="muted">${escapeHtml(c.tag)}</span></button>`).join("")}</div>` : ""}
      <p class="muted small">${t("Your own taxonomy, as precise as you like (levels separated by ›). By default: the genres MusicBrainz gives for the track, its album and its artist (fetched automatically), else a suggestion from close tracks. Your label always wins.")}</p>
      ${g.spotify.length ? `<div class="small muted">${t(SOURCE_LIST[extSrc] ?? SOURCE_LIST.spotify)} ${g.spotify.map((x) => escapeHtml(x.raw)).join(", ")}</div>` : ""}
    </div>`;
}

function lyricsBlock(r) {
  const v = r.vocals?.state ?? null;
  const src = r.vocals?.source === "musicbrainz" ? t(" (tagged instrumental on MusicBrainz)") : "";
  const eff = lyricsEffect(r.lyrics);
  const btn = (value, label) => `<button type="button" class="chip-btn" data-action="vocals" data-value="${value}" aria-pressed="${v === (value || null)}">${label}</button>`;
  return `<h3>${t("Lyrics")}</h3>
    <div class="lyrics-box">
      <div class="lyrics-row">${btn("vocal", t("Sung"))}${btn("instrumental", t("Instrumental"))}${btn("", t("Don't know"))}<span class="muted small">${src}</span></div>
      ${v === "vocal" ? `
        <p class="small">${t("What mood do the lyrics give? They change how the track feels: intensity and mood are adjusted.")}</p>
        <div class="lyrics-row">${LYRICS_MOODS.map((m) => `<button type="button" class="chip-btn mood" data-action="lyrics-mood" data-mood="${m.key}" aria-pressed="${r.lyrics?.mood === m.key}">${m.icon} ${m.label}</button>`).join("")}</div>
        ${r.lyrics ? `<div class="lyrics-row"><span class="small">${t("Strength:")}</span>${[1, 2, 3].map((l) => `<button type="button" class="chip-btn" data-action="lyrics-level" data-level="${l}" aria-pressed="${r.lyrics.strength === l}">${LYRICS_LEVELS[l]}</button>`).join("")}
          <span class="small muted">${t("effect: intensity {i}, mood {v}", { i: `${eff.intensity >= 0 ? "+" : ""}${eff.intensity}`, v: `${eff.valence >= 0 ? "+" : ""}${eff.valence}` })}${r.manual ? t(" (manual score wins)") : ""}</span></div>` : ""}` : ""}
    </div>`;
}

function similarBlock(r) {
  const list = ctl.similarTracks(r.id, 5);
  if (!list.length) return "";
  return `<h3>${t("Tracks with a close timbre")}</h3>
    <ul class="similar">${list.map((x) => {
      const o = state.records.get(x.id);
      return o ? `<li><button type="button" class="link-btn" data-action="open" data-id="${escapeHtml(o.id)}">${escapeHtml(o.name)}</button><span class="muted small">${Math.round(x.similarity * 100)} % · ${formatScore(o.finalScore)}${o.auto?.music?.key ? ` · ${escapeHtml(o.auto.music.key.camelot)}` : ""}</span></li>` : "";
    }).join("")}</ul>`;
}

function scoreBlock(r, final) {
  const auto = r.auto.score;
  const showGhost = Math.round(auto) !== Math.round(final);
  return `
    <div class="score-head" style="--sc:${intensityColor(final)}">
      <span class="big-score">${formatScore(final)}</span>
      <span><strong>${stageFor(final).label}</strong><br><span class="muted small">${statusOf(r) === "corrected" ? t("automatic: {n}", { n: formatScore(auto) }) : communityScore(r) != null ? t("community score · automatic: {n}", { n: formatScore(auto) }) : t("automatic score")} · ${t("{agg} of the curve", { agg: escapeHtml(AGGREGATIONS.find((a) => a.key === r.auto.aggregation)?.label ?? "") })} · ${t("algorithm")} v${escapeHtml(r.auto.algorithmVersion)}</span></span>
    </div>
    <div class="intensity" aria-hidden="true">
      <div class="intensity-scale">
        ${showGhost ? `<span class="intensity-marker ghost" style="left:${Math.min(auto, SCORE_MAX) / SCORE_MAX * 100}%" title="${t("Automatic")}"></span>` : ""}
        <span class="intensity-tick" style="left:${(100 / SCORE_MAX) * 100}%" title="100"></span>
        <span class="intensity-marker" style="--sc:${intensityColor(final)};left:${Math.min(final, SCORE_MAX) / SCORE_MAX * 100}%"></span>
      </div>
      <div class="intensity-ends"><span>0 · ${t("Ambient")}</span><span>${SCORE_MAX} · ${t("Off the charts")}</span></div>
    </div>`;
}

function subRow(dim, auto, overrides) {
  const v = auto.subscores[dim.key] ?? 0;
  const conf = auto.confidences?.[dim.key];
  const ov = overrides[dim.key];
  const parts = auto.explain?.[dim.key] ?? [];
  const tip = [dim.hint, ...parts.map((p) => `${t(p.label)}: ${Math.round(p.value * 100)}`)].join("\n");
  return `<div class="sub-row" title="${escapeHtml(tip)}">
    <span>${dim.label}</span>
    <span class="sub-bar" role="img" aria-label="${dim.label} ${Math.round(v)}/100${ov != null ? `, ${t("corrected to {n}", { n: Math.round(ov) })}` : ""}"><i style="width:${v}%"></i>${ov != null ? `<span class="override" style="left:calc(${ov}% - 1px)"></span>` : ""}</span>
    <span class="num">${Math.round(ov ?? v)}</span>
    <span class="conf">${conf != null ? t("rel. {n} %", { n: Math.round(conf * 100) }) : ""}</span>
  </div>`;
}

function correctionBlock(r) {
  const c = r.correction;
  if (!c) return "";
  const answers = Object.entries(c.answers).map(([qid, idx]) => {
    const q = questionById(qid);
    return q ? `<li><span>${escapeHtml(q.text)}</span><strong>${escapeHtml(q.options[idx])}</strong></li>` : "";
  }).join("");
  return `<h3>${t("Your correction")}</h3>
    <ul class="delta-list">${answers}</ul>
    <p class="small">${t("Automatic score {a} → corrected {b}", { a: formatScore(c.previousScore), b: formatScore(c.score) })}
      <span class="muted">(v${escapeHtml(c.algorithmVersion)}${c.algorithmVersion !== ALGORITHM_VERSION ? t(", will be re-applied") : ""})</span>
      · <button class="link-btn" data-action="correction-clear">${t("remove the correction")}</button></p>`;
}

function featuresBlock(f) {
  if (!f) return "";
  const n = (v, d = 0, unit = "") => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${unit}`);
  const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)} %`);
  const dB = (v) => (v != null ? n(db10(v), 1, " dB") : "—");
  const items = [
    [t("Estimated BPM"), f.bpm ? `${n(f.bpm)} (${t("rel. {n} %", { n: Math.round(f.bpmConfidence * 100) })})` : "—"],
    [t("Onsets / s"), n(f.onsetRate, 1)],
    [t("File loudness*"), n(f.sourceLoudnessLufs ?? f.loudnessLufs, 1, " LUFS")],
    [t("Loudness range"), f.loudnessRange != null ? `${n(f.loudnessRange, 1, " LU")} (${t("dynamics {n}/100", { n: Math.round(dynamicsScore(f.loudnessRange)) })})` : "—"],
    [t("Crest factor"), n(f.crestDb, 1, " dB")],
    [t("Peak / loudness (PLR)"), n(f.plrDb, 1, " dB")],
    [t("Peak"), n(f.channelPeakDb, 1, " dBFS")],
    [t("Low-end attacks"), n(f.lowPulse, 3)],
    [t("Clear kicks / s"), n(f.kickRate, 1)],
    [t("Kick speed (/s)"), f.pulseRate != null ? `${n(f.pulseRate, 1)} (${t("regularity {n} %", { n: Math.round((f.pulseStrength ?? 0) * 100) })})` : "—"],
    [t("Low-end variation"), n(f.lowBandDbStd, 1, " dB")],
    [t("Low-end flatness"), dB(f.lowFlatnessMedian)],
    [t("Distortion · mid flatness"), dB(f.midFlatnessMedian)],
    [t("Spectral contrast (1.6–6.4 kHz)"), n(f.spectralContrast, 1, " dB")],
    [t("Dissonance"), n(f.dissonance, 3)],
    [t("Spectral entropy"), n(f.spectralEntropy, 3)],
    [t("Double kick (share of kicks)"), f.fastKickRatio != null ? pct(f.fastKickRatio) : "—"],
    [t("Regular attacks / s"), f.fastPulseShare == null ? "—" : f.fastPulseShare > 0
      ? t("{rate} ({bpm} BPM, {share} of the track)", { rate: n(f.fastPulseRate, 1), bpm: Math.round(f.fastPulseRate * 60), share: pct(f.fastPulseShare) })
      : t("none")],
    [t("Clipping"), pct(f.clippingRatio)],
    [t("Centroid"), n(f.centroidMean, 0, " Hz")],
    [t("Bandwidth"), n(f.bandwidthMean, 0, " Hz")],
    [t("Rolloff 85 %"), n(f.rolloffMean, 0, " Hz")],
    [t("Flatness"), dB(f.flatnessMedian)],
    [t("Spectral flux"), n(f.fluxMean, 3)],
    [t("Zero crossing"), n(f.zcrMean, 3)],
    [t("Spectral fill"), pct(f.spectralFill)],
    [t("Lows / mids / highs"), `${pct(f.bassRatio)} / ${pct(f.midRatio)} / ${pct(f.highRatio)}`],
    [t("Silence"), pct(f.silenceRatio)],
    [t("Analysed length"), `${formatDuration(f.analyzedSeconds)}${f.excerpted ? t(" (excerpts)") : ""}`],
  ];
  return `<div class="features">${items.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join("")}</div>
    <p class="muted small">${t("* Every file and capture is normalised to {n} LUFS before the analysis: the playback volume and the mastering level never change the score.", { n: ANALYSIS.referenceLufs })}</p>`;
}

function reportBlock(r) {
  return `<div class="card report-box">
    <h3>⚑ ${t("Report for analysis")}</h3>
    <p class="muted small">${t("Saves every measure of this track (and its curves), the sub-scores and how they are built, with your comment. Export the reports from Settings and send the file. No audio, no file path.")}</p>
    <div class="report-grid">
      <label>${t("Expected score")}<input type="number" id="report-expected" min="0" step="1" placeholder="${Math.round(r.finalScore)}"></label>
      <label class="wide">${t("What is wrong?")}<textarea id="report-comment" rows="3" placeholder="${escapeHtml(t("e.g. calm piano, 2–3 notes: should be much lower"))}"></textarea></label>
    </div>
    <div class="settings-actions">
      <button class="btn primary" data-action="report-save">${t("Save the report")}</button>
      <button class="btn" data-action="report-download">${t("Save and download")}</button>
      <button class="btn ghost" data-action="report">${t("Cancel")}</button>
    </div>
  </div>`;
}

/**
 * Shared database line: community score (mean of the votes), my vote, and
 * "I agree with this score" (a vote without changing anything).
 */
function communityBlock(r) {
  if (!cloudConfigured() || !sidOf(r) || r.draft) return "";
  if (!isSignedIn()) {
    return `<div class="community-line muted small">${t("Sign in to share this analysis and vote on its score.")} <button class="linklike" data-action="go-account">${t("Account")}</button></div>`;
  }
  const c = r.cloud?.community;
  const mine = desiredVote(r);
  const why = r.manual ? t("your manual score") : r.correction ? t("your correction") : r.cloud?.validated != null ? t("you agreed with it") : null;
  const pill = (v) => `<span class="score-pill" style="background:${intensityColor(v)}">${Math.round(v)}</span>`;
  return `<div class="community-line">
    <span class="community-ico" aria-hidden="true">◎</span>
    <span>${c?.n ? `${t("Community score")} ${pill(c.mean)} <span class="muted small">${tn(c.n, "{n} vote", "{n} votes")}</span>` : `<span class="muted">${t("No vote yet on this track.")}</span>`}</span>
    <span class="muted small">${mine != null ? t("Your vote: {v} ({why})", { v: mine, why }) : r.cloud?.shared ? t("Shared track: everyone who adds it gets it without analysing.") : ""}</span>
    <span class="spacer"></span>
    ${r.manual || r.correction ? "" : r.cloud?.validated != null
      ? `<button class="btn small" data-action="unvote">${t("Withdraw my vote")}</button>`
      : `<button class="btn small" data-action="vote" title="${escapeHtml(t("Counts as a vote for the score shown, without changing it."))}">${t("I agree with this score")}</button>`}
  </div>`;
}
