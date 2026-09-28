// Track detail dialog: why a track got its score, manual edit, actions.

import { DIMENSIONS, stageFor, ALGORITHM_VERSION, ANALYSIS, AGGREGATIONS, CURVE_STATS, LYRICS_MOODS, LYRICS_LEVELS } from "../config.js";
import { moodLabel, lyricsEffect } from "../scoring/describe.js";
import { aggregate } from "../scoring/aggregate.js";
import { renderTimeline } from "./charts.js";
import { state, subscribe } from "../app/store.js";
import { statusOf, needsReanalysis } from "../core/track.js";
import * as ctl from "../app/controller.js";
import { formatDuration, formatSize, formatScore, formatDate, escapeHtml } from "../util/format.js";
import { questionById } from "../scoring/correction.js";
import { openCorrection } from "./correction.js";
import { toast } from "./toast.js";
import { player } from "./player.js";
import { openInRhythm } from "./rhythm.js";

const dialog = () => document.getElementById("detail-dialog");
let currentId = null;

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
      case "manual-save": {
        const v = Number(d.querySelector("#manual-score").value);
        if (!Number.isFinite(v) || v < 0 || v > 100) return toast("Score entre 0 et 100.", "error");
        await ctl.setManual(id, v);
        toast(`Score manuel : ${Math.round(v)}`);
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
      case "lyrics-suggest": {
        const sg = r.lyricsHint?.suggestion;
        if (sg) await ctl.setLyrics(id, { mood: sg.mood, strength: sg.strength });
        break;
      }
      case "lyrics-lookup":
        try {
          const res = await ctl.lookupLyricsFor(id);
          toast(!res.found ? "Aucune parole trouvée sur LRCLIB pour ce titre." : res.instrumental ? "LRCLIB : titre instrumental." : "Paroles trouvées : suggestion d'ambiance ajoutée.");
        } catch (err) {
          toast(`LRCLIB indisponible : ${err.message}`, "error");
        }
        break;
      case "open": openDetail(e.target.closest("[data-id]").dataset.id); break;
      case "genre-save": {
        const v = d.querySelector("#genre-input").value.trim();
        await ctl.setGenre(id, v || null);
        if (v) toast(`Genre : ${v}`);
        break;
      }
      case "genre-apply": await ctl.setGenre(id, e.target.closest("[data-label]").dataset.label); break;
      case "genre-clear": await ctl.setGenre(id, null); break;
      case "seek":
        if (state.files.has(id)) player.playAt(id, Number(e.target.closest("[data-t]").dataset.t));
        break;
      case "correction-clear": await ctl.removeCorrection(id); toast("Correction retirée."); break;
      case "recompute": await ctl.recompute(id); toast("Score recalculé depuis les caractéristiques en cache."); break;
      case "reanalyze":
        if (ctl.reanalyze(id)) toast("Réanalyse de l'audio lancée.");
        else toast("Fichier audio non disponible dans cette session : réimporte-le (il sera reconnu par son empreinte).", "error");
        break;
      case "delete":
        if (confirm(`Supprimer « ${r.name} » et ses corrections de la base locale ?`)) {
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
    if (btn) btn.textContent = player.isPlaying(currentId) ? "Pause" : "Écouter";
    animatePlayhead(currentId);
  });
}

