// "Games" tab. Trivia: a track plays with its score hidden, guess it, then
// keep your guess as the track's score if you disagree with the model.
// Compare: two tracks, which one hits harder (> < =)? Answers are recorded
// as duels (they refine the weights) and scores can be fixed on the spot.
// Hunt: the app draws a score, find a Spotify track outside the library that
// gets it (analysed live, with the Live tab's capture and settings).

import { state, subscribe } from "../app/store.js";
import { isCounted } from "../core/track.js";
import * as ctl from "../app/controller.js";
import { stageFor, SCORE_MAX } from "../config.js";
import { t, tn } from "../i18n/index.js";
import { escapeHtml } from "../util/format.js";
import { player } from "./player.js";
import * as api from "../spotify/api.js";
import * as auth from "../spotify/auth.js";
import { matchPlaylist } from "../spotify/match.js";
import { analyseTracks } from "./live.js";
import { huntTarget, huntPoints, bestTry } from "../games/hunt.js";
import { intensityColor } from "./live-draw.js";
import { toast } from "./toast.js";

const $ = (id) => document.getElementById(id);
const STATS_KEY = "mea.games.stats";

const EMPTY_STATS = { rounds: 0, error: 0, best: null, duels: 0, agree: 0, hunts: 0, huntError: 0, bullseyes: 0 };

const g = {
  mode: "trivia",
  onlyPlayable: true,
  hideTitle: false,
  saveDuels: true,
  trivia: null,   // { id, guess, revealed }
  duel: null,     // { a, b, answer }
  hunt: null,     // { target, query, results, tries: [{ track, score }], busy }
  recent: [],     // ids shown lately (avoid repeats)
  stats: loadStats(),
};

function loadStats() {
  try {
    return { ...EMPTY_STATS, ...JSON.parse(localStorage.getItem(STATS_KEY) || "{}") };
  } catch {
    return { ...EMPTY_STATS };
  }
}
function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(g.stats)); } catch { /* ignore */ }
}

export function initGames() {
  const panel = $("panel-games");
  panel.addEventListener("click", (e) => onClick(e).catch((err) => toast(err.message, "error")));
  panel.addEventListener("input", (e) => {
    if (e.target.id === "gm-guess" && g.trivia && !g.trivia.revealed) {
      g.trivia.guess = Number(e.target.value);
      $("gm-guess-out").textContent = g.trivia.guess;
      $("gm-guess-out").style.color = intensityColor(g.trivia.guess);
      $("gm-guess-stage").textContent = t(stageFor(g.trivia.guess).label);
    }
  });
  panel.addEventListener("change", (e) => {
    if (e.target.id === "gm-playable") { g.onlyPlayable = e.target.checked; render(); }
    if (e.target.id === "gm-hide-title") { g.hideTitle = e.target.checked; render(); }
    if (e.target.id === "gm-save-duels") g.saveDuels = e.target.checked;
  });
  document.addEventListener("keydown", (e) => {
    if ($("panel-games").hidden || e.target.closest("input[type=number],input[type=text],textarea,select")) return;
    if (g.mode === "compare" && g.duel && !g.duel.answer) {
      const map = { ArrowLeft: "a", ArrowRight: "b", ArrowDown: "tie", "<": "b", ">": "a", "=": "tie" };
      if (map[e.key]) { e.preventDefault(); answerDuel(map[e.key]).catch(() => {}); }
    }
    if (e.key === "Enter" && g.mode === "trivia" && g.trivia && !g.trivia.revealed) { e.preventDefault(); reveal(); }
  });
  panel.addEventListener("submit", (e) => {
    if (e.target.id !== "gm-hunt-search") return;
    e.preventDefault();
    search($("gm-hunt-q").value).catch((err) => toast(err.message, "error"));
  });
  player.onChange(() => { if (!$("panel-games").hidden) renderPlayButtons(); });
  subscribe(() => { if (!$("panel-games").hidden) renderPool(); });
}

export function showGames() {
  render();
}

// ------------------------------------------------------------------ pool

