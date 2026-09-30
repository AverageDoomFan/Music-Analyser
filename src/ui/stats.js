// "Stats" tab: my listening (the Live follow mode's log), my library's profile
// and the duel between friends (two diagnostic exports side by side).
// The numbers come from the pure modules in src/stats/; this file only draws.

import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { STAGES, DIMENSIONS, stageFor } from "../config.js";
import { t, tn, getLang } from "../i18n/index.js";
import { escapeHtml } from "../util/format.js";
import { intensityColor, DIM_COLORS } from "./live-draw.js";
import { toast } from "./toast.js";
import { genrePath, SEP } from "../scoring/genres.js";
import {
  heatmapBins, monthlySummary, listenMonths, listeningTotals, recentByDay, dayKey,
} from "../stats/listening.js";
import { libraryProfile, BPM_BINS } from "../stats/library.js";
import { parseDiagnostic, compactProfile, duelStats, pairDetails, DUEL_FEATURES } from "../stats/duel.js";
import { getListens, onListensChanged, getFriends, saveFriends } from "../stats/log-store.js";

const $ = (id) => document.getElementById(id);
const VIEW_KEY = "mea.stats.view";
const VIEWS = ["listening", "library", "duel"];

const ui = {
  view: loadView(),
  month: null,         // "YYYY-MM" shown in the monthly summary
  friendId: null,      // selected friend
  pairKey: null,       // selected common track (by name)
  sort: "gap",         // common tracks table order
  showAll: false,
  friendName: "",
};
let root = null;
let tip = null;
let visible = false;
let renderTimer = 0;
let mine = null;       // my own profile (cached until the library changes)
let mineStamp = "";

function loadView() {
  try { const v = localStorage.getItem(VIEW_KEY); return VIEWS.includes(v) ? v : "listening"; } catch { return "listening"; }
}

// ------------------------------------------------------------------ formatting

