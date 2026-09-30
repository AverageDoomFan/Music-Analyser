// Quick review dialogs:
//  - lyrics: go through sung (or unknown) tracks and rate the mood of the lyrics
//  - duels: "which one is more intense?" pairs to calibrate the weights

import { LYRICS_MOODS, LYRICS_LEVELS, DIMENSIONS, stageFor } from "../config.js";
import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { escapeHtml, formatScore, formatDuration } from "../util/format.js";
import { player } from "./player.js";
import { toast } from "./toast.js";
import { t, tn } from "../i18n/index.js";

const dialog = () => document.getElementById("review-dialog");
let mode = null;          // "lyrics" | "duels" | "genres"
let queue = [];           // lyrics: record ids
let pos = 0;
let strength = 2;
let duel = null;          // { a, b }
let duelCount = 0;
let proposal = null;

export function initReview() {
  document.getElementById("lyrics-rate").addEventListener("click", openLyricsReview);
  document.getElementById("open-duels").addEventListener("click", openDuels);
  document.getElementById("open-genres").addEventListener("click", openGenres);
  const d = dialog();
  d.addEventListener("close", () => { player.stop?.(); mode = null; });
  d.addEventListener("click", onClick);
  // on the document: re-rendering the dialog drops the focus out of it
  document.addEventListener("keydown", (e) => { if (dialog().open) onKey(e); });
  subscribe(renderBanner);
}

function renderBanner() {
  const toRate = ctl.lyricsToRate().length;
  const unknown = [...state.records.values()].filter((r) => r.auto && !r.vocals).length;
  const bar = document.getElementById("lyrics-banner");
  bar.hidden = !toRate && !unknown;
  if (bar.hidden) return;
  const parts = [];
  if (toRate) parts.push(tn(toRate, "{n} sung track without a lyrics rating", "{n} sung tracks without a lyrics rating"));
  if (unknown) parts.push(tn(unknown, "{n} not known to be sung or not", "{n} not known to be sung or not"));
  document.getElementById("lyrics-banner-text").textContent = `${parts.join(" · ")}. ${t("Lyrics change how a track feels: rate them in a few clicks.")}`;
}

// ------------------------------------------------------------------ lyrics

export function openLyricsReview() {
  const sung = ctl.lyricsToRate();
  const unknown = [...state.records.values()].filter((r) => r.auto && !r.vocals);
  queue = [...sung, ...unknown].map((r) => r.id);
  if (!queue.length) return toast(t("Nothing to rate for now."));
  mode = "lyrics";
  pos = 0;
  strength = 2;
  render();
  dialog().showModal();
}

function lyricsCard() {
  const r = state.records.get(queue[pos]);
  if (!r) return `<p>${t("Done.")}</p>`;
  return `
    <div class="review-track">
      ${trackHead(r)}
      <p class="small muted">${r.vocals?.state === "vocal" ? t("Sung track") : t("Sung or instrumental?")}</p>
      <div class="review-moods">
        ${LYRICS_MOODS.map((m, i) => `<button type="button" class="review-mood" data-act="mood" data-mood="${m.key}"><span class="k">${i + 1}</span><span class="ic">${m.icon}</span>${m.label}</button>`).join("")}
      </div>
      <div class="lyrics-row"><span class="small">${t("Strength:")}</span>${[1, 2, 3].map((l) => `<button type="button" class="chip-btn" data-act="level" data-level="${l}" aria-pressed="${strength === l}">${LYRICS_LEVELS[l]}</button>`).join("")}</div>
      <div class="lyrics-row">
        <button type="button" class="btn" data-act="instrumental">${t("Instrumental")} <kbd>I</kbd></button>
        <button type="button" class="btn ghost" data-act="skip">${t("Skip")} <kbd>→</kbd></button>
        <span class="spacer"></span>
        <span class="muted small">${pos + 1} / ${queue.length}</span>
      </div>
    </div>`;
}

// ------------------------------------------------------------------ genres

/** Unlabelled tracks, the most uncertain suggestions first (the answers that teach the most). */
export function openGenres() {
  const list = [...state.records.values()].filter((r) => r.auto && !r.genre);
  if (!list.length) return toast(t("Every analysed track has a genre."));
  const conf = (r) => ctl.genreInfo(r).suggestions[0]?.confidence ?? 0;
  queue = list.sort((a, b) => conf(a) - conf(b)).map((r) => r.id);
  mode = "genres";
  pos = 0;
  render();
  dialog().showModal();
  setTimeout(() => dialog().querySelector("#rv-genre")?.focus(), 30);
}