function pool() {
  const all = [...state.records.values()].filter((r) => isCounted(r) && r.auto);
  const playable = all.filter((r) => player.canPlay(r.id));
  return g.onlyPlayable && playable.length >= 2 ? playable : all;
}

function pick(list, exclude = []) {
  const fresh = list.filter((r) => !exclude.includes(r.id) && !g.recent.includes(r.id));
  const from = fresh.length ? fresh : list.filter((r) => !exclude.includes(r.id));
  const r = from[Math.floor(Math.random() * from.length)];
  if (r) g.recent = [r.id, ...g.recent].slice(0, Math.min(30, Math.floor(list.length / 2)));
  return r;
}

/** Start time of the most intense passage (a few seconds before the peak). */
function peakTime(r) {
  const c = r.auto?.curves;
  if (!c?.times?.length) return 0;
  let best = 0;
  for (let i = 1; i < c.intensity.length; i++) if (c.intensity[i] > c.intensity[best]) best = i;
  return Math.max(0, c.times[best] - 4);
}

// ------------------------------------------------------------------ actions

async function onClick(e) {
  const b = e.target.closest("[data-gm]");
  if (!b) return;
  const act = b.dataset.gm;
  const id = b.dataset.id;
  switch (act) {
    case "mode": g.mode = b.dataset.mode; player.stop(); render(); break;
    case "start-trivia": nextTrivia(); break;
    case "start-duel": nextDuel(); break;
    case "play": await player.toggle(id); break;
    case "play-peak": await player.playAt(id, peakTime(state.records.get(id))); break;
    case "reveal": reveal(); break;
    case "keep-guess":
      await ctl.setManual(g.trivia.id, g.trivia.guess);
      toast(t("Score set to {n}.", { n: g.trivia.guess }));
      render();
      break;
    case "set-score": {
      const input = $(`gm-score-${id}`);
      const v = Number(input?.value);
      if (!Number.isFinite(v) || v < 0 || v > SCORE_MAX) return toast(t("Score between 0 and {max}.", { max: SCORE_MAX }), "error");
      await ctl.setManual(id, v);
      toast(t("Score set to {n}.", { n: Math.round(v) }));
      render();
      break;
    }
    case "clear-score": await ctl.setManual(id, null); render(); break;
    case "answer": await answerDuel(b.dataset.answer); break;
    case "start-hunt": nextHunt(); break;
    case "hunt-analyse": await huntAnalyse(id); break;
    case "hunt-done": finishHunt(); break;
    case "detail": document.dispatchEvent(new CustomEvent("open-detail", { detail: id })); break;
    case "reset-stats":
      g.stats = { ...EMPTY_STATS };
      saveStats();
      render();
      break;
  }
}

function nextTrivia() {
  const r = pick(pool());
  if (!r) return;
  g.trivia = { id: r.id, guess: 50, revealed: false };
  render();
  if (player.canPlay(r.id)) player.playAt(r.id, peakTime(r));
}

function reveal() {
  const tr = g.trivia;
  if (!tr || tr.revealed) return;
  tr.revealed = true;
  const r = state.records.get(tr.id);
  const err = Math.abs(tr.guess - r.finalScore);
  g.stats.rounds++;
  g.stats.error += err;
  g.stats.best = g.stats.best == null ? err : Math.min(g.stats.best, err);
  saveStats();
  render();
}

function nextDuel() {
  const list = pool();
  const a = pick(list);
  if (!a) return;
  // an interesting duel: two tracks the model places close to each other
  const near = list.filter((r) => r.id !== a.id && Math.abs(r.finalScore - a.finalScore) <= 15);
  const b = pick(near.length ? near : list, [a.id]);
  if (!b) return;
  g.duel = { a: a.id, b: b.id, answer: null };
  player.stop();
  render();
}