const locale = () => (getLang() === "fr" ? "fr-FR" : "en-GB");
const num = (x, d = 0) => (x == null || !Number.isFinite(x) ? "—" : x.toLocaleString(locale(), { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (x) => (x == null ? "—" : `${num(x * 100)} %`);
const esc = escapeHtml;

function fmtMinutes(min) {
  if (!(min > 0)) return t("0 min");
  if (min < 1) return t("< 1 min");
  if (min < 60) return t("{n} min", { n: Math.round(min) });
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m ? t("{h} h {m}", { h, m: String(m).padStart(2, "0") }) : t("{h} h", { h });
}

function fmtClock(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const monthLabel = (key) => {
  const [y, m] = key.split("-").map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString(locale(), { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const dayLabel = (key, style = "long") => {
  const d = new Date(`${key}T12:00:00`);
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 864e5);
  if (style === "relative" && key === today) return t("Today");
  if (style === "relative" && key === yesterday) return t("Yesterday");
  return d.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" });
};

const hourLabel = (h) => (getLang() === "fr" ? `${h} h` : `${String(h).padStart(2, "0")}:00`);

const weekdayNames = (style) => Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 7 + i).toLocaleDateString(locale(), { weekday: style }));

function pill(v, cls = "") {
  if (v == null) return `<span class="st-pill st-pill-none ${cls}">—</span>`;
  return `<span class="st-pill ${cls}" style="--c:${intensityColor(v)}">${Math.round(v)}</span>`;
}

const stageLabel = (v) => (v == null ? "" : stageFor(v).label);
const stageMid = (i) => ((STAGES[i].min + (STAGES[i + 1]?.min ?? 110)) / 2);

/** Top two levels of a record's genre ("Electronic › Hard dance"). */
function genreOf(r) {
  if (!r) return null;
  const label = ctl.genreInfo(r).label;
  return label ? genrePath(label).slice(0, 2).join(SEP) : null;
}

const tipAttr = (s) => `data-tip="${esc(s)}"`;

// ------------------------------------------------------------------ init

export function initStats() {
  root = $("stats-root");
  tip = Object.assign(document.createElement("div"), { className: "st-tip", hidden: true });
  document.body.append(tip);
  root.addEventListener("click", (e) => onClick(e).catch((err) => toast(err.message, "error")));
  root.addEventListener("change", (e) => {
    if (e.target.id === "st-month") { ui.month = e.target.value; render(); }
    if (e.target.id === "st-friend-file") { importFriend(e.target.files?.[0]); e.target.value = ""; }
  });
  root.addEventListener("input", (e) => { if (e.target.id === "st-friend-name") ui.friendName = e.target.value; });
  root.addEventListener("pointermove", onTip);
  root.addEventListener("pointerleave", () => { tip.hidden = true; });
  root.addEventListener("focusin", (e) => { if (e.target.closest("[data-tip]")) showTip(e.target.closest("[data-tip]")); });
  root.addEventListener("focusout", () => { tip.hidden = true; });
  // a friend's export can be dropped on the import card (not the audio import)
  root.addEventListener("dragover", (e) => {
    const zone = e.target.closest?.(".st-drop");
    if (!zone) return;
    e.preventDefault();
    zone.classList.add("over");
  });
  root.addEventListener("dragleave", (e) => e.target.closest?.(".st-drop")?.classList.remove("over"));
  root.addEventListener("drop", (e) => {
    const zone = e.target.closest?.(".st-drop");
    if (!zone) return;
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("over");
    document.getElementById("dropzone")?.classList.remove("dragover");
    importFriend(e.dataTransfer?.files?.[0]);
  });
  subscribe(() => { if (visible) scheduleRender(); });
  onListensChanged(() => { if (visible) scheduleRender(); });
  // hidden again when another tab is chosen
  document.querySelector('[role="tablist"]')?.addEventListener("click", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab && tab.id !== "tab-stats") visible = false;
  });
}

export function showStats() {
  visible = true;
  render();
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 350);
}

async function onClick(e) {
  const b = e.target.closest("[data-st]");
  if (!b) return;
  const a = b.dataset.st;
  if (a === "view") {
    ui.view = b.dataset.view;
    try { localStorage.setItem(VIEW_KEY, ui.view); } catch { /* ignore */ }
    return render();
  }
  if (a === "month-prev" || a === "month-next") {
    const months = listenMonths(await getListens());
    const i = months.indexOf(ui.month) + (a === "month-prev" ? 1 : -1);
    if (months[i]) { ui.month = months[i]; render(); }
    return;
  }
  if (a === "open") return document.dispatchEvent(new CustomEvent("open-detail", { detail: b.dataset.id }));
  if (a === "go-live") return $("tab-live")?.click();
  if (a === "go-library") return $("tab-library")?.click();
  if (a === "export") {
    const n = await ctl.exportDiagnostic({ full: true });
    return toast(n ? tn(n, "Profile exported ({n} track): send the file to your friend.", "Profile exported ({n} tracks): send the file to your friend.") : t("No analysed track."));
  }
  if (a === "pick-file") return $("st-friend-file")?.click();
  if (a === "friend") { ui.friendId = b.dataset.id; ui.pairKey = null; ui.showAll = false; return render(); }
  if (a === "friend-remove") {
    e.stopPropagation();
    const list = (await getFriends()).filter((f) => f.id !== b.dataset.id);
    await saveFriends(list);
    if (ui.friendId === b.dataset.id) ui.friendId = null;
    return render();
  }
  if (a === "pair") {
    ui.pairKey = b.dataset.key;
    await render();
    root.querySelector(".st-why")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  if (a === "sort") { ui.sort = b.dataset.sort; return render(); }
  if (a === "show-all") { ui.showAll = !ui.showAll; return render(); }
}

function onTip(e) {
  const el = e.target.closest?.("[data-tip]");
  if (!el) { tip.hidden = true; return; }
  showTip(el, e.clientX, e.clientY);
}

function showTip(el, x, y) {
  tip.innerHTML = esc(el.dataset.tip).replace(/\n/g, "<br>");
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const px = x ?? r.left + r.width / 2, py = y ?? r.top;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, px - w / 2));
  const top = py - h - 12 < 8 ? py + 18 : py - h - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

// ------------------------------------------------------------------ render

async function render() {
  if (!root) return;
  const view = ui.view;
  let body = "";
  try {
    if (view === "listening") body = await renderListening();
    else if (view === "library") body = renderLibrary();
    else body = await renderDuel();
  } catch (err) {
    console.error(err);
    body = `<div class="st-card st-empty"><p>${esc(err.message)}</p></div>`;
  }
  const tabs = [
    ["listening", t("My listening"), "M3 12a9 9 0 0 1 18 0v5a2 2 0 0 1-2 2h-1v-6h3M3 12v5a2 2 0 0 0 2 2h1v-6H3"],
    ["library", t("My library"), "M4 19V5m5 14V8m5 11V4m5 15v-8"],
    ["duel", t("Friend duel"), "M8 7a3 3 0 1 0 0 .01M16 7a3 3 0 1 0 0 .01M3 20c0-3 2.5-5 5-5s5 2 5 5M11 20c0-3 2.5-5 5-5s5 2 5 5"],
  ];
  const fresh = root.dataset.view !== view;
  root.dataset.view = view;
  root.innerHTML = `
    <div class="st-head">
      <div>
        <h2 class="st-title">${t("Stats")}</h2>
        <p class="st-sub">${t("How hard you listen, what your library sounds like, and how you compare with friends.")}</p>
      </div>
      <div class="st-seg" role="group" aria-label="${esc(t("Statistics view"))}">
        ${tabs.map(([k, label, d]) => `<button type="button" data-st="view" data-view="${k}" aria-pressed="${k === view}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg><span>${label}</span></button>`).join("")}
      </div>
    </div>
    <div class="st-body st-view-${view}${fresh ? " st-enter" : ""}">${body}</div>`;
}

// ------------------------------------------------------------------ my listening

async function renderListening() {
  const listens = (await getListens()).map((e) => ({ ...e, genre: genreOf(state.records.get(e.recordId)) }));
  if (!listens.length) return emptyListening();
  const months = listenMonths(listens);
  if (!months.includes(ui.month)) ui.month = months[0];
  const tot = listeningTotals(listens);
  const sum = monthlySummary(listens, ui.month);
  return `
    ${kpis([
      [t("Listening time"), fmtMinutes(tot.minutes), tn(tot.listens, "{n} listen", "{n} listens")],
      [t("Different tracks"), num(tot.uniqueTracks), tn(tot.activeDays, "on {n} day", "on {n} days")],
      [t("Average intensity"), tot.avg == null ? "—" : num(tot.avg), stageLabel(tot.avg), tot.avg],
      [t("Longest streak"), tn(tot.streak, "{n} day", "{n} days"), t("in a row with music")],
    ])}
    ${wrapped(sum, months)}
    <div class="st-grid-2">
      ${heatmapCard(listens)}
      ${timelineCard(listens)}
    </div>`;
}

function emptyListening() {
  return `
    <div class="st-card st-empty">
      <div class="st-empty-art" aria-hidden="true">${[18, 34, 52, 70, 88, 96, 76, 44, 26].map((v, i) => `<i style="--c:${intensityColor(v)};--h:${20 + (v / 110) * 70}%;--d:${i * 90}ms"></i>`).join("")}</div>
      <h3>${t("Your listening shows up here")}</h3>
      <p>${t("Turn on “Follow my Spotify listening” in the Live tab and play music in Spotify as usual. Every track you hear is logged: when, how long, how intense.")}</p>
      <p class="st-muted">${t("Only the follow mode counts as listening: scans and imported files do not.")}</p>
      <p><button class="btn primary" type="button" data-st="go-live">${t("Open the Live tab")}</button></p>
      <ul class="st-empty-list">
        <li><b>${t("Heatmap")}</b> ${t("when you listen, by day and hour, coloured by intensity")}</li>
        <li><b>${t("Monthly recap")}</b> ${t("minutes, most intense track and day, favourite genres, peak hour")}</li>
        <li><b>${t("Timeline")}</b> ${t("your latest listens, with their score")}</li>
      </ul>
    </div>`;
}

function kpis(list) {
  return `<div class="st-kpis">${list.map(([label, value, sub, heat]) => `
    <div class="st-kpi"${heat != null ? ` style="--c:${intensityColor(heat)}"` : ""}>
      <span class="st-kpi-label">${esc(label)}</span>
      <b class="st-kpi-value${heat != null ? " heat" : ""}">${esc(value)}</b>
      <span class="st-kpi-sub">${esc(sub ?? "")}</span>
    </div>`).join("")}</div>`;
}

function trend(cur, prev, unit = "%") {
  if (prev == null || cur == null || !(prev > 0)) return "";
  const d = unit === "%" ? (cur - prev) / prev : cur - prev;
  if (Math.abs(d) < (unit === "%" ? 0.005 : 0.5)) return `<span class="st-trend">${t("same as the month before")}</span>`;
  const txt = unit === "%" ? `${d > 0 ? "+" : "−"}${num(Math.abs(d) * 100)} %` : `${d > 0 ? "+" : "−"}${num(Math.abs(d))}`;
  return `<span class="st-trend ${d > 0 ? "up" : "down"}">${txt} ${t("vs the month before")}</span>`;
}

function wrapped(s, months) {
  const i = months.indexOf(s.month);
  const heat = s.avg ?? 40;
  const total = s.stages.reduce((a, b) => a + b, 0);
  const maxDay = Math.max(1, ...s.days.map((d) => d.minutes));
  const dayBars = s.days.map((d) => {
    const n = Number(d.day.slice(-2));
    const h = d.minutes > 0 ? Math.max(6, (d.minutes / maxDay) * 100) : 0;
    return `<i ${tipAttr(`${dayLabel(d.day)}\n${fmtMinutes(d.minutes)}${d.avg != null ? ` · ${t("intensity {n}", { n: Math.round(d.avg) })}` : ""}`)} style="--h:${h}%;--c:${d.avg != null ? intensityColor(d.avg) : "var(--st-empty)"}"><span>${n === 1 || n % 5 === 0 ? n : ""}</span></i>`;
  }).join("");
  const stageBar = total ? s.stages.map((sec, k) => sec > 0
    ? `<i style="flex:${sec};--c:${intensityColor(stageMid(k))}" ${tipAttr(`${STAGES[k].label}\n${fmtMinutes(sec / 60)} · ${pct(sec / total)}`)}></i>` : "").join("") : "";
  const topStages = s.stages.map((sec, k) => ({ sec, k })).filter((x) => x.sec > 0).sort((a, b) => b.sec - a.sec).slice(0, 3);
  return `
  <article class="st-card st-wrapped" style="--heat:${intensityColor(heat)};--heat-soft:${intensityColor(heat, 0.35)}">
    <header class="st-wr-head">
      <div>
        <span class="st-kicker">${t("Your month in music")}</span>
        <h3>${esc(monthLabel(s.month))}</h3>
      </div>
      <div class="st-month-nav">
        <button type="button" class="st-icon-btn" data-st="month-prev" ${i >= months.length - 1 ? "disabled" : ""} aria-label="${esc(t("Previous month"))}">‹</button>
        <select id="st-month" aria-label="${esc(t("Month"))}">${months.map((m) => `<option value="${m}"${m === s.month ? " selected" : ""}>${esc(monthLabel(m))}</option>`).join("")}</select>
        <button type="button" class="st-icon-btn" data-st="month-next" ${i <= 0 ? "disabled" : ""} aria-label="${esc(t("Next month"))}">›</button>
      </div>
    </header>
    ${s.listens ? `
    <div class="st-wr-hero">
      <div class="st-wr-stat main">
        <span>${t("Minutes listened")}</span>
        <b>${num(Math.round(s.minutes))}</b>
        ${trend(s.minutes, s.previous?.minutes)}
      </div>
      <div class="st-wr-stat">
        <span>${t("Average intensity")}</span>
        <b class="heat" style="--c:${intensityColor(s.avg)}">${s.avg == null ? "—" : num(s.avg)}</b>
        <em>${esc(stageLabel(s.avg))}</em>
        ${trend(s.avg, s.previous?.avg, "pts")}
      </div>
      <div class="st-wr-stat">
        <span>${t("Tracks")}</span>
        <b>${num(s.uniqueTracks)}</b>
        <em>${tn(s.listens, "{n} listen", "{n} listens")} · ${tn(s.activeDays, "{n} day", "{n} days")}</em>
      </div>
      <div class="st-wr-stat">
        <span>${t("Off the charts")}</span>
        <b>${pct(s.over100)}</b>
        <em>${t("of your time above 100")}</em>
      </div>
    </div>
    <div class="st-wr-facts">
      ${fact("⚡", t("Most intense track"), s.hardest ? `${s.hardest.recordId && state.records.has(s.hardest.recordId) ? `<button type="button" class="st-link" data-st="open" data-id="${esc(s.hardest.recordId)}">${esc(s.hardest.name)}</button>` : esc(s.hardest.name)}` : "—", s.hardest ? pill(s.hardest.score) : "")}
      ${fact("🔥", t("Most intense day"), s.hardestDay ? esc(dayLabel(s.hardestDay.day)) : "—", s.hardestDay ? `${pill(s.hardestDay.avg)}<small>${fmtMinutes(s.hardestDay.minutes)}</small>` : "")}
      ${fact("🕙", t("Peak hour"), s.peakHour ? esc(t("{from} – {to}", { from: hourLabel(s.peakHour.hour), to: hourLabel((s.peakHour.hour + 1) % 24) })) : "—", s.peakHour ? `<small>${fmtMinutes(s.peakHour.minutes)}</small>` : "")}
      ${fact("🔁", t("On repeat"), s.topTracks[0] ? esc(s.topTracks[0].name) : "—", s.topTracks[0] ? `<small>${tn(s.topTracks[0].plays, "{n} play", "{n} plays")}</small>` : "")}
    </div>
    <div class="st-wr-cols">
      <section>
        <h4>${t("Intensity mix")}</h4>
        <div class="st-stackbar" role="img" aria-label="${esc(t("Listening time by intensity level"))}">${stageBar}</div>
        <ul class="st-legend">${topStages.map((x) => `<li><i style="--c:${intensityColor(stageMid(x.k))}"></i>${esc(STAGES[x.k].label)} <b>${pct(x.sec / total)}</b></li>`).join("")}</ul>
      </section>
      <section>
        <h4>${t("Favourite genres")}</h4>
        ${s.genres.length ? `<ol class="st-genres">${s.genres.map((g, k) => `<li><span class="rank">${k + 1}</span><span class="nm">${esc(g.genre)}</span><small>${fmtMinutes(g.minutes)}</small></li>`).join("")}</ol>`
          : `<p class="st-muted small">${t("No genre known yet for these tracks (MusicBrainz fills them in over time).")}</p>`}
      </section>
    </div>
    <section class="st-days">
      <h4>${t("Day by day")}</h4>
      <div class="st-daybars" role="img" aria-label="${esc(t("Minutes listened per day"))}">${dayBars}</div>
    </section>` : `<p class="st-muted">${t("Nothing heard this month.")}</p>`}
  </article>`;
}

function fact(icon, label, value, extra) {
  return `<div class="st-fact"><span class="ic" aria-hidden="true">${icon}</span><div><span class="lbl">${esc(label)}</span><div class="val">${value}</div></div><div class="ex">${extra}</div></div>`;
}

function heatmapCard(listens) {
  const h = heatmapBins(listens);
  const days = weekdayNames("short");
  const longDays = weekdayNames("long");
  const maxHour = Math.max(1, ...h.byHour);
  const cells = h.cells.map((row, d) => `
    <span class="st-hm-day">${esc(days[d])}</span>
    ${row.map((c, hr) => {
      if (!c.seconds) return `<i class="st-hm-cell none" ${tipAttr(`${longDays[d]} · ${hourLabel(hr)}\n${t("nothing heard")}`)}></i>`;
      const a = 0.28 + 0.72 * Math.sqrt(c.seconds / h.max);
      const col = c.avg != null ? intensityColor(c.avg, a) : `color-mix(in srgb, var(--muted) ${Math.round(a * 100)}%, transparent)`;
      return `<i class="st-hm-cell" style="--c:${col}" ${tipAttr(`${longDays[d]} · ${hourLabel(hr)}\n${fmtMinutes(c.seconds / 60)}${c.avg != null ? ` · ${t("intensity {n}", { n: Math.round(c.avg) })} (${stageLabel(c.avg)})` : ""}`)}></i>`;
    }).join("")}`).join("");
  const hourBars = h.byHour.map((s, hr) => `<i style="--h:${(s / maxHour) * 100}%" ${tipAttr(`${hourLabel(hr)}\n${fmtMinutes(s / 60)}`)}></i>`).join("");
  const ramp = [0, 20, 38, 55, 70, 84, 94, 100, 120].map((v) => `${intensityColor(v)} ${(v / 120) * 100}%`).join(",");
  return `
  <article class="st-card st-heatmap">
    <header class="st-card-head"><h3>${t("When you listen")}</h3><span class="st-muted small">${t("all time · local time")}</span></header>
    <div class="st-hm">
      <span></span><div class="st-hm-hours" aria-hidden="true">${hourBars}</div>
      ${cells}
      <span></span><div class="st-hm-axis" aria-hidden="true">${[0, 6, 12, 18].map((x) => `<span style="--x:${x}">${hourLabel(x)}</span>`).join("")}</div>
    </div>
    <div class="st-hm-legend">
      <span>${t("Calm")}</span><i style="background:linear-gradient(90deg,${ramp})"></i><span>${t("Off the charts")}</span>
      <span class="st-muted small">${t("brighter = more time")}</span>
    </div>
  </article>`;
}

function timelineCard(listens) {
  const groups = recentByDay(listens, 30);
  const time = (ts) => new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  return `
  <article class="st-card st-timeline">
    <header class="st-card-head"><h3>${t("Recent listens")}</h3><span class="st-muted small">${tn(listens.length, "{n} in the log", "{n} in the log")}</span></header>
    <div class="st-tl-scroll">
    ${groups.map((g) => `
      <h4 class="st-tl-day">${esc(dayLabel(g.day, "relative"))}</h4>
      <ol class="st-tl">${g.items.map((e) => {
        const rec = state.records.get(e.recordId);
        const name = rec?.name ?? e.name;
        const score = rec && rec.finalScore != null ? rec.finalScore : e.score;
        const cov = Math.round((e.coverage ?? 0) * 100);
        return `<li style="--c:${score != null ? intensityColor(score) : "var(--border)"}">
          <time>${time(e.at)}</time>
          <div class="st-tl-main">
            ${rec ? `<button type="button" class="st-link nm" data-st="open" data-id="${esc(e.recordId)}">${esc(name)}</button>` : `<span class="nm">${esc(name)}</span>`}
            <span class="meta">${t("{t} heard", { t: fmtClock(e.heardSeconds) })} <span class="st-cov" ${tipAttr(t("{n} % of the track heard", { n: cov }))}><i style="width:${cov}%"></i></span> ${cov} %${e.draft || rec?.draft ? ` <span class="draft-tag">${t("draft")}</span>` : ""}</span>
          </div>
          ${pill(score)}
        </li>`;
      }).join("")}</ol>`).join("")}
    </div>
  </article>`;
}

// ------------------------------------------------------------------ my library

function renderLibrary() {
  const p = libraryProfile(state.records.values(), { genreOf });
  if (!p.count) {
    return `<div class="st-card st-empty">
      <div class="st-empty-art" aria-hidden="true">${[30, 50, 64, 80, 96, 70, 40].map((v, i) => `<i style="--c:${intensityColor(v)};--h:${20 + (v / 110) * 70}%;--d:${i * 90}ms"></i>`).join("")}</div>
      <h3>${t("Your library profile shows up here")}</h3>
      <p>${t("Import files or analyse a Spotify playlist: intensity levels, tempos, keys, genres and sound profile of your library appear here. Test-bench tracks and drafts are left out.")}</p>
      <p><button class="btn primary" type="button" data-st="go-library">${t("Open the Library")}</button></p>
    </div>`;
  }
  const maxStage = Math.max(1, ...p.stages);
  const stageRows = STAGES.map((s, i) => ({ s, i, n: p.stages[i] })).reverse().map(({ s, i, n }) => `
    <li ${tipAttr(`${s.label} (${s.min}+)\n${tn(n, "{n} track", "{n} tracks")} · ${pct(n / p.count)}`)}>
      <span class="lbl">${esc(s.label)}</span>
      <span class="bar"><i style="width:${(n / maxStage) * 100}%;--c:${intensityColor(stageMid(i))}"></i></span>
      <span class="n">${n || ""}</span>
    </li>`).join("");
  const maxBpm = Math.max(1, ...p.bpm);
  const bpmLabels = ["<60", ...BPM_BINS.slice(0, -1).map((b) => String(b)), "250+"];
  const bpmBars = p.bpm.map((n, i) => `<div class="st-col" ${tipAttr(`${i === 0 ? "< 60" : i === p.bpm.length - 1 ? "≥ 250" : `${BPM_BINS[i - 1]}–${BPM_BINS[i]}`} BPM\n${tn(n, "{n} track", "{n} tracks")}`)}>
      <span class="v">${n || ""}</span><i style="--h:${(n / maxBpm) * 100}%"></i><span class="x">${bpmLabels[i]}</span></div>`).join("");
  const modeTotal = p.modes.major + p.modes.minor;
  const maxGenre = Math.max(1, ...p.genres.map((g) => g.n));
  const list = (items) => `<ol class="st-rank">${items.map((x, k) => `<li><span class="rank">${k + 1}</span><button type="button" class="st-link nm" data-st="open" data-id="${esc(x.id)}">${esc(x.name)}</button>${pill(x.score)}</li>`).join("")}</ol>`;
  return `
    ${kpis([
      [t("Counted tracks"), num(p.count), t("drafts and test tracks left out")],
      [t("Average intensity"), num(p.avg), stageLabel(p.avg), p.avg],
      [t("Median"), num(p.median), stageLabel(p.median), p.median],
      [t("Off the charts"), pct(p.over100), t("tracks above 100")],
    ])}
    <div class="st-grid-2">
      <article class="st-card">
        <header class="st-card-head"><h3>${t("Intensity levels")}</h3><span class="st-muted small">${t("tracks per level")}</span></header>
        <ol class="st-hbars">${stageRows}</ol>
      </article>
      <article class="st-card">
        <header class="st-card-head"><h3>${t("Sound profile")}</h3><span class="st-muted small">${t("average sub-scores")}</span></header>
        ${p.subscores ? radar(p.subscores) : ""}
      </article>
    </div>
    <div class="st-grid-3">
      <article class="st-card">
        <header class="st-card-head"><h3>${t("Tempo")}</h3><span class="st-muted small">${tn(p.bpmKnown, "{n} track with a BPM", "{n} tracks with a BPM")}</span></header>
        <div class="st-cols">${bpmBars}</div>
      </article>
      <article class="st-card">
        <header class="st-card-head"><h3>${t("Keys")}</h3><span class="st-muted small">${t("major / minor")}</span></header>
        ${modeTotal ? `
          <div class="st-split">
            <i class="maj" style="flex:${p.modes.major || 0.0001}"><b>${pct(p.modes.major / modeTotal)}</b> ${t("major")}</i>
            <i class="min" style="flex:${p.modes.minor || 0.0001}"><b>${pct(p.modes.minor / modeTotal)}</b> ${t("minor")}</i>
          </div>
          <div class="st-keys">${p.keys.map((k) => `<span class="st-key"><b>${esc(k.key)}</b> ${k.n}</span>`).join("")}</div>`
          : `<p class="st-muted small">${t("No key detected yet.")}</p>`}
      </article>
      <article class="st-card">
        <header class="st-card-head"><h3>${t("Genres")}</h3><span class="st-muted small">${tn(p.genreKnown, "{n} track with a genre", "{n} tracks with a genre")}</span></header>
        ${p.genres.length ? `<ol class="st-hbars st-genre-bars">${p.genres.map((g) => `<li><span class="lbl" title="${esc(g.genre)}">${esc(g.genre)}</span><span class="bar"><i style="width:${(g.n / maxGenre) * 100}%"></i></span><span class="n">${g.n}</span></li>`).join("")}</ol>`
          : `<p class="st-muted small">${t("No genre known yet (MusicBrainz fills them in over time).")}</p>`}
      </article>
    </div>
    <div class="st-grid-2">
      <article class="st-card">
        <header class="st-card-head"><h3>${t("Hardest hitters")}</h3></header>
        ${list(p.top)}
      </article>
      <article class="st-card">
        <header class="st-card-head"><h3>${t("Calmest tracks")}</h3></header>
        ${list(p.bottom)}
      </article>
    </div>`;
}

/** SVG radar of the sub-scores (0..100), optionally a second series. */
function radar(a, b = null) {
  const n = DIMENSIONS.length, R = 92, cx = 150, cy = 128;
  const pt = (i, v) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [cx + Math.cos(ang) * R * (v / 100), cy + Math.sin(ang) * R * (v / 100)];
  };
  const ring = (v) => DIMENSIONS.map((_, i) => pt(i, v).map((x) => x.toFixed(1)).join(",")).join(" ");
  const poly = (vals) => DIMENSIONS.map((d, i) => pt(i, Math.max(0, Math.min(100, vals[d.key] ?? 0))).map((x) => x.toFixed(1)).join(",")).join(" ");
  const labels = DIMENSIONS.map((d, i) => {
    const [x, y] = pt(i, 122);
    const anchor = Math.abs(x - cx) < 6 ? "middle" : x > cx ? "start" : "end";
    return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}">${esc(d.label)}</text>`;
  }).join("");
  const dots = DIMENSIONS.map((d, i) => {
    const [x, y] = pt(i, Math.max(0, Math.min(100, a[d.key] ?? 0)));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" style="--c:${DIM_COLORS[d.key]}" ${tipAttr(`${d.label}: ${Math.round(a[d.key] ?? 0)}${b ? ` / ${Math.round(b[d.key] ?? 0)}` : ""}`)}/>`;
  }).join("");
  const bars = DIMENSIONS.map((d) => `<li ${tipAttr(d.hint)}><span class="lbl"><i style="--c:${DIM_COLORS[d.key]}"></i>${esc(d.label)}</span><span class="bar"><i style="width:${Math.max(0, Math.min(100, a[d.key] ?? 0))}%;--c:${DIM_COLORS[d.key]}"></i></span><span class="n">${Math.round(a[d.key] ?? 0)}</span></li>`).join("");
  return `<div class="st-radar-wrap">
    <svg class="st-radar" viewBox="-34 0 368 256" role="img" aria-label="${esc(t("Average sub-scores"))}">
      ${[25, 50, 75, 100].map((v) => `<polygon class="ring" points="${ring(v)}"/>`).join("")}
      ${DIMENSIONS.map((_, i) => { const [x, y] = pt(i, 100); return `<line class="spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join("")}
      ${b ? `<polygon class="area b" points="${poly(b)}"/>` : ""}
      <polygon class="area" points="${poly(a)}"/>
      ${dots}
      ${labels}
    </svg>
    <ol class="st-hbars st-sub-bars">${bars}</ol>
  </div>`;
}

// ------------------------------------------------------------------ friend duel

async function myProfile() {
  let stamp = 0;
  for (const r of state.records.values()) stamp = Math.max(stamp, r.updatedAt ?? 0);
  const key = `${state.records.size}:${stamp}`;
  if (!mine || key !== mineStamp) {
    mine = parseDiagnostic(await ctl.diagnosticData({ full: false }));
    mineStamp = key;
  }
  return mine;
}

async function importFriend(file) {
  if (!file) return;
  try {
    const profile = parseDiagnostic(await file.text());
    if (!profile.tracks.length) throw new Error(t("This profile has no analysed track."));
    const list = await getFriends();
    const name = ui.friendName.trim() || t("Friend {n}", { n: list.length + 1 });
    const friend = { id: `f${Date.now().toString(36)}`, name: name.slice(0, 40), importedAt: Date.now(), fileName: file.name, ...compactProfile(profile) };
    await saveFriends([...list, friend]);
    ui.friendId = friend.id;
    ui.pairKey = null;
    ui.friendName = "";
    toast(tn(profile.tracks.length, "{name}'s profile imported ({n} track).", "{name}'s profile imported ({n} tracks).", { name }));
    render();
  } catch (err) {
    toast(err.message, "error", 7000);
  }
}

async function renderDuel() {
  const friends = await getFriends();
  if (!friends.some((f) => f.id === ui.friendId)) ui.friendId = friends.at(-1)?.id ?? null;
  const friend = friends.find((f) => f.id === ui.friendId);
  const setup = `
    <div class="st-grid-2 st-duel-setup">
      <article class="st-card st-share">
        <span class="st-step">1</span>
        <div>
          <h3>${t("Send your profile")}</h3>
          <p class="st-muted small">${t("Exports your scores, sub-scores and measures (no audio) as a JSON file. Send it to a friend who uses the app.")}</p>
          <button class="btn primary" type="button" data-st="export">⤓ ${t("Export my profile")}</button>
        </div>
      </article>
      <article class="st-card st-drop" tabindex="0">
        <span class="st-step">2</span>
        <div>
          <h3>${t("Import a friend's profile")}</h3>
          <p class="st-muted small">${t("Drop their export here (music-analyser-diagnostic….json) or choose the file.")}</p>
          <div class="st-drop-row">
            <input id="st-friend-name" type="text" maxlength="40" placeholder="${esc(t("Friend's name"))}" aria-label="${esc(t("Friend's name"))}" value="${esc(ui.friendName)}">
            <button class="btn" type="button" data-st="pick-file">${t("Choose the file…")}</button>
            <input id="st-friend-file" type="file" accept=".json,application/json" hidden>
          </div>
        </div>
      </article>
    </div>
    ${friends.length ? `<div class="st-friends" role="group" aria-label="${esc(t("Friends"))}">${friends.map((f) => `
      <span class="st-friend${f.id === ui.friendId ? " on" : ""}">
        <button type="button" data-st="friend" data-id="${f.id}" aria-pressed="${f.id === ui.friendId}"><span class="av">${esc(initial(f.name))}</span>${esc(f.name)} <small>${f.tracks.length}</small></button>
        <button type="button" class="x" data-st="friend-remove" data-id="${f.id}" aria-label="${esc(t("Remove {name}", { name: f.name }))}">×</button>
      </span>`).join("")}</div>` : ""}`;
  if (!friend) {
    return `${setup}
      <div class="st-card st-empty st-duel-empty">
        <div class="st-vs-art" aria-hidden="true"><span class="you">${esc(t("You"))}</span><b>VS</b><span class="them">?</span></div>
        <h3>${t("Who listens harder?")}</h3>
        <p>${t("Swap profiles with a friend: the app finds the tracks you both have, compares your scores and shows why the same song gets a different intensity on each side (capture, loudness, corrections…).")}</p>
      </div>`;
  }
  const me = await myProfile();
  const d = duelStats(me, friend);
  return `${setup}${duelBody(d, friend, me)}`;
}

const initial = (name) => (String(name).trim()[0] ?? "?").toUpperCase();

function duelBody(d, friend, me) {
  const fn = esc(friend.name);
  const verdict = d.harder == null ? ""
    : d.harder === "tie" ? t("Dead heat: you listen just as hard.")
    : d.harder === "b" ? t("{name} listens harder: +{n} on average.", { name: friend.name, n: num(d.sides.b.avg - d.sides.a.avg, 1) })
    : t("You listen harder: +{n} on average.", { n: num(d.sides.a.avg - d.sides.b.avg, 1) });
  const agreeTxt = { same: t("Almost the same ears"), close: t("Close scores"), different: t("Noticeably different"), apart: t("Worlds apart") }[d.agreement] ?? t("Not enough common tracks");
  const side = (who, s, label, cls) => `
    <div class="st-side ${cls}">
      <span class="av">${esc(initial(label))}</span>
      <span class="who">${esc(label)}</span>
      <b class="avg" style="--c:${intensityColor(s.avg)}">${s.avg == null ? "—" : num(s.avg, 1)}</b>
      <span class="st-muted small">${t("average intensity")} · ${esc(stageLabel(s.avg))}</span>
      <div class="st-side-meta">
        <span><b>${num(s.count)}</b> ${t("tracks")}</span>
        <span><b>${pct(s.over100)}</b> ${t("above 100")}</span>
        <span><b>${num(s.median)}</b> ${t("median")}</span>
      </div>
    </div>`;
  const maxAvg = Math.max(1, d.sides.a.avg ?? 0, d.sides.b.avg ?? 0, 100);
  return `
    ${d.sameAlgorithm ? "" : `<div class="st-note">⚠ ${t("{name}'s profile comes from another version of the scoring ({b}, you: {a}): part of the gaps can come from that.", { name: friend.name, a: me.algorithm ?? "?", b: friend.algorithm ?? "?" })}</div>`}
    <article class="st-card st-versus">
      ${side("a", d.sides.a, t("You"), "you")}
      <div class="st-vs-mid">
        <span class="vs">VS</span>
        <div class="st-vs-bars">
          <i class="you" style="height:${((d.sides.a.avg ?? 0) / maxAvg) * 100}%"></i>
          <i class="them" style="height:${((d.sides.b.avg ?? 0) / maxAvg) * 100}%"></i>
        </div>
      </div>
      ${side("b", d.sides.b, friend.name, "them")}
      <p class="st-verdict">${esc(verdict)}</p>
    </article>
    <div class="st-grid-2">
      <article class="st-card st-agree">
        <header class="st-card-head"><h3>${t("Agreement on common tracks")}</h3><span class="st-muted small">${tn(d.n, "{n} common track", "{n} common tracks")}</span></header>
        <div class="st-agree-kpis">
          <div><span>${t("Common tracks")}</span><b>${num(d.n)}</b></div>
          <div ${tipAttr(t("1 = you rank these tracks in exactly the same order; 0 = no link."))}><span>${t("Correlation")}</span><b>${d.r == null ? "—" : num(d.r, 2)}</b></div>
          <div ${tipAttr(t("Average distance between your two scores on the same track."))}><span>${t("Mean gap")}</span><b>${d.meanAbsGap == null ? "—" : `±${num(d.meanAbsGap, 1)}`}</b></div>
        </div>
        <p class="st-agree-verdict">${esc(agreeTxt)}${d.meanGap != null && Math.abs(d.meanGap) >= 1 ? ` · ${esc(d.meanGap > 0 ? t("{name} scores {n} higher on average", { name: friend.name, n: num(d.meanGap, 1) }) : t("you score {n} higher on average", { n: num(-d.meanGap, 1) }))}` : ""}</p>
        ${d.n ? scatter(d, friend.name) : `<p class="st-muted small">${t("No track in common yet: listen to the same songs, or compare playlists you share.")}</p>`}
      </article>
      ${d.n ? commonTable(d, fn) : `<article class="st-card"><header class="st-card-head"><h3>${t("Common tracks")}</h3></header><p class="st-muted small">${t("Tracks are matched by Spotify id, else by artist and title.")}</p></article>`}
    </div>
    ${d.n ? pairPanel(d, friend) : ""}
    <div class="st-grid-2">
      ${onlyList(t("Only you have"), d.onlyA, "you")}
      ${onlyList(t("Only {name} has", { name: friend.name }), d.onlyB, "them")}
    </div>`;
}

function scatter(d, friendName) {
  const W = 320, H = 260, m = { l: 34, r: 10, t: 10, b: 30 };
  const top = Math.max(100, ...d.common.flatMap((c) => [c.a, c.b])) + 2;
  const x = (v) => m.l + (v / top) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / top) * (H - m.t - m.b);
  const ticks = [0, 25, 50, 75, 100].filter((v) => v <= top);
  const band = 10;
  const bandPts = [[0, band], [top - band, top], [top, top], [top, top - band], [band, 0], [0, 0]]
    .map(([a, b]) => `${x(a).toFixed(1)},${y(b).toFixed(1)}`).join(" ");
  const dots = [...d.common].sort((a, b) => (a.key === ui.pairKey) - (b.key === ui.pairKey)).map((c) => `
    <circle class="dot${c.key === ui.pairKey ? " sel" : ""}${Math.abs(c.gap) >= 15 ? " far" : ""}" cx="${x(c.a).toFixed(1)}" cy="${y(c.b).toFixed(1)}" r="${c.key === ui.pairKey ? 6.5 : 4.5}"
      data-st="pair" data-key="${esc(c.key)}" ${tipAttr(`${c.name}\n${t("You")} ${Math.round(c.a)} · ${friendName} ${Math.round(c.b)} (${c.gap > 0 ? "+" : ""}${Math.round(c.gap)})`)}/>`).join("");
  return `<svg class="st-scatter" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("Your score against your friend's, one dot per common track"))}">
    ${ticks.map((v) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${m.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}</text><text class="ax" x="${x(v)}" y="${H - m.b + 14}" text-anchor="middle">${v}</text>`).join("")}
    <polygon class="band" points="${bandPts}"/>
    <line class="diag" x1="${x(0)}" y1="${y(0)}" x2="${x(top)}" y2="${y(top)}"/>
    <text class="ax lbl" x="${W - m.r}" y="${H - 2}" text-anchor="end">${esc(t("You"))} →</text>
    <text class="ax lbl" x="${m.l + 4}" y="${m.t + 10}">↑ ${esc(friendName)}</text>
    ${dots}
  </svg>
  <p class="st-muted small st-scatter-note">${t("On the line: same score. In the band: less than 10 apart. Click a dot to see why.")}</p>`;
}

function commonTable(d, fn) {
  const rows = [...d.common];
  const sorters = {
    gap: (a, b) => Math.abs(b.gap) - Math.abs(a.gap),
    name: (a, b) => a.name.localeCompare(b.name),
    you: (a, b) => b.a - a.a,
    them: (a, b) => b.b - a.b,
  };
  rows.sort(sorters[ui.sort] ?? sorters.gap);
  const shown = ui.showAll ? rows : rows.slice(0, 12);
  const maxGap = Math.max(10, ...rows.map((r) => Math.abs(r.gap)));
  const sortBtn = (k, label) => `<button type="button" class="chip-btn" data-st="sort" data-sort="${k}" aria-pressed="${ui.sort === k}">${label}</button>`;
  return `
  <article class="st-card st-common">
    <header class="st-card-head"><h3>${t("Common tracks")}</h3>
      <div class="st-sorts" role="group" aria-label="${esc(t("Sort"))}">${sortBtn("gap", t("Biggest gap"))}${sortBtn("you", t("You"))}${sortBtn("them", fn)}${sortBtn("name", t("Name"))}</div>
    </header>
    <div class="st-table" role="table">
      <div class="st-tr st-th" role="row"><span role="columnheader">${t("Track")}</span><span role="columnheader">${t("You")}</span><span role="columnheader">${fn}</span><span role="columnheader">${t("Gap")}</span></div>
      ${shown.map((c) => {
        const w = (Math.abs(c.gap) / maxGap) * 50;
        return `<button type="button" class="st-tr${c.key === ui.pairKey ? " sel" : ""}" role="row" data-st="pair" data-key="${esc(c.key)}">
          <span class="nm" role="cell" title="${esc(c.name)}">${esc(c.name)}${c.pair.by === "spotify" ? "" : ` <small class="st-by" ${tipAttr(t("Matched by artist and title"))}>≈</small>`}</span>
          <span role="cell">${pill(c.a)}</span>
          <span role="cell">${pill(c.b)}</span>
          <span class="gap" role="cell"><span class="gbar"><i class="${c.gap >= 0 ? "pos" : "neg"}" style="width:${w}%"></i></span><b>${c.gap > 0 ? "+" : c.gap < 0 ? "−" : "±"}${num(Math.abs(c.gap))}</b></span>
        </button>`;
      }).join("")}
    </div>
    ${rows.length > 12 ? `<button type="button" class="btn ghost small st-more" data-st="show-all">${ui.showAll ? t("Show less") : tn(rows.length, "Show all {n} tracks", "Show all {n} tracks")}</button>` : ""}
  </article>`;
}

const CAUSES = {
  manual: ["✍", "A manual score is set on one side: the model's opinion is replaced."],
  correction: ["🎚", "One of you corrected this track (questionnaire)."],
  lyrics: ["💬", "A lyrics rating shifts the score on one side."],
  partial: ["◔", "One capture heard less than 60 % of the track: its analysis rests on a part only."],
  source: ["⇄", "Not the same source (file vs Spotify capture): mastering, codec and capture change the measures."],
  algorithm: ["⚙", "Different scoring versions."],
  adjusted: ["±", "The automatic scores are closer than the final ones: your own adjustments make most of the gap."],
};

function pairPanel(d, friend) {
  const c = d.common.find((x) => x.key === ui.pairKey) ?? d.common[0];
  ui.pairKey = c.key;
  const det = pairDetails(c.pair, { sameAlgorithm: d.sameAlgorithm });
  const { a, b } = c.pair;
  const subs = DIMENSIONS.map((dim) => ({ dim, s: det.subs.find((x) => x.key === dim.key) })).filter((x) => x.s);
  const srcTxt = (x) => {
    const k = x.src.kind === "spotify" ? t("Spotify capture") : x.src.kind === "local" ? t("audio file") : x.src.kind;
    return x.src.coverage != null && x.src.kind !== "local" ? `${k} · ${pct(x.src.coverage)}` : k;
  };
  const butterfly = subs.map(({ dim, s }) => `
    <li class="${s.big ? "big" : ""}" ${tipAttr(dim.hint)}>
      <span class="v you">${s.a == null ? "—" : Math.round(s.a)}</span>
      <span class="bar l"><i style="width:${Math.max(0, Math.min(100, s.a ?? 0))}%"></i></span>
      <span class="lbl">${esc(dim.label)}${s.diff != null && Math.abs(s.diff) >= 1 ? `<small>${s.diff > 0 ? "+" : "−"}${Math.round(Math.abs(s.diff))}</small>` : ""}</span>
      <span class="bar r"><i style="width:${Math.max(0, Math.min(100, s.b ?? 0))}%"></i></span>
      <span class="v them">${s.b == null ? "—" : Math.round(s.b)}</span>
    </li>`).join("");
  const feats = det.features.map((f) => {
    const spec = DUEL_FEATURES.find((x) => x.key === f.key);
    const v = (x) => (x == null ? "—" : `${num(x, spec.digits)}${spec.unit ? `<small> ${esc(spec.unit)}</small>` : ""}`);
    return `<div class="st-tr${f.big ? " big" : ""}" role="row" ${tipAttr(t(spec.hint))}>
      <span role="cell">${esc(t(spec.label))}</span><span role="cell" class="num">${v(f.a)}</span><span role="cell" class="num">${v(f.b)}</span>
      <span role="cell" class="num d">${f.diff == null ? "" : `${f.diff > 0 ? "+" : f.diff < 0 ? "−" : "±"}${num(Math.abs(f.diff), spec.digits)}`}</span>
    </div>`;
  }).join("");
  const bigSubs = subs.filter((x) => x.s.big).map(({ dim, s }) => t("{dim} {d}", { dim: dim.label.toLowerCase(), d: `${s.diff > 0 ? "+" : "−"}${Math.round(Math.abs(s.diff))}` }));
  const bigFeats = det.features.filter((f) => f.big).map((f) => t(DUEL_FEATURES.find((x) => x.key === f.key).label).toLowerCase());
  const summary = Math.abs(c.gap) < 3 ? t("You agree on this one.")
    : `${t("{name} hears it {n} {dir}.", { name: friend.name, n: num(Math.abs(c.gap)), dir: c.gap > 0 ? t("higher") : t("lower") })}${bigSubs.length ? ` ${t("Biggest sub-score gaps: {list}.", { list: bigSubs.join(", ") })}` : ""}${bigFeats.length ? ` ${t("Measured differently: {list}.", { list: bigFeats.join(", ") })}` : ""}`;
  return `
  <article class="st-card st-why">
    <header class="st-why-head">
      <div>
        <span class="st-kicker">${t("Why the gap?")}</span>
        <h3>${esc(c.name)}</h3>
        <p class="st-muted small">${t("You")}: ${esc(srcTxt(a))} · ${esc(friend.name)}: ${esc(srcTxt(b))}${c.pair.by === "name" ? ` · ${t("matched by artist and title")}` : ""}</p>
      </div>
      <div class="st-why-scores">
        <div class="you"><span>${t("You")}</span>${pill(c.a, "lg")}</div>
        <div class="gap ${c.gap > 0 ? "pos" : c.gap < 0 ? "neg" : ""}">${c.gap > 0 ? "+" : c.gap < 0 ? "−" : "±"}${num(Math.abs(c.gap))}</div>
        <div class="them"><span>${esc(friend.name)}</span>${pill(c.b, "lg")}</div>
      </div>
    </header>
    <p class="st-why-summary">${esc(summary)}</p>
    ${det.causes.length ? `<ul class="st-causes">${det.causes.map((k) => `<li><span aria-hidden="true">${CAUSES[k][0]}</span>${esc(t(CAUSES[k][1]))}</li>`).join("")}</ul>` : ""}
    <div class="st-grid-2 st-why-grid">
      <section>
        <h4>${t("Sub-scores")}</h4>
        <div class="st-legend2"><span class="you">${t("You")}</span><span class="them">${esc(friend.name)}</span></div>
        <ol class="st-butterfly">${butterfly}</ol>
      </section>
      <section>
        <h4>${t("Measured features")}</h4>
        <div class="st-table st-feats" role="table">
          <div class="st-tr st-th" role="row"><span role="columnheader">${t("Measure")}</span><span role="columnheader" class="num">${t("You")}</span><span role="columnheader" class="num">${esc(friend.name)}</span><span role="columnheader" class="num">Δ</span></div>
          ${feats}
        </div>
        <p class="st-muted small">${t("Highlighted: the differences that matter most. Automatic scores: you {a}, {name} {b}.", { a: Math.round(a.auto), b: Math.round(b.auto), name: friend.name })}</p>
      </section>
    </div>
  </article>`;
}

function onlyList(title, list, cls) {
  const shown = list.slice(0, 10);
  return `<article class="st-card st-only ${cls}">
    <header class="st-card-head"><h3>${esc(title)}</h3><span class="st-count">${num(list.length)}</span></header>
    ${list.length ? `<ol class="st-rank">${shown.map((x, k) => `<li><span class="rank">${k + 1}</span><span class="nm" title="${esc(x.name)}">${esc(x.name)}</span>${pill(x.score)}</li>`).join("")}</ol>
    ${list.length > shown.length ? `<p class="st-muted small">${tn(list.length - shown.length, "and {n} more", "and {n} more")}</p>` : ""}` : `<p class="st-muted small">${t("Nothing: every track is shared.")}</p>`}
  </article>`;
}

