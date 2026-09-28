// Quick review dialogs:
//  - lyrics: go through sung (or unknown) tracks and rate the mood of the lyrics
//  - duels: "which one is more intense?" pairs to calibrate the weights

import { LYRICS_MOODS, LYRICS_LEVELS, DIMENSIONS, stageFor } from "../config.js";
import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { escapeHtml, formatScore, formatDuration } from "../util/format.js";
import { player } from "./player.js";
import { toast } from "./toast.js";

const dialog = () => document.getElementById("review-dialog");
let mode = null;          // "lyrics" | "duels"
let queue = [];           // lyrics: record ids
let pos = 0;
let strength = 2;
let duel = null;          // { a, b }
let duelCount = 0;
let proposal = null;

export function initReview() {
  document.getElementById("lyrics-rate").addEventListener("click", openLyricsReview);
  document.getElementById("open-duels").addEventListener("click", openDuels);
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
  if (toRate) parts.push(`${toRate} morceau${toRate > 1 ? "x" : ""} chanté${toRate > 1 ? "s" : ""} sans note de paroles`);
  if (unknown) parts.push(`${unknown} dont on ne sait pas s'ils sont chantés`);
  document.getElementById("lyrics-banner-text").textContent = `${parts.join(" · ")}. Les paroles changent la perception : note-les en quelques clics.`;
}

// ------------------------------------------------------------------ lyrics

export function openLyricsReview() {
  const sung = ctl.lyricsToRate();
  const unknown = [...state.records.values()].filter((r) => r.auto && !r.vocals);
  queue = [...sung, ...unknown].map((r) => r.id);
  if (!queue.length) return toast("Rien à noter pour l'instant.");
  mode = "lyrics";
  pos = 0;
  strength = 2;
  render();
  dialog().showModal();
}

function lyricsCard() {
  const r = state.records.get(queue[pos]);
  if (!r) return `<p>Terminé.</p>`;
  const hint = r.lyricsHint?.suggestion;
  const hintMood = hint && LYRICS_MOODS.find((m) => m.key === hint.mood);
  return `
    <div class="review-track">
      ${trackHead(r)}
      <p class="small muted">${r.vocals?.state === "vocal" ? "Morceau chanté" : "Chanté ou instrumental ?"}${hintMood ? ` · suggestion d'après les paroles : <b>${escapeHtml(hintMood.label)}</b>` : ""}</p>
      <div class="review-moods">
        ${LYRICS_MOODS.map((m, i) => `<button type="button" class="review-mood ${hint?.mood === m.key ? "hinted" : ""}" data-act="mood" data-mood="${m.key}"><span class="k">${i + 1}</span><span class="ic">${m.icon}</span>${m.label}</button>`).join("")}
      </div>
      <div class="lyrics-row"><span class="small">Force :</span>${[1, 2, 3].map((l) => `<button type="button" class="chip-btn" data-act="level" data-level="${l}" aria-pressed="${strength === l}">${LYRICS_LEVELS[l]}</button>`).join("")}</div>
      <div class="lyrics-row">
        <button type="button" class="btn" data-act="instrumental">Instrumental <kbd>I</kbd></button>
        <button type="button" class="btn ghost" data-act="skip">Passer <kbd>→</kbd></button>
        <span class="spacer"></span>
        <span class="muted small">${pos + 1} / ${queue.length}</span>
      </div>
    </div>`;
}

// ------------------------------------------------------------------ duels

export async function openDuels() {
  mode = "duels";
  proposal = null;
  duelCount = (await ctl.getComparisons()).length;
  duel = await ctl.nextDuel();
  if (!duel) return toast("Il faut au moins deux morceaux analysés.");
  render();
  dialog().showModal();
}

function duelCard() {
  if (proposal) return proposalHtml();
  const a = state.records.get(duel.a), b = state.records.get(duel.b);
  if (!a || !b) return "<p>Plus de paire disponible.</p>";
  const side = (r, k, key) => `<div class="duel-side">
      ${trackHead(r, false)}
      <button type="button" class="btn primary duel-pick" data-act="pick" data-winner="${k}">Celui-ci est plus intense <kbd>${key}</kbd></button>
    </div>`;
  return `
    <p class="small muted">Sans regarder les scores : lequel ressens-tu comme le plus intense ? Chaque réponse aide à régler les pondérations du modèle sur ta perception.</p>
    <div class="duel">${side(a, "a", "←")}<div class="duel-vs">ou</div>${side(b, "b", "→")}</div>
    <div class="lyrics-row">
      <button type="button" class="btn" data-act="pick" data-winner="tie">Pareil <kbd>=</kbd></button>
      <button type="button" class="btn ghost" data-act="next-duel">Autre paire</button>
      <span class="spacer"></span>
      <span class="muted small">${duelCount} duel${duelCount > 1 ? "s" : ""}</span>
      <button type="button" class="btn" data-act="propose" ${duelCount < 6 ? "disabled title='Au moins 6 duels'" : ""}>Ajuster les pondérations</button>
    </div>`;
}

function proposalHtml() {
  if (proposal.error) return `<p class="notice">${escapeHtml(proposal.error)}</p><button class="btn" data-act="back">Continuer les duels</button>`;
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)} %`);
  return `<div class="card">
    <ul class="delta-list">${DIMENSIONS.map((d) => `<li><span>${d.label}</span><span>${state.weights[d.key].toFixed(2)} → <strong>${proposal.weights[d.key].toFixed(2)}</strong></span></li>`).join("")}</ul>
    <p class="small">Duels respectés par le score : ${pct(proposal.agreementBefore)} → <strong>${pct(proposal.agreementAfter)}</strong> (${proposal.n} duels).${proposal.unchanged ? " Aucune pondération n'explique mieux tes réponses : les réglages actuels sont gardés. Continue les duels (réponses plus tranchées, ou plus de paires)." : ""}</p>
    <div class="settings-actions">
      <button class="btn primary" data-act="apply" ${proposal.unchanged ? "disabled" : ""}>Appliquer</button>
      <button class="btn" data-act="back">Continuer les duels</button>
      <button class="btn ghost danger" data-act="reset-duels">Effacer les duels</button>
    </div></div>`;
}