export function openDetail(id) {
  if (!state.records.has(id)) return;
  seriesKey = "intensity";
  currentId = id;
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
  const canPlay = state.files.has(r.id);

  d.innerHTML = `
    <div class="dialog-head">
      <div>
        <h2>${escapeHtml(r.name)}</h2>
        <div class="muted small">${formatSize(r.size)} · ${formatDuration(r.duration)} · ajouté le ${formatDate(r.addedAt)}</div>
      </div>
      <button class="icon-btn" data-action="close" aria-label="Fermer">✕</button>
    </div>
    <div class="dialog-body">
      ${r.error && !auto ? `<div class="notice">⚠ ${escapeHtml(r.error)}</div>` : ""}
      ${needsReanalysis(r) ? `<div class="notice">Caractéristiques extraites par une ancienne version de l'analyse (${escapeHtml(r.featureVersion)}). Le score reste valable ; réimporte le fichier pour une réanalyse complète.</div>` : ""}
      ${auto ? scoreBlock(r, final) : `<p class="muted">Pas encore analysé.</p>`}
      ${auto ? musicBlock(r, canPlay) : ""}
      ${auto ? genreBlock(r) : ""}
      ${auto ? lyricsBlock(r) : ""}
      ${auto?.curves ? `
        <h3>Évolution dans le temps</h3>
        <div class="card">
          <div class="timeline-head">
            <select id="timeline-series" aria-label="Courbe affichée">${seriesFor(r).map((sr) => `<option value="${sr.key}" ${sr.key === seriesKey ? "selected" : ""}>${sr.label}</option>`).join("")}</select>
            <span class="muted small">fenêtres de ${r.features?.timeline?.windowSeconds ?? "—"} s${r.features?.excerpted ? " · extraits répartis sur le morceau" : ""}${canPlay ? " · clic sur la courbe : lire à partir de là, re-clic : stop" : ""}</span>
          </div>
          <div id="timeline-chart"></div>
          <div class="agg-stats" id="timeline-stats"></div>
        </div>` : ""}
      ${auto ? `
        <h3>Pourquoi ce score ?</h3>
        <div class="subs">${DIMENSIONS.map((dim) => subRow(dim, auto, overrides)).join("")}</div>
        <p class="muted small">La barre montre le sous-score automatique (même méthode d'agrégation que le score, appliquée à sa courbe), le trait vertical la valeur corrigée. « fiab. » = cohérence des indicateurs qui composent la dimension.</p>
        ${correctionBlock(r)}
        <h3>Score manuel</h3>
        <div class="manual-edit">
          <input type="number" id="manual-score" min="0" max="100" step="1" value="${manualValue ?? (r.manual ? r.manual.score : Math.round(final))}" aria-label="Score manuel">
          <button class="btn small" data-action="manual-save">Appliquer</button>
          ${r.manual ? `<button class="btn small" data-action="manual-clear">Retirer le score manuel</button>` : ""}
          <span class="muted small">Prioritaire sur le score automatique et la correction.</span>
        </div>
        ${similarBlock(r)}
        <h3>Caractéristiques audio</h3>
        ${featuresBlock(r.features)}
      ` : ""}
      ${r.history?.length ? `<h3>Historique</h3><ul class="history">${r.history.slice(-8).reverse().map((h) => `<li>${formatDate(h.at)} — ${escapeHtml(h.kind)} : ${formatScore(h.score)} <span class="muted">(v${escapeHtml(h.algorithmVersion)})</span></li>`).join("")}</ul>` : ""}
    </div>
    <div class="dialog-actions">
      <button class="btn danger" data-action="delete">Supprimer</button>
      <span class="spacer"></span>
      ${canPlay ? `<button class="btn" data-action="play">${player.isPlaying(r.id) ? "Pause" : "Écouter"}</button>` : ""}
      ${canPlay || r.rhythm ? `<button class="btn" data-action="rhythm" title="Découper en notes pour une map de jeu de rythme">Rythme</button>` : ""}
      ${r.features ? `<button class="btn" data-action="recompute" title="Recalcule depuis les caractéristiques en cache, sans relire l'audio">Recalculer</button>` : ""}
      <button class="btn" data-action="reanalyze" title="Relit et réanalyse le fichier audio">Réanalyser l'audio</button>
      ${auto ? `<button class="btn primary" data-action="mismatch">Le score ne correspond pas</button>` : ""}
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
    { key: "intensity", label: "Intensité", values: c.intensity, score: true },
    ...DIMENSIONS.map((d) => ({ key: `sub:${d.key}`, label: `Sous-score · ${d.label}`, values: c.subscores[d.key], score: true })),
  ];
  if (tl?.series) {
    const sr = tl.series;
    list.push(
      // BPM only where the beat is reliable enough
      { key: "bpm", label: "BPM (si fiable)", values: sr.bpm.map((v, i) => (v && sr.bpmConfidence[i] >= 0.3 ? v : null)), format: (v) => v.toFixed(0) },
      { key: "loudnessRel", label: "Volume relatif au morceau (LU)", values: sr.loudnessRel, format: (v) => signed(v) },
      { key: "onsetRate", label: "Attaques / s", values: sr.onsetRate, format: (v) => v.toFixed(1) },
      { key: "lowPulse", label: "Attaques dans le grave", values: sr.lowPulse, format: (v) => v.toFixed(3) },
      { key: "bassRatio", label: "Poids du grave (%)", values: sr.bassRatio.map((v) => v * 100), format: (v) => v.toFixed(0) },
      { key: "centroidMean", label: "Brillance · centroïde (Hz)", values: sr.centroidMean, format: (v) => v.toFixed(0) },
      { key: "flatnessMedian", label: "Planéité spectrale (dB)", values: sr.flatnessMedian.map(db10), format: (v) => v.toFixed(1) },
      { key: "plrDb", label: "Pic / loudness (dB)", values: sr.plrDb, format: (v) => v.toFixed(1) },
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
    max: sr.score ? 100 : undefined,
    format: fmt,
    bands: sr.key === "intensity",
    ref: sr.key === "intensity" ? r.auto.score : undefined,
    refLabel: sr.key === "intensity" ? `score auto · ${aggLabel}` : undefined,
    duration: r.duration ?? undefined,
    onSeek: state.files.has(r.id) ? (t) => {
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
    : `<p class="muted small">Pas de valeur fiable sur ce morceau.</p>`;
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

const SECTION_COLORS = { Intro: "#60a5fa", Montée: "#fbbf24", Pic: "#ef4444", Break: "#a78bfa", Section: "#94a3b8", Outro: "#34d399" };

function musicBlock(r, canPlay) {
  const m = r.auto.music;
  if (!m) return "";
  const k = m.key, t = m.tempo;
  const val = r.valence ?? m.mood?.valence;
  const keyTxt = k ? `<b>${escapeHtml(k.name)} · ${escapeHtml(k.camelot)}</b><small>fiab. ${Math.round(k.confidence * 100)} %${k.startCamelot && (k.startCamelot !== k.camelot || k.endCamelot !== k.camelot) ? ` · début ${k.startCamelot}, fin ${k.endCamelot}` : ""}</small>` : "—";
  const tempoTxt = t ? `<b>${Math.round(t.bpm)} BPM</b><small>${t.stability != null ? `stable à ${Math.round(t.stability * 100)} %` : ""}${t.alt ? ` · ou ${Math.round(t.alt)}` : ""}${Math.round(t.start) !== Math.round(t.end) ? ` · ${Math.round(t.start)} → ${Math.round(t.end)}` : ""}</small>` : "—";
  const moodTip = (m.mood?.explain ?? []).map((p) => `${p.label} : ${Math.round(p.value * 100)}`).join("\n");
  const secs = m.sections;
  const dur = r.duration || secs?.at(-1)?.end || 1;
  return `<h3>Musique</h3>
    <div class="music-grid">
      <div class="music-tile"><span>Tonalité</span>${keyTxt}</div>
      <div class="music-tile"><span>Tempo</span>${tempoTxt}</div>
      <div class="music-tile" title="${escapeHtml(moodTip)}"><span>Ambiance</span><b>${escapeHtml(moodLabel(r.finalScore, val))}</b>
        <div class="valence-bar" aria-label="Ambiance ${Math.round(val ?? 0)} sur 100"><i style="left:${val ?? 50}%"></i></div>
        <small>sombre · ${Math.round(val ?? 0)} · lumineux${r.lyrics ? " (paroles comprises)" : ""}</small></div>
    </div>
    ${secs?.length ? `<div class="sections-bar" role="img" aria-label="Structure du morceau">${secs.map((sc) => `<button type="button" class="section" data-action="seek" data-t="${sc.start}" style="flex:${Math.max(0.5, sc.end - sc.start)};background:${SECTION_COLORS[sc.label] ?? "#94a3b8"}" title="${escapeHtml(sc.label)} · ${formatDuration(sc.start)} – ${formatDuration(sc.end)} · niveau ${sc.level.toFixed(1)} dB${canPlay ? " · clic : lire" : ""}" ${canPlay ? "" : "tabindex=\"-1\""}>${sc.end - sc.start > dur * 0.07 ? escapeHtml(sc.label) : ""}</button>`).join("")}</div>
      <p class="muted small">Structure détectée (changements de timbre, d'harmonie et de niveau).</p>`
      : `<p class="muted small">Structure : ${r.features?.excerpted ? "non disponible pour une analyse par extraits" : "à calculer (réanalyse nécessaire)"}.</p>`}`;
}

const SOURCE_LABEL = { user: "ton étiquette", spotify: "genres Spotify de l'artiste", voisins: "suggestion (morceaux proches)" };
const pct = (p) => `${Math.round(p * 100)} %`;

function genreBlock(r) {
  const g = ctl.genreInfo(r);
  const known = ctl.allGenres();
  const chips = [];
  const seen = new Set([r.genre?.label, g.label]);
  for (const s of g.suggestions) if (!seen.has(s.label)) { seen.add(s.label); chips.push({ label: s.label, why: `morceaux proches · ${pct(s.confidence)}` }); }
  for (const sp of g.spotify) if (!seen.has(sp.label)) { seen.add(sp.label); chips.push({ label: sp.label, why: `Spotify · ${sp.raw}` }); }
  return `<h3>Genre</h3>
    <div class="genre-box">
      <div class="lyrics-row">
        ${g.label ? `<span class="genre-label ${g.source === "user" ? "sure" : ""}">${escapeHtml(g.label)}</span><span class="muted small">${SOURCE_LABEL[g.source]}${g.source === "voisins" ? ` · ${pct(g.confidence)}` : ""}</span>` : `<span class="muted small">Pas encore de genre.</span>`}
        ${g.label && g.source !== "user" ? `<button type="button" class="btn small" data-action="genre-apply" data-label="${escapeHtml(g.label)}">✓ C'est ça</button>` : ""}
        ${r.genre ? `<button type="button" class="link-btn" data-action="genre-clear">retirer mon étiquette</button>` : ""}
      </div>
      <div class="lyrics-row">
        <input type="text" id="genre-input" list="genre-list" placeholder="ex. Électro › Hardstyle › Rawstyle" value="${escapeHtml(r.genre?.label ?? "")}" aria-label="Genre">
        <datalist id="genre-list">${known.map((k) => `<option value="${escapeHtml(k)}">`).join("")}</datalist>
        <button type="button" class="btn small primary" data-action="genre-save">Enregistrer</button>
      </div>
      ${chips.length ? `<div class="lyrics-row small">Suggestions : ${chips.map((c) => `<button type="button" class="chip-btn" data-action="genre-apply" data-label="${escapeHtml(c.label)}" title="${escapeHtml(c.why)}">${escapeHtml(c.label)} <span class="muted">${escapeHtml(c.why.startsWith("Spotify") ? "Spotify" : c.why.split(" · ")[1] ?? "")}</span></button>`).join("")}</div>` : ""}
      <p class="muted small">Ta propre taxonomie, aussi précise que tu veux (niveaux séparés par ›). Par défaut : les genres Spotify de l'artiste ; sans eux, une suggestion d'après les morceaux proches. Ton étiquette prime toujours.</p>
      ${g.spotify.length ? `<div class="small muted">Genres Spotify de l'artiste : ${g.spotify.map((x) => escapeHtml(x.raw)).join(", ")}</div>` : ""}
    </div>`;
}

function lyricsBlock(r) {
  const v = r.vocals?.state ?? null;
  const src = r.vocals?.source === "lrclib" ? " (d'après LRCLIB)" : "";
  const eff = lyricsEffect(r.lyrics);
  const hint = r.lyricsHint;
  const sg = hint?.suggestion;
  const sgMood = sg && LYRICS_MOODS.find((x) => x.key === sg.mood);
  const btn = (value, label) => `<button type="button" class="chip-btn" data-action="vocals" data-value="${value}" aria-pressed="${v === (value || null)}">${label}</button>`;
  return `<h3>Paroles</h3>
    <div class="lyrics-box">
      <div class="lyrics-row">${btn("vocal", "Chanté")}${btn("instrumental", "Instrumental")}${btn("", "Je ne sais pas")}<span class="muted small">${src}</span></div>
      ${v === "vocal" ? `
        <p class="small">Quelle ambiance donnent les paroles ? Elles changent la perception : l'intensité et l'ambiance sont ajustées.</p>
        <div class="lyrics-row">${LYRICS_MOODS.map((m) => `<button type="button" class="chip-btn mood" data-action="lyrics-mood" data-mood="${m.key}" aria-pressed="${r.lyrics?.mood === m.key}">${m.icon} ${m.label}</button>`).join("")}</div>
        ${r.lyrics ? `<div class="lyrics-row"><span class="small">Force :</span>${[1, 2, 3].map((l) => `<button type="button" class="chip-btn" data-action="lyrics-level" data-level="${l}" aria-pressed="${r.lyrics.strength === l}">${LYRICS_LEVELS[l]}</button>`).join("")}
          <span class="small muted">effet : intensité ${eff.intensity >= 0 ? "+" : ""}${eff.intensity}, ambiance ${eff.valence >= 0 ? "+" : ""}${eff.valence}${r.manual ? " (score manuel prioritaire)" : ""}</span></div>` : ""}` : ""}
      <div class="lyrics-row small muted">
        ${hint ? (hint.found ? (hint.instrumental ? "LRCLIB : instrumental." : `LRCLIB : paroles trouvées${sgMood ? ` · suggestion : <b>${escapeHtml(sgMood.label)}</b> (${LYRICS_LEVELS[sg.strength]})` : ""}.`) : "LRCLIB : rien trouvé.") : ""}
        ${sgMood && r.lyrics?.mood !== sg.mood ? `<button type="button" class="link-btn" data-action="lyrics-suggest">appliquer la suggestion</button>` : ""}
        <button type="button" class="link-btn" data-action="lyrics-lookup" title="Envoie l'artiste et le titre à lrclib.net (base de paroles ouverte). Les paroles ne sont pas conservées.">${hint ? "rechercher à nouveau" : "chercher sur LRCLIB"}</button>
      </div>
    </div>`;
}

function similarBlock(r) {
  const list = ctl.similarTracks(r.id, 5);
  if (!list.length) return "";
  return `<h3>Morceaux au timbre proche</h3>
    <ul class="similar">${list.map((x) => {
      const o = state.records.get(x.id);
      return o ? `<li><button type="button" class="link-btn" data-action="open" data-id="${escapeHtml(o.id)}">${escapeHtml(o.name)}</button><span class="muted small">${Math.round(x.similarity * 100)} % · ${formatScore(o.finalScore)}${o.auto?.music?.key ? ` · ${escapeHtml(o.auto.music.key.camelot)}` : ""}</span></li>` : "";
    }).join("")}</ul>`;
}

function scoreBlock(r, final) {
  const auto = r.auto.score;
  const showGhost = Math.round(auto) !== Math.round(final);
  return `
    <div class="score-head">
      <span class="big-score">${formatScore(final)}</span>
      <span><strong>${stageFor(final).label}</strong><br><span class="muted small">${statusOf(r) === "corrected" ? `automatique : ${formatScore(auto)}` : "score automatique"} · ${escapeHtml(AGGREGATIONS.find((a) => a.key === r.auto.aggregation)?.label ?? "")} de la courbe · algorithme v${escapeHtml(r.auto.algorithmVersion)}</span></span>
    </div>
    <div class="intensity" aria-hidden="true">
      <div class="intensity-scale">
        ${showGhost ? `<span class="intensity-marker ghost" style="left:${auto}%" title="Automatique"></span>` : ""}
        <span class="intensity-marker" style="left:${final}%"></span>
      </div>
      <div class="intensity-ends"><span>0 · calme</span><span>100 · extrême / bruitiste</span></div>
    </div>`;
}

function subRow(dim, auto, overrides) {
  const v = auto.subscores[dim.key] ?? 0;
  const conf = auto.confidences?.[dim.key];
  const ov = overrides[dim.key];
  const parts = auto.explain?.[dim.key] ?? [];
  const tip = [dim.hint, ...parts.map((p) => `${p.label} : ${Math.round(p.value * 100)}`)].join("\n");
  return `<div class="sub-row" title="${escapeHtml(tip)}">
    <span>${dim.label}</span>
    <span class="sub-bar" role="img" aria-label="${dim.label} ${Math.round(v)} sur 100${ov != null ? `, corrigé à ${Math.round(ov)}` : ""}"><i style="width:${v}%"></i>${ov != null ? `<span class="override" style="left:calc(${ov}% - 1px)"></span>` : ""}</span>
    <span class="num">${Math.round(ov ?? v)}</span>
    <span class="conf">${conf != null ? `fiab. ${Math.round(conf * 100)}%` : ""}</span>
  </div>`;
}

function correctionBlock(r) {
  const c = r.correction;
  if (!c) return "";
  const answers = Object.entries(c.answers).map(([qid, idx]) => {
    const q = questionById(qid);
    return q ? `<li><span>${escapeHtml(q.text)}</span><strong>${escapeHtml(q.options[idx])}</strong></li>` : "";
  }).join("");
  return `<h3>Correction utilisateur</h3>
    <ul class="delta-list">${answers}</ul>
    <p class="small">Score automatique ${formatScore(c.previousScore)} → corrigé ${formatScore(c.score)}
      <span class="muted">(v${escapeHtml(c.algorithmVersion)}${c.algorithmVersion !== ALGORITHM_VERSION ? ", sera réappliquée" : ""})</span>
      · <button class="link-btn" data-action="correction-clear">retirer la correction</button></p>`;
}

function featuresBlock(f) {
  if (!f) return "";
  const n = (v, d = 0, unit = "") => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${unit}`);
  const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)} %`);
  const items = [
    ["BPM estimé", f.bpm ? `${n(f.bpm)} (fiab. ${Math.round(f.bpmConfidence * 100)} %)` : "—"],
    ["Onsets / s", n(f.onsetRate, 1)],
    ["Loudness du fichier*", n(f.sourceLoudnessLufs ?? f.loudnessLufs, 1, " LUFS")],
    ["Plage dynamique", n(f.loudnessRange, 1, " LU")],
    ["Crest factor", n(f.crestDb, 1, " dB")],
    ["Pic / loudness (PLR)", n(f.plrDb, 1, " dB")],
    ["Pic", n(f.channelPeakDb, 1, " dBFS")],
    ["Attaques dans le grave", n(f.lowPulse, 3)],
    ["Kicks nets / s", n(f.kickRate, 1)],
    ["Variation du grave", n(f.lowBandDbStd, 1, " dB")],
    ["Planéité du grave", f.lowFlatnessMedian != null ? n(10 * Math.log10(Math.max(f.lowFlatnessMedian, 1e-12)), 1, " dB") : "—"],
    ["Clipping", pct(f.clippingRatio)],
    ["Centroïde", n(f.centroidMean, 0, " Hz")],
    ["Largeur de bande", n(f.bandwidthMean, 0, " Hz")],
    ["Rolloff 85 %", n(f.rolloffMean, 0, " Hz")],
    ["Planéité", n(10 * Math.log10(Math.max(f.flatnessMedian, 1e-12)), 1, " dB")],
    ["Flux spectral", n(f.fluxMean, 3)],
    ["Zero crossing", n(f.zcrMean, 3)],
    ["Remplissage spectral", pct(f.spectralFill)],
    ["Graves / médiums / aigus", `${pct(f.bassRatio)} / ${pct(f.midRatio)} / ${pct(f.highRatio)}`],
    ["Silences", pct(f.silenceRatio)],
    ["Durée analysée", `${formatDuration(f.analyzedSeconds)}${f.excerpted ? " (extraits)" : ""}`],
  ];
  return `<div class="features">${items.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join("")}</div>
    <p class="muted small">* Informatif seulement : chaque fichier est normalisé à ${ANALYSIS.referenceLufs} LUFS avant l'analyse, son volume n'influence pas le score.</p>`;
}