function genreCard() {
  const r = state.records.get(queue[pos]);
  if (!r) return `<p>${t("Done.")}</p>`;
  const g = ctl.genreInfo(r);
  const chips = [...(g.source === "spotify" ? [[g.label, t("Spotify (main genre)")]] : []), ...g.suggestions.map((s) => [s.label, `${t("close")} · ${Math.round(s.confidence * 100)} %`]), ...g.spotify.map((x) => [x.label, `Spotify · ${x.raw}`])]
    .filter((c, i, arr) => arr.findIndex((x) => x[0] === c[0]) === i);
  return `<div class="review-track">
    ${trackHead(r)}
    <div class="lyrics-row">${chips.map(([l, why], i) => `<button type="button" class="chip-btn" data-act="genre" data-label="${escapeHtml(l)}" title="${escapeHtml(why)}">${i < 9 ? `<kbd>${i + 1}</kbd> ` : ""}${escapeHtml(l)} <span class="muted">${escapeHtml(why)}</span></button>`).join("") || `<span class="muted small">${t("No suggestion yet: the first labels serve as models.")}</span>`}</div>
    <div class="lyrics-row">
      <input type="text" id="rv-genre" list="rv-genre-list" placeholder="${t("e.g. Metal › Death metal")}" aria-label="Genre">
      <datalist id="rv-genre-list">${ctl.allGenres().map((k) => `<option value="${escapeHtml(k)}">`).join("")}</datalist>
      <button type="button" class="btn primary" data-act="genre-save">${t("Save")} <kbd>${t("Enter")}</kbd></button>
      <button type="button" class="btn ghost" data-act="skip">${t("Skip")}</button>
      <span class="spacer"></span><span class="muted small">${pos + 1} / ${queue.length}</span>
    </div></div>`;
}

async function saveGenre(label) {
  if (!label) return;
  player.stop?.();
  await ctl.setGenre(queue[pos], label);
  pos++;
  if (pos >= queue.length) { dialog().close(); return toast(t("Genres saved.")); }
  render();
  setTimeout(() => dialog().querySelector("#rv-genre")?.focus(), 30);
}

// ------------------------------------------------------------------ duels

export async function openDuels() {
  mode = "duels";
  proposal = null;
  duelCount = (await ctl.getComparisons()).length;
  duel = await ctl.nextDuel();
  if (!duel) return toast(t("At least two analysed tracks are needed."));
  render();
  dialog().showModal();
}

function duelCard() {
  if (proposal) return proposalHtml();
  const a = state.records.get(duel.a), b = state.records.get(duel.b);
  if (!a || !b) return `<p>${t("No pair left.")}</p>`;
  const side = (r, k, key) => `<div class="duel-side">
      ${trackHead(r, false)}
      <button type="button" class="btn primary duel-pick" data-act="pick" data-winner="${k}">${t("This one is more intense")} <kbd>${key}</kbd></button>
    </div>`;
  return `
    <p class="small muted">${t("Without looking at the scores: which one feels more intense? Each answer helps tune the model's weights to your perception.")}</p>
    <div class="duel">${side(a, "a", "←")}<div class="duel-vs">${t("or")}</div>${side(b, "b", "→")}</div>
    <div class="lyrics-row">
      <button type="button" class="btn" data-act="pick" data-winner="tie">${t("Same")} <kbd>=</kbd></button>
      <button type="button" class="btn ghost" data-act="next-duel">${t("Another pair")}</button>
      <span class="spacer"></span>
      <span class="muted small">${tn(duelCount, "{n} duel", "{n} duels")}</span>
      <button type="button" class="btn" data-act="propose" ${duelCount < 6 ? `disabled title="${t("At least 6 duels")}"` : ""}>${t("Fit the weights")}</button>
    </div>`;
}

function proposalHtml() {
  if (proposal.error) return `<p class="notice">${escapeHtml(proposal.error)}</p><button class="btn" data-act="back">${t("Keep duelling")}</button>`;
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)} %`);
  return `<div class="card">
    <ul class="delta-list">${DIMENSIONS.map((d) => `<li><span>${d.label}</span><span>${state.weights[d.key].toFixed(2)} → <strong>${proposal.weights[d.key].toFixed(2)}</strong></span></li>`).join("")}</ul>
    <p class="small">${t("Duels the score agrees with: {a} → <strong>{b}</strong> ({n} duels).", { a: pct(proposal.agreementBefore), b: pct(proposal.agreementAfter), n: proposal.n })}${proposal.unchanged ? " " + t("No weights explain your answers better: the current settings are kept. Keep duelling (clearer answers, or more pairs).") : ""}</p>
    <div class="settings-actions">
      <button class="btn primary" data-act="apply" ${proposal.unchanged ? "disabled" : ""}>${t("Apply")}</button>
      <button class="btn" data-act="back">${t("Keep duelling")}</button>
      <button class="btn ghost danger" data-act="reset-duels">${t("Delete the duels")}</button>
    </div></div>`;
}

// ------------------------------------------------------------------ shared

function trackHead(r, showScore = true) {
  const canPlay = player.canPlay(r.id);
  const url = r.source?.url ?? (r.source?.trackId ? `https://open.spotify.com/track/${r.source.trackId}` : null);
  const img = r.source?.image;
  const m = r.auto?.music;
  return `<div class="review-head">
      ${img ? `<img src="${escapeHtml(img)}" alt="" referrerpolicy="no-referrer">` : `<span class="review-thumb">♪</span>`}
      <div class="nm"><b>${escapeHtml(r.name)}</b>
        <div class="small muted">${formatDuration(r.duration)}${showScore && r.finalScore != null ? ` · ${formatScore(r.finalScore)} · ${escapeHtml(stageFor(r.finalScore).label)}` : ""}${m?.key ? ` · ${escapeHtml(m.key.name)}` : ""}${m?.tempo ? ` · ${Math.round(m.tempo.bpm)} BPM` : ""}</div></div>
      ${canPlay ? `<button type="button" class="btn small" data-act="play" data-id="${escapeHtml(r.id)}">${player.isPlaying(r.id) ? t("Pause") : "▶ " + t("Play")}</button>`
        : url ? `<a class="btn small" href="${escapeHtml(url)}" target="_blank" rel="noopener">${t("Open in Spotify")}</a>` : ""}
    </div>`;
}

