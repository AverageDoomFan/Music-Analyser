// "Games" tab, on a dark arena with the Live tab's speed dial.
// Daily: one Spotify track a day (date-seeded, the same for everyone), analysed
//   live while you guess its score; keep it in the library or let it go.
// Trivia: a library track plays with its score hidden, guess it on the dial,
//   then keep your guess as the track's score if you disagree with the model.
// Compare: two tracks, which one hits harder (> < =)? Answers are recorded as
//   duels (they refine the weights) and scores can be fixed on the spot.
// Hunt: the app draws a score, find a Spotify track outside the library that
//   gets it (analysed live, needle shown right here).

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
import { captureSupport } from "../live/capture.js";
import { analyseTracks, liveScanState } from "./live.js";
import { huntTarget, huntPoints, bestTry } from "../games/hunt.js";
import { dateKey, shiftDay, dailyQuery, pickDaily, dailyPoints, verdictOf, dailyStreak, bestStreak, scanProgress, shareLine } from "../games/daily.js";
import { dialValueAt } from "../games/dial.js";
import { intensityColor, drawGauge, gaugeState, stepGauge } from "./live-draw.js";
import { toast } from "./toast.js";

const $ = (id) => document.getElementById(id);
const STATS_KEY = "mea.games.stats";
const MODE_KEY = "mea.games.mode";
const DAILY_KEY = "mea.games.daily";
const MODES = ["daily", "trivia", "compare", "hunt"];
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false };

const EMPTY_STATS = {
  rounds: 0, error: 0, best: null, points: 0, streak: 0, bestStreak: 0,
  duels: 0, agree: 0, agreeStreak: 0,
  hunts: 0, huntError: 0, bullseyes: 0,
};

const g = {
  mode: loadMode(),
  onlyPlayable: true,
  hideTitle: false,
  saveDuels: true,
  trivia: null,   // { id, guess, revealed, points }
  duel: null,     // { a, b, answer }
  hunt: null,     // { target, query, results, tries: [{ track, score, recordId, capturedAt, had, kept }], busy }
  daily: null,    // { key, phase, track, guess, locked, score, recordId, capturedAt, had, error }
  recent: [],     // ids shown lately (avoid repeats)
  stats: loadStats(),
  dial: { key: "", gauge: gaugeState(), drag: false },
  typed: "", typedAt: 0,    // digits typed to set a guess
  shownAt: 0,               // when the current reveal was rendered (count-up)
};

function loadMode() {
  try { const m = localStorage.getItem(MODE_KEY); return MODES.includes(m) ? m : "daily"; } catch { return "daily"; }
}
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
function loadDaily() {
  try {
    const d = JSON.parse(localStorage.getItem(DAILY_KEY) || "{}");
    return { tracks: d.tracks ?? {}, results: d.results ?? {} };
  } catch {
    return { tracks: {}, results: {} };
  }
}
function saveDaily(d) {
  // tracks drawn more than a week ago are not needed any more
  const old = shiftDay(dateKey(), -7);
  for (const k of Object.keys(d.tracks)) if (k < old) delete d.tracks[k];
  try { localStorage.setItem(DAILY_KEY, JSON.stringify(d)); } catch { /* ignore */ }
}

export function initGames() {
  const panel = $("panel-games");
  panel.addEventListener("click", (e) => onClick(e).catch((err) => toast(err.message, "error")));
  panel.addEventListener("input", (e) => {
    if (e.target.id === "gm-guess") setGuess(Number(e.target.value), { fromSlider: true });
  });
  panel.addEventListener("change", (e) => {
    if (e.target.id === "gm-playable") { g.onlyPlayable = e.target.checked; render(); }
    if (e.target.id === "gm-hide-title") { g.hideTitle = e.target.checked; render(); }
    if (e.target.id === "gm-save-duels") g.saveDuels = e.target.checked;
  });
  panel.addEventListener("submit", (e) => {
    if (e.target.id !== "gm-hunt-search") return;
    e.preventDefault();
    search($("gm-hunt-q").value).catch((err) => toast(err.message, "error"));
  });
  // the dial is a knob: press and drag the needle
  panel.addEventListener("pointerdown", (e) => {
    const cv = e.target.closest?.("#gm-dial");
    if (!cv || !guessing()) return;
    e.preventDefault();
    cv.setPointerCapture?.(e.pointerId);
    g.dial.drag = true;
    cv.focus({ preventScroll: true });
    dialAt(cv, e);
  });
  panel.addEventListener("pointermove", (e) => {
    if (g.dial.drag && e.target.closest?.("#gm-dial")) dialAt(e.target, e);
  });
  const up = () => { g.dial.drag = false; };
  panel.addEventListener("pointerup", up);
  panel.addEventListener("pointercancel", up);
  document.addEventListener("keydown", onKey);
  player.onChange(() => { if (!$("panel-games").hidden) renderPlayButtons(); });
  subscribe(() => { if (!$("panel-games").hidden) renderPool(); });
  requestAnimationFrame(loop);
}

export function showGames() {
  if (g.mode === "daily") ensureDaily();
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
    case "mode": setMode(b.dataset.mode); break;
    case "start-trivia": nextTrivia(); break;
    case "start-duel": nextDuel(); break;
    case "play": await player.toggle(id); break;
    case "play-peak": await player.playAt(id, peakTime(state.records.get(id))); break;
    case "nudge": setGuess(currentGuess() + Number(b.dataset.by)); break;
    case "reveal": reveal(); break;
    case "keep-guess":
      await ctl.setManual(g.trivia.id, g.trivia.guess);
      toast(t("Score set to {n}.", { n: g.trivia.guess }));
      render();
      break;
    case "set-score": {
      const input = $(`gm-score-${id}`);
      const v = Number(input?.value);
      if (!Number.isFinite(v) || v < 0) return toast(t("The score must be 0 or more."), "error");
      await ctl.setManual(id, v);
      toast(t("Score set to {n}.", { n: Math.round(v) }));
      render();
      break;
    }
    case "clear-score": await ctl.setManual(id, null); render(); break;
    case "answer": await answerDuel(b.dataset.answer); break;
    case "start-hunt": await nextHunt(); break;
    case "hunt-analyse": await huntAnalyse(id); break;
    case "hunt-done": finishHunt(); break;
    case "hunt-keep": await decideTry(id, true); break;
    case "hunt-discard": await decideTry(id, false); break;
    case "stop-scan": $("lv-stop")?.click(); break;
    case "daily-start": await startDaily(); break;
    case "daily-lock": lockDaily(); break;
    case "daily-unlock": if (g.daily && g.daily.phase !== "done") { g.daily.locked = false; render(); } break;
    case "daily-keep": await decideDaily(true); break;
    case "daily-discard": await decideDaily(false); break;
    case "daily-share": await shareDaily(); break;
    case "goto": $(b.dataset.tab)?.click(); break;
    case "relogin": await auth.beginLogin(); break;
    case "detail": document.dispatchEvent(new CustomEvent("open-detail", { detail: id })); break;
    case "reset-stats":
      g.stats = { ...EMPTY_STATS };
      saveStats();
      render();
      break;
  }
}