async function answerDuel(answer) {
  const d = g.duel;
  if (!d || d.answer) return;
  d.answer = answer;
  const A = state.records.get(d.a), B = state.records.get(d.b);
  const model = Math.abs(A.finalScore - B.finalScore) < 3 ? "tie" : A.finalScore > B.finalScore ? "a" : "b";
  g.stats.duels++;
  if (model === answer) g.stats.agree++;
  saveStats();
  if (g.saveDuels) await ctl.addComparison(d.a, d.b, answer);
  render();
}

// ------------------------------------------------------------------ rendering

function render() {
  const panel = $("panel-games");
  panel.querySelectorAll("[data-gm=mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === g.mode)));
  $("gm-playable").checked = g.onlyPlayable;
  $("gm-hide-title").checked = g.hideTitle;
  $("gm-save-duels").checked = g.saveDuels;
  $("gm-duel-opts").hidden = g.mode !== "compare";
  $("gm-trivia-opts").hidden = g.mode !== "trivia";
  renderPool();
  $("gm-playable").closest("label").hidden = g.mode === "hunt";
  $("gm-stage").innerHTML = g.mode === "trivia" ? triviaHtml() : g.mode === "hunt" ? huntHtml() : duelHtml();
  renderStats();
}

function renderPool() {
  const all = [...state.records.values()].filter((r) => isCounted(r) && r.auto);
  const playable = all.filter((r) => player.canPlay(r.id)).length;
  $("gm-pool").textContent = !all.length
    ? t("No analysed track yet: analyse files or scan a Spotify playlist first.")
    : t("{all} analysed tracks, {playable} playable here (local files of this session, or Spotify captures when logged in).", { all: all.length, playable });
}

function trackCard(r, { hide = false, label = "" } = {}) {
  const canPlay = player.canPlay(r.id);
  const src = r.source?.image;
  return `<div class="gm-track">
    ${label ? `<div class="gm-label">${label}</div>` : ""}
    <div class="gm-cover">${src && !hide ? `<img src="${escapeHtml(src)}" alt="" referrerpolicy="no-referrer">` : "<span>♪</span>"}</div>
    <div class="gm-name">${hide ? t("Mystery track") : escapeHtml(r.name)}</div>
    <div class="gm-play">
      ${canPlay ? `<button class="btn" data-gm="play" data-id="${escapeHtml(r.id)}">${player.isPlaying(r.id) ? "❚❚ " + t("Pause") : "▶ " + t("Play")}</button>
      <button class="btn" data-gm="play-peak" data-id="${escapeHtml(r.id)}" title="${escapeHtml(t("Play from the most intense passage"))}">⚡ ${t("Peak")}</button>` : `<span class="muted small">${t("Not playable here")}</span>`}
    </div>
  </div>`;
}

function scoreEditor(r) {
  const manual = r.manual?.score;
  return `<div class="gm-edit">
    <input type="number" id="gm-score-${escapeHtml(r.id)}" min="0" max="${SCORE_MAX}" step="1" value="${Math.round(r.finalScore)}" aria-label="${escapeHtml(t("New score"))}">
    <button class="btn small" data-gm="set-score" data-id="${escapeHtml(r.id)}">${t("Set score")}</button>
    ${manual != null ? `<button class="btn small" data-gm="clear-score" data-id="${escapeHtml(r.id)}">${t("Back to automatic")}</button>` : ""}
    <button class="btn small ghost" data-gm="detail" data-id="${escapeHtml(r.id)}">${t("Details")}</button>
  </div>`;
}

const scorePill = (v) => `<span class="gm-score" style="background:${intensityColor(v)}">${Math.round(v)}</span>`;

function triviaHtml() {
  const tr = g.trivia;
  if (!tr || !state.records.has(tr.id)) {
    return `<div class="gm-intro"><p>${t("A track plays from its most intense passage, its score hidden. Guess its intensity from 0 to 100 (or beyond, up to {max}, if it is off the charts), then compare with the model. If you disagree, keep your guess as the track's score.", { max: SCORE_MAX })}</p>
      <button class="btn primary" data-gm="start-trivia" ${pool().length ? "" : "disabled"}>${t("Start playing")}</button></div>`;
  }
  const r = state.records.get(tr.id);
  const body = !tr.revealed
    ? `<div class="gm-guess">
        <div class="gm-guess-value"><b id="gm-guess-out" style="color:${intensityColor(tr.guess)}">${tr.guess}</b><span id="gm-guess-stage">${escapeHtml(t(stageFor(tr.guess).label))}</span></div>
        <input type="range" id="gm-guess" min="0" max="${SCORE_MAX}" step="1" value="${tr.guess}" aria-label="${escapeHtml(t("Your guess"))}">
        <div class="gm-scale"><span style="left:0">0 · ${t("Ambient")}</span><span style="left:${(50 / SCORE_MAX) * 100}%">50</span><span style="left:${(100 / SCORE_MAX) * 100}%">100</span><span style="right:0">${SCORE_MAX}</span></div>
        <button class="btn primary" data-gm="reveal">${t("Reveal")} <kbd>↵</kbd></button>
      </div>`
    : revealHtml(r, tr);
  return `<div class="gm-round">${trackCard(r, { hide: g.hideTitle && !tr.revealed })}${body}</div>`;
}

function revealHtml(r, tr) {
  const diff = tr.guess - r.finalScore;
  const err = Math.abs(diff);
  const verdict = err <= 5 ? t("Spot on!") : err <= 12 ? t("Close.") : diff > 0 ? t("You hear it more intense than the model.") : t("You hear it calmer than the model.");
  return `<div class="gm-reveal">
    <div class="gm-versus"><div><span class="muted small">${t("You")}</span>${scorePill(tr.guess)}</div><div><span class="muted small">${t("Model")}</span>${scorePill(r.finalScore)}</div></div>
    <p class="gm-verdict">${verdict} <span class="muted">(${diff > 0 ? "+" : ""}${Math.round(diff)})</span></p>
    ${err > 5 ? `<button class="btn" data-gm="keep-guess">${t("Keep my guess ({n}) as its score", { n: tr.guess })}</button>` : ""}
    ${scoreEditor(r)}
    <button class="btn primary" data-gm="start-trivia">${t("Next track")} →</button>
  </div>`;
}

function duelHtml() {
  const d = g.duel;
  if (!d || !state.records.has(d.a) || !state.records.has(d.b)) {
    return `<div class="gm-intro"><p>${t("Two tracks the model places close to each other. Which one feels more intense? Answer with the buttons or the arrow keys (← A, → B, ↓ equal). Your answers are saved as duels, used to refine the weights (Settings), and you can fix either score.")}</p>
      <button class="btn primary" data-gm="start-duel" ${pool().length >= 2 ? "" : "disabled"}>${t("Start playing")}</button></div>`;
  }
  const A = state.records.get(d.a), B = state.records.get(d.b);
  const answered = !!d.answer;
  const model = Math.abs(A.finalScore - B.finalScore) < 3 ? "tie" : A.finalScore > B.finalScore ? "a" : "b";
  const sym = { a: ">", b: "<", tie: "=" };
  return `<div class="gm-duel">
    <div class="gm-duel-side">${trackCard(A, { label: "A" })}${answered ? `<div class="gm-duel-score">${scorePill(A.finalScore)}</div>${scoreEditor(A)}` : ""}</div>
    <div class="gm-duel-mid">
      ${answered
        ? `<div class="gm-duel-result"><div><span class="muted small">${t("You")}</span><b>A ${sym[d.answer]} B</b></div><div><span class="muted small">${t("Model")}</span><b>A ${sym[model]} B</b></div>
            <p>${model === d.answer ? t("The model agrees.") : t("The model disagrees: adjust a score if you are sure.")}</p></div>
           <button class="btn primary" data-gm="start-duel">${t("Next duel")} →</button>`
        : `<button class="btn gm-answer" data-gm="answer" data-answer="a" title="←">A &gt; B</button>
           <button class="btn gm-answer" data-gm="answer" data-answer="tie" title="↓">A = B</button>
           <button class="btn gm-answer" data-gm="answer" data-answer="b" title="→">A &lt; B</button>`}
    </div>
    <div class="gm-duel-side">${trackCard(B, { label: "B" })}${answered ? `<div class="gm-duel-score">${scorePill(B.finalScore)}</div>${scoreEditor(B)}` : ""}</div>
  </div>`;
}

function renderPlayButtons() {
  $("panel-games").querySelectorAll("[data-gm=play]").forEach((b) => {
    b.textContent = player.isPlaying(b.dataset.id) ? "❚❚ " + t("Pause") : "▶ " + t("Play");
  });
}

function renderStats() {
  const s = g.stats;
  const parts = [];
  if (s.rounds) parts.push(tn(s.rounds, "{n} guess", "{n} guesses") + ` · ${t("average error {n}", { n: Math.round(s.error / s.rounds) })} · ${t("best {n}", { n: Math.round(s.best) })}`);
  if (s.hunts) parts.push(tn(s.hunts, "{n} hunt", "{n} hunts") + ` · ${t("average gap {n}", { n: Math.round(s.huntError / s.hunts) })} · ${tn(s.bullseyes, "{n} bullseye", "{n} bullseyes")}`);
  if (s.duels) parts.push(tn(s.duels, "{n} duel", "{n} duels") + ` · ${t("model agrees {n} %", { n: Math.round((s.agree / s.duels) * 100) })}`);
  $("gm-stats").innerHTML = parts.length ? `${parts.map(escapeHtml).join("<br>")} <button class="linklike small" data-gm="reset-stats">${t("reset")}</button>` : "";
}

// ------------------------------------------------------------------ hunt

/** Library record already standing for a Spotify track (captured, or a matching file). */
function inLibrary(track) {
  const cap = state.records.get(ctl.capturedId(track));
  if (cap && !g.hunt?.tries.some((x) => x.track.id === track.id)) return cap;
  const files = [...state.records.values()].filter((r) => r.source?.kind !== "spotify" && r.source?.kind !== "test");
  const m = matchPlaylist([track], files, {}).get(track.id);
  return m ? state.records.get(m.recordId) : null;
}

function nextHunt() {
  if (g.hunt && !g.hunt.done && g.hunt.tries.length) finishHunt(false);
  g.hunt = { target: huntTarget(), query: g.hunt?.query ?? "", results: [], tries: [], busy: null, done: false };
  player.stop();
  render();
  $("gm-hunt-q")?.focus();
}

async function search(q) {
  const h = g.hunt;
  if (!h || !q.trim()) return;
  if (!auth.isLoggedIn()) throw new Error(t("Log in to Spotify first (Spotify tab)."));
  h.query = q;
  h.results = await api.searchTracks(q.trim(), 10);
  if (!h.results.length) toast(t("No track found."));
  render();
}

async function huntAnalyse(trackId) {
  const h = g.hunt;
  const track = h?.results.find((x) => x.id === trackId);
  if (!track || h.busy || h.done) return;
  if (inLibrary(track)) return toast(t("This track is already in your library: find another one."), "error");
  h.busy = track.id;
  render();
  const live = $("tab-live");
  live?.click(); // watch the needle while it is analysed
  try {
    const [rec] = await analyseTracks([track]);
    if (rec?.finalScore == null) throw new Error(t("The analysis did not finish."));
    h.tries.push({ track, score: rec.finalScore, recordId: rec.id });
  } finally {
    h.busy = null;
    if (!$("panel-live").hidden) $("tab-games").click();
    else render();
  }
}

function finishHunt(show = true) {
  const h = g.hunt;
  if (!h || h.done) return;
  h.done = true;
  const best = bestTry(h.target, h.tries);
  if (best) {
    const err = Math.abs(best.score - h.target);
    g.stats.hunts++;
    g.stats.huntError += err;
    if (err <= 2) g.stats.bullseyes++;
    saveStats();
  }
  if (show) render();
}

function huntHtml() {
  const h = g.hunt;
  if (!h) {
    return `<div class="gm-intro"><p>${t("The app draws a score. Find a track on Spotify, outside your library, that gets it: search, pick a candidate, and it is analysed live with the Live tab's capture and settings. Several tries per score are allowed, the closest one counts.")}</p>
      <button class="btn primary" data-gm="start-hunt">${t("Start playing")}</button></div>`;
  }
  const best = bestTry(h.target, h.tries);
  const logged = auth.isLoggedIn();
  const tries = h.tries.map((x) => {
    const d = x.score - h.target;
    return `<li><span class="gm-hunt-name">${escapeHtml(x.track.artists?.join(", ") ?? "")} · ${escapeHtml(x.track.name)}</span>${scorePill(x.score)}<span class="muted">${d > 0 ? "+" : ""}${Math.round(d)} · ${t("{n} pts", { n: huntPoints(h.target, x.score) })}</span>${x.recordId ? `<button class="btn small ghost" data-gm="detail" data-id="${escapeHtml(x.recordId)}">${t("Details")}</button>` : ""}</li>`;
  }).join("");
  const results = h.results.map((tk) => {
    const lib = inLibrary(tk);
    const tried = h.tries.some((x) => x.track.id === tk.id);
    return `<li>
      ${tk.image ? `<img src="${escapeHtml(tk.image)}" alt="" referrerpolicy="no-referrer">` : "<span class=\"gm-hunt-noimg\">♪</span>"}
      <span class="gm-hunt-name"><b>${escapeHtml(tk.name)}</b><span class="muted small">${escapeHtml(tk.artists?.join(", ") ?? "")}${tk.durationMs ? ` · ${Math.floor(tk.durationMs / 60000)}:${String(Math.floor((tk.durationMs / 1000) % 60)).padStart(2, "0")}` : ""}</span></span>
      ${tried ? `<span class="muted small">${t("tried")}</span>`
        : lib ? `<span class="muted small" title="${escapeHtml(lib.name)}">${t("in your library")}</span>`
        : `<button class="btn small" data-gm="hunt-analyse" data-id="${escapeHtml(tk.id)}" ${h.busy || h.done ? "disabled" : ""}>${h.busy === tk.id ? t("Analysing…") : t("Analyse")}</button>`}
    </li>`;
  }).join("");
  const verdict = best && (() => {
    const err = Math.abs(best.score - h.target);
    return err <= 2 ? t("Bullseye!") : err <= 5 ? t("Spot on!") : err <= 12 ? t("Close.") : best.score > h.target ? t("Too intense: look for something calmer.") : t("Too calm: look for something more intense.");
  })();
  return `<div class="gm-hunt">
    <div class="gm-hunt-target"><span class="muted small">${t("Target")}</span>${scorePill(h.target)}<span class="gm-hunt-stage">${escapeHtml(t(stageFor(h.target).label))}</span></div>
    ${best ? `<p class="gm-verdict">${verdict} <span class="muted">${t("Best: {n}", { n: Math.round(best.score) })} · ${t("{n} pts", { n: huntPoints(h.target, best.score) })}</span></p>` : ""}
    ${tries ? `<ul class="gm-hunt-tries">${tries}</ul>` : ""}
    ${h.done ? "" : `<form id="gm-hunt-search" class="gm-hunt-search">
      <input type="search" id="gm-hunt-q" value="${escapeHtml(h.query)}" placeholder="${escapeHtml(t("Search Spotify: title, artist…"))}" aria-label="${escapeHtml(t("Search Spotify"))}" ${logged ? "" : "disabled"}>
      <button class="btn" type="submit" ${logged ? "" : "disabled"}>${t("Search")}</button>
    </form>
    ${logged ? "" : `<p class="muted small">${t("Log in to Spotify first (Spotify tab).")}</p>`}
    ${results ? `<ul class="gm-hunt-results">${results}</ul>` : ""}`}
    <div class="gm-play">
      ${h.tries.length && !h.done ? `<button class="btn" data-gm="hunt-done">${t("Keep my best try")}</button>` : ""}
      <button class="btn primary" data-gm="start-hunt" ${h.busy ? "disabled" : ""}>${t("New score")} →</button>
    </div>
  </div>`;
}