function render() {
  const d = dialog();
  d.innerHTML = `
    <div class="dialog-head"><h2>${mode === "lyrics" ? t("Lyrics mood") : mode === "genres" ? t("Genres") : t("Which one is more intense?")}</h2><button class="icon-btn" data-act="close" aria-label="${t("Close")}">✕</button></div>
    <div class="dialog-body">${mode === "lyrics" ? lyricsCard() : mode === "genres" ? genreCard() : duelCard()}</div>`;
}

async function advanceLyrics() {
  pos++;
  strength = 2;
  if (pos >= queue.length) {
    dialog().close();
    toast(t("Lyrics rated. Thanks!"));
    return;
  }
  render();
}

async function onClick(e) {
  const d = dialog();
  if (e.target === d) return d.close();
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (act === "close") return d.close();
  if (act === "play") {
    const id = el.dataset.id;
    player.isPlaying(id) ? player.stop() : player.playAt(id, (state.records.get(id)?.duration ?? 60) * 0.4);
    return setTimeout(render, 50);
  }
  if (mode === "lyrics") {
    const id = queue[pos];
    if (act === "mood") { player.stop?.(); await ctl.setLyrics(id, { mood: el.dataset.mood, strength }); return advanceLyrics(); }
    if (act === "level") { strength = Number(el.dataset.level); return render(); }
    if (act === "instrumental") { player.stop?.(); await ctl.setVocalState(id, "instrumental"); return advanceLyrics(); }
    if (act === "skip") { player.stop?.(); return advanceLyrics(); }
  } else if (mode === "genres") {
    if (act === "genre") return saveGenre(el.dataset.label);
    if (act === "genre-save") return saveGenre(d.querySelector("#rv-genre").value.trim());
    if (act === "skip") {
      player.stop?.();
      pos++;
      if (pos >= queue.length) return d.close();
      render();
      setTimeout(() => d.querySelector("#rv-genre")?.focus(), 30);
    }
  } else {
    if (act === "pick") {
      player.stop?.();
      duelCount = await ctl.addComparison(duel.a, duel.b, el.dataset.winner);
      duel = await ctl.nextDuel();
      if (!duel) { d.close(); return toast(t("Every useful pair has been judged.")); }
      return render();
    }
    if (act === "next-duel") { duel = await ctl.nextDuel(); return render(); }
    if (act === "propose") { proposal = await ctl.proposeFromDuels(); return render(); }
    if (act === "back") { proposal = null; return render(); }
    if (act === "apply") {
      await ctl.setWeights(proposal.weights);
      proposal = null;
      toast(t("Weights fitted to your duels, scores recomputed."));
      return render();
    }
    if (act === "reset-duels") {
      if (!confirm(t("Delete every saved duel?"))) return;
      await ctl.clearComparisons();
      duelCount = 0;
      proposal = null;
      return render();
    }
  }
}

function onKey(e) {
  if (mode === "genres" && e.target.id === "rv-genre" && e.key === "Enter") {
    e.preventDefault();
    return saveGenre(e.target.value.trim());
  }
  if (e.target.matches("input, select, textarea")) return;
  if (mode === "genres") {
    const n = Number(e.key);
    const chips = dialog().querySelectorAll("[data-act=genre]");
    if (n >= 1 && n <= chips.length) { e.preventDefault(); chips[n - 1].click(); }
    return;
  }
  const click = (sel) => { const b = dialog().querySelector(sel); if (b && !b.disabled) { e.preventDefault(); b.click(); } };
  if (mode === "lyrics") {
    const n = Number(e.key);
    if (n >= 1 && n <= LYRICS_MOODS.length) click(`[data-act=mood][data-mood="${LYRICS_MOODS[n - 1].key}"]`);
    else if (e.key.toLowerCase() === "i") click("[data-act=instrumental]");
    else if (e.key === "ArrowRight") click("[data-act=skip]");
  } else if (mode === "duels" && !proposal) {
    if (e.key === "ArrowLeft") click('[data-act=pick][data-winner="a"]');
    else if (e.key === "ArrowRight") click('[data-act=pick][data-winner="b"]');
    else if (e.key === "=") click('[data-act=pick][data-winner="tie"]');
  }
}