function setMode(mode) {
  if (!MODES.includes(mode) || mode === g.mode) return;
  g.mode = mode;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
  if (!(mode === "daily" && liveScanState().status?.running)) player.stop();
  if (mode === "daily") ensureDaily();
  render();
}

// ------------------------------------------------------------------ keyboard

function onKey(e) {
  if ($("panel-games").hidden || e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
  const el = e.target;
  if (el.closest?.("textarea,select,[contenteditable],input:not([type=range]):not([type=checkbox])")) return;
  // Enter / Space on a focused button of the games keeps its native click
  if ((e.key === "Enter" || e.key === " ") && el.closest?.("#panel-games :is(button,a,summary)")) return;
  const slider = el.id === "gm-guess";
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const letters = { d: "daily", g: "trivia", c: "compare", h: "hunt" };
  if (letters[key]) { e.preventDefault(); setMode(letters[key]); return; }

  if (guessing()) {
    if (/^[0-9]$/.test(key)) {
      e.preventDefault();
      const now = performance.now();
      g.typed = now - g.typedAt > 1300 ? key : g.typed + key;
      g.typedAt = now;
      if (Number(g.typed) > SCORE_MAX) g.typed = key;
      setGuess(Number(g.typed));
      return;
    }
    if (!slider) {
      const step = e.shiftKey ? 5 : 1;
      const by = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: 10, PageDown: -10 }[e.key];
      if (by) { e.preventDefault(); setGuess(currentGuess() + by); return; }
    }
  }
  const next = key === "Enter" || key === "n";
  switch (g.mode) {
    case "trivia": {
      const tr = g.trivia;
      if (key === " " && tr) { e.preventDefault(); player.toggle(tr.id).catch(() => {}); }
      else if (key === "p" && tr) { e.preventDefault(); player.playAt(tr.id, peakTime(state.records.get(tr.id))).catch(() => {}); }
      else if (key === "Enter" && tr && !tr.revealed) { e.preventDefault(); reveal(); }
      else if (next && (!tr || tr.revealed) && pool().length) { e.preventDefault(); nextTrivia(); }
      break;
    }
    case "compare": {
      const d = g.duel;
      if (d && !d.answer) {
        const map = { ArrowLeft: "a", ArrowRight: "b", ArrowDown: "tie", "<": "b", ">": "a", "=": "tie" };
        if (map[e.key]) { e.preventDefault(); answerDuel(map[e.key]).catch(() => {}); }
      } else if (next && pool().length >= 2) { e.preventDefault(); nextDuel(); }
      break;
    }
    case "hunt":
      if (key === "/" && $("gm-hunt-q")) { e.preventDefault(); $("gm-hunt-q").focus(); }
      else if (key === "n" && !g.hunt?.busy) { e.preventDefault(); nextHunt().catch(() => {}); }
      break;
    case "daily": {
      const d = g.daily;
      if (key === "Enter" && d?.phase === "idle" && d.track) { e.preventDefault(); startDaily().catch((err) => toast(err.message, "error")); }
      else if (key === "Enter" && guessing()) { e.preventDefault(); lockDaily(); }
      break;
    }
  }
}

// ------------------------------------------------------------------ guess dial

/** True while a guess can be changed (trivia round, daily track). */
function guessing() {
  if (g.mode === "trivia") return !!g.trivia && !g.trivia.revealed;
  if (g.mode === "daily") return !!g.daily && ["analysing", "ready"].includes(g.daily.phase) && !g.daily.locked;
  return false;
}
const currentGuess = () => (g.mode === "daily" ? g.daily?.guess : g.trivia?.guess) ?? 50;

function setGuess(v, { fromSlider = false } = {}) {
  if (!guessing() || !Number.isFinite(v)) return;
  const x = Math.max(0, Math.min(SCORE_MAX, Math.round(v)));
  if (g.mode === "daily") g.daily.guess = x;
  else g.trivia.guess = x;
  const s = $("gm-guess");
  if (s && !fromSlider) s.value = x;
  const dial = $("gm-dial");
  dial?.setAttribute("aria-valuenow", String(x));
  dial?.setAttribute("aria-valuetext", `${x} · ${stageFor(x).label}`);
}

function dialAt(cv, e) {
  const r = cv.getBoundingClientRect();
  const v = dialValueAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height, SCORE_MAX);
  if (v != null) setGuess(v);
}

/** What the dial shows now, or null when there is no dial on screen. */
function dialSpec() {
  if (g.mode === "trivia" && g.trivia && state.records.has(g.trivia.id)) {
    const tr = g.trivia;
    if (!tr.revealed) return { key: `tr-${tr.id}`, target: tr.guess, snap: true, caption: t("your guess") };
    const s = state.records.get(tr.id).finalScore;
    return { key: `trr-${tr.id}`, from: tr.guess, target: s, marker: tr.guess, caption: t("your guess {n}", { n: tr.guess }) };
  }
  if (g.mode === "daily" && g.daily) {
    const d = g.daily;
    if (d.phase === "done" && d.result) {
      return { key: `dyr-${d.key}`, from: d.result.guess, target: d.result.score, marker: d.result.guess, caption: t("your guess {n}", { n: d.result.guess }) };
    }
    if (["analysing", "ready"].includes(d.phase)) {
      return { key: `dy-${d.key}`, target: d.guess, snap: true, caption: d.locked ? t("locked in") : t("your guess") };
    }
    return { key: "dy-idle", target: null, caption: t("today's mystery") };
  }
  const last = g.mode === "hunt" && !g.hunt?.busy && g.hunt?.tries.find((x) => x.track.id === g.hunt.last);
  if (last) {
    return { key: `huntr-${last.track.id}`, from: g.hunt.target, target: last.score, marker: g.hunt.target, caption: t("target {n}", { n: g.hunt.target }) };
  }
  if (g.mode === "hunt" && g.hunt?.busy) {
    const { status, level } = liveScanState();
    const cur = status?.current ?? null;
    const recording = !!cur?.plan?.some((s) => s.state === "recording") && !status?.paused;
    const score = cur?.final?.score ?? cur?.live?.scoring?.score ?? null;
    return {
      key: `hunt-${g.hunt.busy}`, target: cur?.final?.score ?? cur?.live?.current?.intensity ?? null, marker: g.hunt.target,
      active: recording, level: recording ? Math.min(1, level) : 0,
      caption: score != null ? `${cur?.final ? t("final score") : t("provisional score")} ${Math.round(score)}` : t("target {n}", { n: g.hunt.target }),
    };
  }
  return null;
}