// ------------------------------------------------------------------ shared

function trackHead(r, showScore = true) {
  const canPlay = state.files.has(r.id);
  const url = r.source?.url ?? (r.source?.trackId ? `https://open.spotify.com/track/${r.source.trackId}` : null);
  const img = r.source?.image;
  const m = r.auto?.music;
  return `<div class="review-head">
      ${img ? `<img src="${escapeHtml(img)}" alt="" referrerpolicy="no-referrer">` : `<span class="review-thumb">♪</span>`}
      <div class="nm"><b>${escapeHtml(r.name)}</b>
        <div class="small muted">${formatDuration(r.duration)}${showScore && r.finalScore != null ? ` · ${formatScore(r.finalScore)} · ${escapeHtml(stageFor(r.finalScore).label)}` : ""}${m?.key ? ` · ${escapeHtml(m.key.name)}` : ""}${m?.tempo ? ` · ${Math.round(m.tempo.bpm)} BPM` : ""}</div></div>
      ${canPlay ? `<button type="button" class="btn small" data-act="play" data-id="${escapeHtml(r.id)}">${player.isPlaying(r.id) ? "Pause" : "▶ Écouter"}</button>`
        : url ? `<a class="btn small" href="${escapeHtml(url)}" target="_blank" rel="noopener">Ouvrir dans Spotify</a>` : ""}
    </div>`;
}

function render() {
  const d = dialog();
  d.innerHTML = `
    <div class="dialog-head"><h2>${mode === "lyrics" ? "Ambiance des paroles" : "Lequel est le plus intense ?"}</h2><button class="icon-btn" data-act="close" aria-label="Fermer">✕</button></div>
    <div class="dialog-body">${mode === "lyrics" ? lyricsCard() : duelCard()}</div>`;
}

async function advanceLyrics() {
  pos++;
  strength = 2;
  if (pos >= queue.length) {
    dialog().close();
    toast("Paroles notées. Merci !");
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
  } else {
    if (act === "pick") {
      player.stop?.();
      duelCount = await ctl.addComparison(duel.a, duel.b, el.dataset.winner);
      duel = await ctl.nextDuel();
      if (!duel) { d.close(); return toast("Toutes les paires utiles ont été jugées."); }
      return render();
    }
    if (act === "next-duel") { duel = await ctl.nextDuel(); return render(); }
    if (act === "propose") { proposal = await ctl.proposeFromDuels(); return render(); }
    if (act === "back") { proposal = null; return render(); }
    if (act === "apply") {
      await ctl.setWeights(proposal.weights);
      proposal = null;
      toast("Pondérations ajustées à tes duels, scores recalculés.");
      return render();
    }
    if (act === "reset-duels") {
      if (!confirm("Effacer tous les duels enregistrés ?")) return;
      await ctl.clearComparisons();
      duelCount = 0;
      proposal = null;
      return render();
    }
  }
}

function onKey(e) {
  if (e.target.matches("input, select, textarea")) return;
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