function loop(now) {
  requestAnimationFrame(loop);
  if ($("panel-games").hidden || document.hidden) return;
  const cv = $("gm-dial");
  const spec = cv && cv.clientWidth > 60 ? dialSpec() : null; // hidden (small screens): nothing to draw
  if (cv && spec) {
    const st = g.dial;
    if (spec.key !== st.key) {
      st.key = spec.key;
      st.gauge = gaugeState();
      // a reveal swings the needle from your guess to the real score
      if (spec.from != null) { st.gauge.pos = st.gauge.readout = spec.from; }
    }
    stepGauge(st.gauge, spec.target, { now, level: spec.level ?? 0, reduced: reducedMotion.matches });
    if (spec.snap && spec.target != null) st.gauge.readout = spec.target;
    const shown = st.gauge.readout;
    drawGauge(cv, {
      gauge: st.gauge,
      score: spec.marker ?? null,
      label: shown != null ? stageFor(shown).label : t("intensity"),
      caption: spec.caption ?? "",
      active: spec.active ?? guessing(),
      level: spec.level ?? 0,
      now,
    });
  }
  // count-up of the points after a reveal
  const pts = $("gm-points");
  if (pts) {
    const k = Math.max(0, Math.min(1, (now - g.shownAt - 650) / 700));
    const to = Number(pts.dataset.to);
    pts.textContent = `+${Math.round(to * (reducedMotion.matches ? 1 : 1 - (1 - k) ** 3))}`;
  }
  // live progress of a scan started from here
  const bar = $("gm-progress-bar");
  if (bar) {
    const { status, level } = liveScanState();
    const cur = status?.current ?? null;
    const p = scanProgress(cur);
    bar.style.width = `${Math.round(p * 100)}%`;
    const txt = $("gm-progress-text");
    if (txt) txt.textContent = status?.running ? `${status.paused ? t("Paused") : status.phase || t("Starting…")} · ${Math.round(p * 100)} %` : t("Starting…");
    const eq = $("gm-eq");
    if (eq) {
      const rec = !!cur?.plan?.some((s) => s.state === "recording") && !status?.paused;
      eq.classList.toggle("on", rec);
      eq.style.setProperty("--lvl", String(rec ? Math.min(1, 0.25 + level * 1.4) : 0.15));
    }
  }
  const cd = $("gm-countdown");
  if (cd) cd.textContent = untilMidnight();
}

function untilMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const s = Math.max(0, Math.floor((next - now) / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ trivia

function nextTrivia() {
  const r = pick(pool());
  if (!r) return;
  g.trivia = { id: r.id, guess: g.trivia?.guess ?? 50, revealed: false };
  g.typed = "";
  render();
  $("gm-dial")?.focus({ preventScroll: true });
  if (player.canPlay(r.id)) player.playAt(r.id, peakTime(r));
}

function reveal() {
  const tr = g.trivia;
  if (!tr || tr.revealed) return;
  tr.revealed = true;
  const r = state.records.get(tr.id);
  const err = Math.abs(tr.guess - r.finalScore);
  tr.points = dailyPoints(tr.guess, r.finalScore);
  const s = g.stats;
  s.rounds++;
  s.error += err;
  s.points += tr.points;
  s.best = s.best == null ? err : Math.min(s.best, err);
  s.streak = err <= 10 ? s.streak + 1 : 0;
  s.bestStreak = Math.max(s.bestStreak, s.streak);
  saveStats();
  g.shownAt = performance.now();
  render();
}

// ------------------------------------------------------------------ compare

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
  if (model === answer) { g.stats.agree++; g.stats.agreeStreak++; } else g.stats.agreeStreak = 0;
  saveStats();
  g.shownAt = performance.now();
  if (g.saveDuels) await ctl.addComparison(d.a, d.b, answer);
  render();
}

// ------------------------------------------------------------------ daily

/** Why the daily track cannot be analysed here, or null. */
function dailyBlocker() {
  if (!auth.isLoggedIn()) return { msg: t("Log in to Spotify first: the daily track comes from the whole Spotify catalogue."), action: "spotify" };
  if (!auth.hasScopes(auth.PLAYBACK_SCOPES)) return { msg: t("Log in to Spotify again to allow playback control."), action: "relogin" };
  const sup = captureSupport();
  if (!sup.system && !sup.device) return { msg: t("This browser cannot capture audio: use a recent Chrome, Edge or Firefox on a computer."), action: null };
  return null;
}

/** Sets up today's round (and lets go of older undecided tracks). */
function ensureDaily() {
  const key = dateKey();
  const store = loadDaily();
  if (!g.daily || g.daily.key !== key) {
    const result = store.results[key];
    g.daily = result
      ? { key, phase: "done", result, track: store.tracks[key] ?? null }
      : { key, phase: store.tracks[key] ? "idle" : "none", track: store.tracks[key] ?? null, guess: 50, locked: false };
    cleanupDaily(store, key).catch(() => {});
  }
  const d = g.daily;
  if (d.phase === "none" && auth.isLoggedIn() && !d.loading) drawDailyTrack().catch((err) => {
    d.phase = "error";
    d.error = err.message;
    render();
  });
}

/** Undecided tracks of past days leave the library (unless scanned again since). */
async function cleanupDaily(store, today) {
  let changed = false;
  for (const [k, r] of Object.entries(store.results)) {
    if (k === today || r.had || r.decision) continue;
    const rec = state.records.get(r.recordId);
    if (rec && rec.source?.capturedAt === r.capturedAt) await ctl.deleteTrack(rec.id);
    r.decision = "discarded";
    changed = true;
  }
  if (changed) saveDaily(store);
}

async function drawDailyTrack() {
  const d = g.daily;
  d.loading = true;
  render();
  try {
    let track = null;
    for (let attempt = 0; attempt < 5 && !track; attempt++) {
      const { q, offset } = dailyQuery(d.key, attempt);
      track = pickDaily(await api.searchTracks(q, 10, offset), d.key);
    }
    if (!track) throw new Error(t("No track found."));
    const store = loadDaily();
    store.tracks[d.key] = {
      id: track.id, uri: track.uri, name: track.name, artists: track.artists, artistIds: track.artistIds, album: track.album,
      durationMs: track.durationMs, isrc: track.isrc, url: track.url, image: track.image, imageLarge: track.imageLarge,
    };
    saveDaily(store);
    if (g.daily === d) { d.track = store.tracks[d.key]; d.phase = "idle"; }
  } finally {
    d.loading = false;
    if (g.mode === "daily") render();
  }
}

/** Last error of the scan, when it ended without a score. */
function scanError() {
  const s = liveScanState().status;
  return s?.error || s?.queue?.find((q) => q.message)?.message || null;
}

async function startDaily() {
  const d = g.daily;
  if (!d?.track || !["idle", "error"].includes(d.phase)) return;
  const block = dailyBlocker();
  if (block) { d.phase = "error"; d.error = block.msg; render(); return; }
  const prev = state.records.get(ctl.capturedId(d.track));
  d.had = prev?.finalScore != null;
  d.error = null;
  if (d.had) {
    // already in the library: the score is known, just guess
    Object.assign(d, { phase: "ready", score: prev.finalScore, recordId: prev.id, capturedAt: prev.source?.capturedAt ?? null });
    render();
    if (player.canPlay(prev.id)) player.playAt(prev.id, peakTime(prev)).catch(() => {});
    return;
  }
  d.phase = "analysing";
  render();
  $("gm-dial")?.focus({ preventScroll: true });
  try {
    const [rec] = await analyseTracks([d.track]);
    if (rec?.finalScore == null) throw new Error(scanError() || t("The analysis did not finish."));
    Object.assign(d, { phase: "ready", score: rec.finalScore, recordId: rec.id, capturedAt: rec.source?.capturedAt ?? null });
  } catch (err) {
    d.phase = "error";
    d.error = err.message;
  }
  if (g.daily !== d) return;
  if (d.phase === "ready" && d.locked) revealDaily();
  else render();
}

function lockDaily() {
  const d = g.daily;
  if (!d || !["analysing", "ready"].includes(d.phase)) return;
  d.locked = true;
  if (d.phase === "ready") revealDaily();
  else render();
}

function revealDaily() {
  const d = g.daily;
  const store = loadDaily();
  const points = dailyPoints(d.guess, d.score);
  d.result = {
    trackId: d.track.id, name: d.track.name, artists: d.track.artists, image: d.track.imageLarge ?? d.track.image, url: d.track.url,
    guess: d.guess, score: Math.round(d.score * 10) / 10, points,
    recordId: d.recordId, capturedAt: d.capturedAt, had: !!d.had, decision: d.had ? "kept" : null, at: Date.now(),
  };
  store.results[d.key] = d.result;
  saveDaily(store);
  d.phase = "done";
  g.shownAt = performance.now();
  render();
}

async function decideDaily(keep) {
  const d = g.daily;
  const r = d?.result;
  if (!r || r.decision) return;
  if (!keep) {
    const rec = state.records.get(r.recordId);
    if (rec && rec.source?.capturedAt === r.capturedAt) await ctl.deleteTrack(rec.id);
  }
  r.decision = keep ? "kept" : "discarded";
  const store = loadDaily();
  if (store.results[d.key]) store.results[d.key].decision = r.decision;
  saveDaily(store);
  toast(keep ? t("Kept in your library.") : t("Removed from your library."));
  render();
}

async function shareDaily() {
  const d = g.daily;
  if (!d?.result) return;
  const line = shareLine(d.key, d.result, dailyStreak(loadDaily().results, d.key));
  try {
    await navigator.clipboard.writeText(line);
    toast(t("Result copied: paste it anywhere."));
  } catch {
    prompt(t("Copy your result:"), line);
  }
}

// ------------------------------------------------------------------ rendering

function render() {
  const panel = $("panel-games");
  panel.querySelectorAll("[data-gm=mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === g.mode)));
  panel.dataset.mode = g.mode;
  $("gm-playable").checked = g.onlyPlayable;
  $("gm-hide-title").checked = g.hideTitle;
  $("gm-save-duels").checked = g.saveDuels;
  $("gm-duel-opts").hidden = g.mode !== "compare";
  $("gm-trivia-opts").hidden = g.mode !== "trivia";
  $("gm-playable").closest("label").hidden = g.mode === "hunt" || g.mode === "daily";
  renderPool();
  const html = { daily: dailyHtml, trivia: triviaHtml, compare: duelHtml, hunt: huntHtml }[g.mode]();
  $("gm-stage").innerHTML = html;
  renderBadges();
  renderStats();
  renderKeys();
}

function renderPool() {
  const el = $("gm-pool");
  if (g.mode === "daily" || g.mode === "hunt") { el.textContent = ""; return; }
  const all = [...state.records.values()].filter((r) => isCounted(r) && r.auto);
  const playable = all.filter((r) => player.canPlay(r.id)).length;
  el.textContent = !all.length
    ? t("No analysed track yet: analyse files or scan a Spotify playlist first.")
    : t("{all} analysed tracks, {playable} playable here (local files of this session, or Spotify captures when logged in).", { all: all.length, playable });
}

function renderBadges() {
  const results = loadDaily().results;
  const today = results[dateKey()];
  const streak = dailyStreak(results, dateKey());
  const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  set("gm-badge-daily", today ? `✓ ${t("{n} pts", { n: today.points })}${streak > 1 ? ` · 🔥${streak}` : ""}` : `<span class="gm-new">${t("New")}</span>${streak ? ` · 🔥${streak}` : ""}`);
  set("gm-badge-trivia", g.stats.rounds ? `🔥${g.stats.streak} · ${t("best {n}", { n: g.stats.bestStreak })}` : "");
  set("gm-badge-compare", g.stats.duels ? t("{n} %", { n: Math.round((g.stats.agree / g.stats.duels) * 100) }) : "");
  set("gm-badge-hunt", g.stats.hunts ? `🎯 ${g.stats.bullseyes}` : "");
}

function renderKeys() {
  const k = (keys, what) => `<span>${keys.map((x) => `<kbd>${x}</kbd>`).join("")} ${what}</span>`;
  const common = k(["D", "G", "C", "H"], t("switch game"));
  const per = {
    daily: [k(["0–9"], t("type a score")), k(["←", "→"], t("adjust")), k(["↵"], t("start, then lock in"))],
    trivia: [k(["0–9"], t("type a score")), k(["←", "→"], t("adjust")), k(["↵"], t("reveal, then next")), k(["Space"], t("play / pause")), k(["P"], t("peak"))],
    compare: [k(["←"], "A"), k(["→"], "B"), k(["↓"], t("equal")), k(["↵"], t("next duel"))],
    hunt: [k(["/"], t("search")), k(["N"], t("new score"))],
  }[g.mode];
  $("gm-keys").innerHTML = [...per, common].join("");
}

const trackImg = (src, alt = "") => (src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" referrerpolicy="no-referrer">` : "<span>♪</span>");

function trackCard(r, { hide = false, label = "" } = {}) {
  const canPlay = player.canPlay(r.id);
  const src = r.source?.image;
  return `<div class="gm-track">
    ${label ? `<div class="gm-label">${label}</div>` : ""}
    <div class="gm-cover">${!hide ? trackImg(src) : "<span>?</span>"}</div>
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
    <input type="number" id="gm-score-${escapeHtml(r.id)}" min="0" step="1" value="${Math.round(r.finalScore)}" aria-label="${escapeHtml(t("New score"))}">
    <button class="btn small" data-gm="set-score" data-id="${escapeHtml(r.id)}">${t("Set score")}</button>
    ${manual != null ? `<button class="btn small" data-gm="clear-score" data-id="${escapeHtml(r.id)}">${t("Back to automatic")}</button>` : ""}
    <button class="btn small ghost" data-gm="detail" data-id="${escapeHtml(r.id)}">${t("Details")}</button>
  </div>`;
}

const scorePill = (v) => `<span class="gm-score" style="background:${intensityColor(v)}">${Math.round(v)}</span>`;

/** The speed dial, with a slider and ± buttons when it takes a guess. */
function dialHtml({ input = false, value = 50 } = {}) {
  const canvas = `<canvas id="gm-dial" class="gm-dial" ${input
    ? `tabindex="0" role="slider" aria-valuemin="0" aria-valuemax="${SCORE_MAX}" aria-valuenow="${value}" aria-valuetext="${value} · ${escapeHtml(stageFor(value).label)}" aria-label="${escapeHtml(t("Your guess"))}"`
    : `aria-hidden="true"`}></canvas>`;
  if (!input) return `<div class="gm-dial-wrap">${canvas}</div>`;
  return `<div class="gm-dial-wrap is-input">${canvas}
    <div class="gm-slider">
      <button class="gm-nudge" data-gm="nudge" data-by="-5" aria-label="−5">−5</button>
      <button class="gm-nudge" data-gm="nudge" data-by="-1" aria-label="−1">−</button>
      <input type="range" id="gm-guess" min="0" max="${SCORE_MAX}" step="1" value="${value}" aria-label="${escapeHtml(t("Your guess"))}">
      <button class="gm-nudge" data-gm="nudge" data-by="1" aria-label="+1">+</button>
      <button class="gm-nudge" data-gm="nudge" data-by="5" aria-label="+5">+5</button>
    </div>
    <p class="gm-hint">${t("Drag the needle, type a number or use the arrow keys.")}</p>
  </div>`;
}

/** Verdict, points and a burst of confetti on a good guess. */
function resultHtml(guess, score, points, extra = "") {
  const v = verdictOf(guess, score);
  const diff = guess - score;
  const title = { bullseye: t("Bullseye!"), spot: t("Spot on!"), close: t("Close."), far: diff > 0 ? t("You hear it more intense than the model.") : t("You hear it calmer than the model.") }[v];
  const confetti = v === "bullseye" || v === "spot"
    ? `<div class="gm-confetti" aria-hidden="true">${Array.from({ length: v === "bullseye" ? 36 : 18 }, () => {
      const c = intensityColor(Math.random() * 110);
      return `<i style="--x:${(Math.random() * 2 - 1).toFixed(2)};--y:${(0.4 + Math.random()).toFixed(2)};--r:${Math.round(Math.random() * 720 - 360)}deg;--d:${(Math.random() * 0.25).toFixed(2)}s;background:${c}"></i>`;
    }).join("")}</div>` : "";
  return `<div class="gm-result v-${v}">
    ${confetti}
    <div class="gm-result-top"><b class="gm-result-title">${title}</b><span class="gm-points" id="gm-points" data-to="${points}">+0</span></div>
    <div class="gm-versus"><div><span class="gm-lbl">${t("You")}</span>${scorePill(guess)}</div><div class="gm-gap">${diff > 0 ? "+" : ""}${Math.round(diff)}</div><div><span class="gm-lbl">${t("Model")}</span>${scorePill(score)}</div></div>
    ${extra}
  </div>`;
}

function triviaHtml() {
  const tr = g.trivia;
  if (!tr || !state.records.has(tr.id)) {
    return `<div class="gm-intro"><h3>🎯 ${t("Guess the score")}</h3><p>${t("A track plays from its most intense passage, its score hidden. Guess its intensity from 0 to 100 (or beyond, up to {max}, if it is off the charts), then compare with the model. If you disagree, keep your guess as the track's score.", { max: SCORE_MAX })}</p>
      <button class="btn primary big" data-gm="start-trivia" ${pool().length ? "" : "disabled"}>${t("Start playing")} <kbd>↵</kbd></button></div>`;
  }
  const r = state.records.get(tr.id);
  const side = !tr.revealed
    ? `${dialHtml({ input: true, value: tr.guess })}
       <button class="btn primary big" data-gm="reveal">${t("Reveal")} <kbd>↵</kbd></button>`
    : `${dialHtml()}
       ${resultHtml(tr.guess, r.finalScore, tr.points ?? 0, `
         ${Math.abs(tr.guess - r.finalScore) > 5 ? `<button class="btn" data-gm="keep-guess">${t("Keep my guess ({n}) as its score", { n: tr.guess })}</button>` : ""}
         <details class="gm-more"><summary>${t("Fix the score")}</summary>${scoreEditor(r)}</details>`)}
       <button class="btn primary big" data-gm="start-trivia">${t("Next track")} → <kbd>↵</kbd></button>`;
  return `<div class="gm-round">${trackCard(r, { hide: g.hideTitle && !tr.revealed })}<div class="gm-side">${side}</div></div>`;
}

function duelHtml() {
  const d = g.duel;
  if (!d || !state.records.has(d.a) || !state.records.has(d.b)) {
    return `<div class="gm-intro"><h3>⚖ ${t("Which hits harder?")}</h3><p>${t("Two tracks the model places close to each other. Which one feels more intense? Answer with the buttons or the arrow keys (← A, → B, ↓ equal). Your answers are saved as duels, used to refine the weights (Settings), and you can fix either score.")}</p>
      <button class="btn primary big" data-gm="start-duel" ${pool().length >= 2 ? "" : "disabled"}>${t("Start playing")} <kbd>↵</kbd></button></div>`;
  }
  const A = state.records.get(d.a), B = state.records.get(d.b);
  const answered = !!d.answer;
  const model = Math.abs(A.finalScore - B.finalScore) < 3 ? "tie" : A.finalScore > B.finalScore ? "a" : "b";
  const sym = { a: ">", b: "<", tie: "=" };
  const agree = model === d.answer;
  return `<div class="gm-duel">
    <div class="gm-duel-side ${answered && model === "a" ? "win" : ""}">${trackCard(A, { label: "A" })}${answered ? `<div class="gm-duel-score">${scorePill(A.finalScore)}</div><details class="gm-more"><summary>${t("Fix the score")}</summary>${scoreEditor(A)}</details>` : ""}</div>
    <div class="gm-duel-mid">
      ${answered
        ? `<div class="gm-result ${agree ? "v-spot" : "v-far"}">
             <div class="gm-result-top"><b class="gm-result-title">${agree ? t("The model agrees.") : t("The model disagrees: adjust a score if you are sure.")}</b></div>
             <div class="gm-duel-result"><div><span class="gm-lbl">${t("You")}</span><b>A ${sym[d.answer]} B</b></div><div><span class="gm-lbl">${t("Model")}</span><b>A ${sym[model]} B</b></div></div>
           </div>
           <button class="btn primary big" data-gm="start-duel">${t("Next duel")} → <kbd>↵</kbd></button>`
        : `<button class="gm-answer" data-gm="answer" data-answer="a"><b>A &gt; B</b><kbd>←</kbd></button>
           <button class="gm-answer" data-gm="answer" data-answer="tie"><b>A = B</b><kbd>↓</kbd></button>
           <button class="gm-answer" data-gm="answer" data-answer="b"><b>A &lt; B</b><kbd>→</kbd></button>`}
    </div>
    <div class="gm-duel-side ${answered && model === "b" ? "win" : ""}">${trackCard(B, { label: "B" })}${answered ? `<div class="gm-duel-score">${scorePill(B.finalScore)}</div><details class="gm-more"><summary>${t("Fix the score")}</summary>${scoreEditor(B)}</details>` : ""}</div>
  </div>`;
}

function renderPlayButtons() {
  $("panel-games").querySelectorAll("[data-gm=play]").forEach((b) => {
    b.textContent = player.isPlaying(b.dataset.id) ? "❚❚ " + t("Pause") : "▶ " + t("Play");
  });
}

function renderStats() {
  const s = g.stats;
  const chip = (icon, value, label) => `<div class="gm-chip"><b>${icon ? `${icon} ` : ""}${value}</b><span>${escapeHtml(label)}</span></div>`;
  let chips = [];
  if (g.mode === "daily") {
    const results = loadDaily().results;
    const today = dateKey();
    const days = Array.from({ length: 7 }, (_, i) => shiftDay(today, i - 6));
    const week = days.map((k) => {
      const r = results[k];
      return `<i title="${k}${r ? ` · ${r.points}` : ""}" style="${r ? `--p:${(0.2 + 0.8 * r.points / 100).toFixed(2)}` : ""}" class="${[r ? "on" : "", k === today ? "today" : ""].join(" ").trim()}"></i>`;
    }).join("");
    const played = Object.values(results);
    chips = [
      chip("🔥", dailyStreak(results, today), t("day streak")),
      chip("", bestStreak(results), t("best streak")),
      chip("", played.length ? Math.round(played.reduce((a, r) => a + r.points, 0) / played.length) : "—", t("average points")),
      `<div class="gm-chip gm-week" aria-label="${escapeHtml(t("last 7 days"))}"><div>${week}</div><span>${t("last 7 days")}</span></div>`,
    ];
  } else if (g.mode === "trivia") {
    chips = [
      chip("🔥", s.streak, t("hot streak (within 10)")),
      chip("", s.bestStreak, t("best streak")),
      chip("", s.rounds ? Math.round(s.error / s.rounds) : "—", t("average error")),
      chip("", s.points, t("points")),
    ];
  } else if (g.mode === "compare") {
    chips = [
      chip("", s.duels, t("duels")),
      chip("", s.duels ? `${Math.round((s.agree / s.duels) * 100)} %` : "—", t("model agrees")),
      chip("🔥", s.agreeStreak, t("agreements in a row")),
    ];
  } else {
    chips = [
      chip("", s.hunts, t("hunts")),
      chip("", s.hunts ? Math.round(s.huntError / s.hunts) : "—", t("average gap")),
      chip("🎯", s.bullseyes, t("bullseyes")),
    ];
  }
  const any = s.rounds || s.duels || s.hunts;
  $("gm-stats").innerHTML = chips.join("") + (any && g.mode !== "daily" ? `<button class="linklike small gm-reset" data-gm="reset-stats">${t("reset")}</button>` : "");
}

// ------------------------------------------------------------------ daily view

function requirementsHtml() {
  const logged = auth.isLoggedIn();
  const scopes = logged && auth.hasScopes(auth.PLAYBACK_SCOPES);
  const item = (ok, text, btn = "") => `<li class="${ok === true ? "ok" : ok === false ? "no" : ""}"><span class="gm-req-ico">${ok === true ? "✓" : ok === false ? "✗" : "•"}</span><span>${text}</span>${btn}</li>`;
  return `<ul class="gm-reqs">
    ${item(logged, t("Logged in to Spotify"), logged ? "" : `<button class="btn small primary" data-gm="goto" data-tab="tab-spotify">${t("Spotify tab")}</button>`)}
    ${item(logged ? scopes : null, t("Playback control allowed (Spotify Premium)"), logged && !scopes ? `<button class="btn small" data-gm="relogin">${t("Log in again")}</button>` : "")}
    ${item(null, t("Spotify open on this computer (the app or open.spotify.com): the track plays there"))}
    ${item(null, t("Audio capture: when the browser asks, share your screen with “Also share system audio” (or pick the VB-Cable input in the Live tab's settings)"), `<button class="btn small" data-gm="goto" data-tab="tab-live">${t("Live settings")}</button>`)}
  </ul>`;
}

function dailyTrackHtml(tk, { big = false } = {}) {
  return `<div class="gm-track">
    <div class="gm-cover ${big ? "big" : ""}">${trackImg(tk?.imageLarge ?? tk?.image)}</div>
    <div class="gm-name">${tk ? escapeHtml(tk.name) : "…"}</div>
    <div class="muted small gm-artist">${escapeHtml(tk?.artists?.join(", ") ?? "")}</div>
  </div>`;
}

function dailyHtml() {
  const d = g.daily;
  const dateLabel = (() => {
    try { return new Date().toLocaleDateString(document.documentElement.lang || undefined, { weekday: "long", day: "numeric", month: "long" }); } catch { return d?.key ?? ""; }
  })();
  const head = `<div class="gm-daily-head"><span class="gm-kicker">📅 ${t("Daily track")} · ${escapeHtml(dateLabel)}</span></div>`;
  if (!d) return head;

  if (d.phase === "done" && d.result) {
    const r = d.result;
    const results = loadDaily().results;
    const streak = dailyStreak(results, d.key);
    const tk = d.track ?? { name: r.name, artists: r.artists, image: r.image };
    const keep = r.had ? `<p class="muted small">${t("This track was already in your library.")}</p>`
      : r.decision ? `<p class="muted small">${r.decision === "kept" ? t("Kept in your library.") : t("Removed from your library.")}</p>`
      : `<div class="gm-keep"><span>${t("Keep this track in your library?")}</span>
          <button class="btn small" data-gm="daily-keep">${t("Keep it")}</button>
          <button class="btn small ghost" data-gm="daily-discard">${t("Discard")}</button></div>`;
    return `${head}<div class="gm-round">${dailyTrackHtml(tk, { big: true })}<div class="gm-side">
      ${dialHtml()}
      ${resultHtml(r.guess, r.score, r.points, `
        ${streak ? `<p class="gm-streak">🔥 ${tn(streak, "{n} day in a row", "{n} days in a row")}</p>` : ""}
        ${keep}`)}
      <div class="gm-actions">
        <button class="btn primary" data-gm="daily-share">${t("Copy my result")}</button>
        ${r.recordId && state.records.has(r.recordId) ? `<button class="btn ghost" data-gm="detail" data-id="${escapeHtml(r.recordId)}">${t("Details")}</button>` : ""}
      </div>
      <p class="muted small">${t("Next track in")} <b id="gm-countdown">${untilMidnight()}</b> · ${t("meanwhile:")} <button class="linklike" data-gm="mode" data-mode="trivia">${t("Guess the score")}</button> · <button class="linklike" data-gm="mode" data-mode="hunt">${t("Find this score")}</button></p>
    </div></div>`;
  }

  if (d.phase === "none" || (d.phase === "idle" && !d.track)) {
    const logged = auth.isLoggedIn();
    return `${head}<div class="gm-round gm-round-intro"><div class="gm-intro">
      <h3>${t("One track a day, the same for everyone")}</h3>
      <p>${t("Every day the app draws a track from the whole Spotify catalogue. It plays on your Spotify and is analysed live while you guess its intensity: the needle drops once the analysis is done.")}</p>
      ${logged ? `<p class="gm-loading"><span class="gm-spinner"></span>${t("Drawing today's track…")}</p>` : ""}
      ${requirementsHtml()}
    </div>${dialHtml()}</div>`;
  }

  if (d.phase === "idle" || d.phase === "error") {
    const block = dailyBlocker();
    return `${head}<div class="gm-round">${dailyTrackHtml(d.track, { big: true })}<div class="gm-side gm-daily-start">
      <h3>${t("Today's track is ready")}</h3>
      <p>${t("Press play: the track starts on your Spotify and the analysis runs while you listen. Set your guess on the dial meanwhile, then lock it in.")}</p>
      ${d.phase === "error" ? `<div class="gm-error"><b>${t("The analysis could not run")}</b><p>${escapeHtml(d.error ?? "")}</p></div>` : ""}
      ${requirementsHtml()}
      <button class="btn primary big" data-gm="daily-start" ${block ? "disabled" : ""}>▶ ${d.phase === "error" ? t("Try again") : t("Play and guess")} <kbd>↵</kbd></button>
    </div></div>`;
  }

  // analysing / ready: guess on the dial while the scan runs
  const ready = d.phase === "ready";
  const status = ready
    ? `<div class="gm-progress done"><div class="gm-progress-line"><span>✓ ${t("Analysis done: lock in your guess to see the score.")}</span></div></div>`
    : `<div class="gm-progress">
        <div class="gm-progress-line"><span class="gm-eq" id="gm-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span id="gm-progress-text">${t("Starting…")}</span></div>
        <div class="progress"><div class="progress-bar" id="gm-progress-bar"></div></div>
      </div>`;
  const side = d.locked
    ? `${dialHtml()}
       <div class="gm-locked"><b>${t("Your guess: {n}", { n: d.guess })}</b><span>${t("The needle drops as soon as the analysis is done.")}</span></div>
       ${status}
       <div class="gm-actions"><button class="btn" data-gm="daily-unlock">${t("Change my guess")}</button>${ready ? "" : `<button class="btn ghost" data-gm="stop-scan">${t("Stop the analysis")}</button>`}</div>`
    : `${dialHtml({ input: true, value: d.guess })}
       ${status}
       <div class="gm-actions"><button class="btn primary big" data-gm="daily-lock">${t("Lock in my guess")} <kbd>↵</kbd></button>${ready ? "" : `<button class="btn ghost" data-gm="stop-scan">${t("Stop the analysis")}</button>`}</div>`;
  return `${head}<div class="gm-round">${dailyTrackHtml(d.track, { big: true })}<div class="gm-side">${side}</div></div>`;
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

async function nextHunt() {
  if (g.hunt?.busy) return;
  if (g.hunt && !g.hunt.done && g.hunt.tries.length) finishHunt(false);
  // tries nobody asked to keep leave the library
  for (const x of g.hunt?.tries ?? []) if (!x.had && x.kept == null) await decideTry(x.track.id, false, { quiet: true });
  g.hunt = { target: huntTarget(), query: g.hunt?.query ?? "", results: g.hunt?.results ?? [], tries: [], busy: null, done: false };
  player.stop();
  g.shownAt = performance.now();
  render();
  $("gm-hunt-q")?.focus();
}

async function decideTry(trackId, keep, { quiet = false } = {}) {
  const x = g.hunt?.tries.find((y) => y.track.id === trackId);
  if (!x || x.had || x.kept != null) return;
  if (!keep) {
    const rec = state.records.get(x.recordId);
    if (rec && rec.source?.capturedAt === x.capturedAt) await ctl.deleteTrack(rec.id);
  }
  x.kept = keep;
  if (!quiet) {
    toast(keep ? t("Kept in your library.") : t("Removed from your library."));
    render();
  }
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
  const had = state.records.has(ctl.capturedId(track));
  h.busy = track.id;
  render(); // the needle is shown right here
  try {
    const [rec] = await analyseTracks([track]);
    if (rec?.finalScore == null) throw new Error(scanError() || t("The analysis did not finish."));
    h.tries.push({ track, score: rec.finalScore, recordId: rec.id, capturedAt: rec.source?.capturedAt ?? null, had, kept: had ? true : null });
    h.last = track.id;
    g.shownAt = performance.now();
  } finally {
    h.busy = null;
    if (g.hunt === h) render();
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

const fmtDur = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, "0")}`;

function huntHtml() {
  const h = g.hunt;
  if (!h) {
    return `<div class="gm-intro"><h3>🔎 ${t("Find this score")}</h3><p>${t("The app draws a score. Find a track on Spotify, outside your library, that gets it: search, pick a candidate, and it is analysed live with the Live tab's capture and settings. Several tries per score are allowed, the closest one counts.")}</p>
      <button class="btn primary big" data-gm="start-hunt">${t("Start playing")}</button></div>`;
  }
  const best = bestTry(h.target, h.tries);
  const logged = auth.isLoggedIn();
  const busyTrack = h.busy ? h.results.find((x) => x.id === h.busy) : null;
  const tries = h.tries.map((x) => {
    const d = x.score - h.target;
    const decide = x.had ? "" : x.kept == null
      ? `<button class="btn small" data-gm="hunt-keep" data-id="${escapeHtml(x.track.id)}" title="${escapeHtml(t("Keep this track in your library"))}">${t("Keep")}</button><button class="btn small ghost" data-gm="hunt-discard" data-id="${escapeHtml(x.track.id)}" title="${escapeHtml(t("Remove it from your library"))}">✕</button>`
      : `<span class="muted small">${x.kept ? t("kept") : t("removed")}</span>`;
    return `<li class="${x === best ? "best" : ""}"><span class="gm-hunt-name">${escapeHtml(x.track.artists?.join(", ") ?? "")} · ${escapeHtml(x.track.name)}</span>${scorePill(x.score)}<span class="muted gm-hunt-gap">${d > 0 ? "+" : ""}${Math.round(d)} · ${t("{n} pts", { n: huntPoints(h.target, x.score) })}</span>${x.recordId && state.records.has(x.recordId) ? `<button class="btn small ghost" data-gm="detail" data-id="${escapeHtml(x.recordId)}">${t("Details")}</button>` : ""}${decide}</li>`;
  }).join("");
  const undecided = h.tries.some((x) => !x.had && x.kept == null);
  const results = h.results.map((tk) => {
    const lib = inLibrary(tk);
    const tried = h.tries.some((x) => x.track.id === tk.id);
    return `<li>
      ${tk.image ? `<img src="${escapeHtml(tk.image)}" alt="" referrerpolicy="no-referrer">` : "<span class=\"gm-hunt-noimg\">♪</span>"}
      <span class="gm-hunt-name"><b>${escapeHtml(tk.name)}</b><span class="muted small">${escapeHtml(tk.artists?.join(", ") ?? "")}${tk.durationMs ? ` · ${fmtDur(tk.durationMs)}` : ""}</span></span>
      ${tried ? `<span class="muted small">${t("tried")}</span>`
        : lib ? `<span class="muted small" title="${escapeHtml(lib.name)}">${t("in your library")}</span>`
        : `<button class="btn small" data-gm="hunt-analyse" data-id="${escapeHtml(tk.id)}" ${h.busy || h.done ? "disabled" : ""}>${h.busy === tk.id ? t("Analysing…") : t("Analyse")}</button>`}
    </li>`;
  }).join("");
  const verdict = best && (() => {
    const err = Math.abs(best.score - h.target);
    return err <= 2 ? t("Bullseye!") : err <= 5 ? t("Spot on!") : err <= 12 ? t("Close.") : best.score > h.target ? t("Too intense: look for something calmer.") : t("Too calm: look for something more intense.");
  })();
  const last = !h.busy && h.tries.find((x) => x.track.id === h.last);
  const lastHtml = last ? (() => {
    const d = last.score - h.target;
    const v = verdictOf(last.score, h.target);
    return `<div class="gm-hunt-live">
      ${dialHtml()}
      <div class="gm-hunt-live-info gm-result v-${v}">
        <span class="gm-kicker">${t("Last try")}</span>
        <b>${escapeHtml(last.track.name)}</b><span class="muted small">${escapeHtml(last.track.artists?.join(", ") ?? "")}</span>
        <div class="gm-result-top">${scorePill(last.score)}<span class="gm-gap">${d > 0 ? "+" : ""}${Math.round(d)}</span><span class="gm-points" id="gm-points" data-to="${huntPoints(h.target, last.score)}">+0</span></div>
      </div>
    </div>`;
  })() : "";
  const live = busyTrack ? `<div class="gm-hunt-live">
      ${dialHtml()}
      <div class="gm-hunt-live-info">
        <span class="gm-kicker">${t("Analysing live")}</span>
        <b>${escapeHtml(busyTrack.name)}</b><span class="muted small">${escapeHtml(busyTrack.artists?.join(", ") ?? "")}</span>
        <div class="gm-progress">
          <div class="gm-progress-line"><span class="gm-eq" id="gm-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span id="gm-progress-text">${t("Starting…")}</span></div>
          <div class="progress"><div class="progress-bar" id="gm-progress-bar"></div></div>
        </div>
        <p class="muted small">${t("The white mark is the target: watch the needle.")}</p>
        <div><button class="btn small ghost" data-gm="stop-scan">${t("Stop the analysis")}</button></div>
      </div>
    </div>` : "";
  return `<div class="gm-hunt">
    <div class="gm-hunt-target" style="--tc:${intensityColor(h.target)}"><span class="gm-kicker">${t("Target")}</span><b class="gm-hunt-num">${h.target}</b><span class="gm-hunt-stage">${escapeHtml(stageFor(h.target).label)}</span></div>
    ${best && !h.busy ? `<p class="gm-verdict">${verdict} <span class="muted">${t("Best: {n}", { n: Math.round(best.score) })} · ${t("{n} pts", { n: huntPoints(h.target, best.score) })}</span></p>` : ""}
    ${live}${lastHtml}
    ${tries ? `<ul class="gm-hunt-tries">${tries}</ul>` : ""}
    ${undecided ? `<p class="muted small">${t("Tracks analysed for the game leave your library when you move on, unless you keep them.")}</p>` : ""}
    ${h.done ? "" : `<form id="gm-hunt-search" class="gm-hunt-search">
      <input type="search" id="gm-hunt-q" value="${escapeHtml(h.query)}" placeholder="${escapeHtml(t("Search Spotify: title, artist…"))}" aria-label="${escapeHtml(t("Search Spotify"))}" ${logged ? "" : "disabled"}>
      <button class="btn" type="submit" ${logged ? "" : "disabled"}>${t("Search")}</button>
    </form>
    ${logged ? "" : `<p class="muted small">${t("Log in to Spotify first (Spotify tab).")}</p>`}
    ${results ? `<ul class="gm-hunt-results">${results}</ul>` : ""}`}
    <div class="gm-actions">
      ${h.tries.length && !h.done ? `<button class="btn" data-gm="hunt-done">${t("Keep my best try")}</button>` : ""}
      <button class="btn primary" data-gm="start-hunt" ${h.busy ? "disabled" : ""}>${t("New score")} → <kbd>N</kbd></button>
    </div>
  </div>`;
}
