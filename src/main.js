// Entry point: wires DOM events to the controller and renders on state changes.

import { ALGORITHM_VERSION } from "./config.js";
import { state, subscribe, notify } from "./app/store.js";
import * as ctl from "./app/controller.js";
import { initLibrary, renderLibrary } from "./ui/library.js";
import { initDetail, openDetail } from "./ui/detail.js";
import { initCorrection } from "./ui/correction.js";
import { initSettings } from "./ui/settings.js";
import { initProgression, renderProgression } from "./ui/progression.js";
import { toast } from "./ui/toast.js";
import { initRhythm, showRhythm } from "./ui/rhythm.js";
import { initSpotify } from "./ui/spotify.js";
import { initLive, showLive } from "./ui/live.js";
import { initReview } from "./ui/review.js";
import { initSet, showSet } from "./ui/set.js";
import { initTestlab, showTestlab } from "./ui/testlab.js";
import { initHome, showHome } from "./ui/home.js";
import { initGames, showGames } from "./ui/games.js";
import { t, tn, translateDom } from "./i18n/index.js";
import { initMotion } from "./ui/motion.js";

const $ = (id) => document.getElementById(id);

function initImport() {
  const zone = $("dropzone");
  const input = $("file-input");
  const accept = (files) => {
    const { accepted, rejected } = ctl.importFiles(files);
    if (rejected) toast(tn(rejected, "{n} file ignored (not audio).", "{n} files ignored (not audio)."), "error");
    if (!accepted && !rejected) toast(t("No file received."));
    if (accepted && state.ui.tab === "tab-home") $("tab-library").click();
  };
  input.addEventListener("change", () => {
    accept(input.files);
    input.value = "";
  });
  $("import-btn").addEventListener("click", () => input.click());
  // Allow dropping anywhere on the page: the zone is a full-window overlay
  // shown (class "dragover") while files are dragged over the window.
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    depth++;
    zone.classList.add("dragover");
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove("dragover");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove("dragover");
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length) accept(files);
  });

}

/** Supports dropped folders (webkitGetAsEntry) as well as plain files. */
async function filesFromDrop(dt) {
  const items = [...(dt.items ?? [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e).catch(() => {});
  return out;
}

function initTabs() {
  const tabs = [["tab-home", "panel-home"], ["tab-library", "panel-library"], ["tab-progression", "panel-progression"], ["tab-set", "panel-set"], ["tab-rhythm", "panel-rhythm"], ["tab-spotify", "panel-spotify"], ["tab-lab", "panel-lab"], ["tab-live", "panel-live"], ["tab-games", "panel-games"]];
  for (const [tabId, panelId] of tabs) {
    $(tabId).addEventListener("click", () => {
      for (const [t, p] of tabs) {
        $(t).setAttribute("aria-selected", String(t === tabId));
        $(p).hidden = p !== panelId;
      }
      state.ui.tab = tabId;
      notify();
      if (tabId === "tab-rhythm") showRhythm();
      if (tabId === "tab-live") showLive();
      if (tabId === "tab-set") showSet();
      if (tabId === "tab-lab") showTestlab();
      if (tabId === "tab-home") showHome();
      if (tabId === "tab-games") showGames();
    });
  }
  // links like index.html#tab-set (from the guide) open that tab
  const fromHash = () => {
    const id = location.hash.slice(1);
    if (tabs.some(([t]) => t === id)) $(id).click();
  };
  window.addEventListener("hashchange", fromHash);
  fromHash();
}

function renderQueue() {
  const q = state.queue;
  const box = $("queue");
  box.hidden = q.total === 0;
  if (!q.total) return;
  const active = [...state.jobs.values()].filter((j) => j.stage !== "queued").length;
  const parts = [t("{done}/{total} processed", { done: q.done, total: q.total })];
  if (active) parts.push(t("{n} in progress", { n: active }));
  if (q.cached) parts.push(t("{n} already cached", { n: q.cached }));
  if (q.errors) parts.push(tn(q.errors, "{n} error", "{n} errors"));
  $("queue-text").textContent = (q.done === q.total ? t("Analysis finished · ") : t("Analysing… ")) + parts.join(" · ");
  const partial = [...state.jobs.values()].reduce((a, j) => a + (j.stage === "features" ? j.progress * 0.9 + 0.1 : j.stage === "decode" ? 0.08 : 0), 0);
  $("queue-bar").style.width = `${Math.min(100, ((q.done + partial) / q.total) * 100)}%`;
}

async function main() {
  translateDom();
  $("version-info").textContent = `· ${t("algorithm")} v${ALGORITHM_VERSION}`;
  initImport();
  initTabs();
  initMotion();
  initLibrary({ openDetail });
  initDetail();
  initCorrection();
  initSettings();
  initProgression({ openDetail });
  initRhythm();
  initLive({ openDetail });
  initReview();
  initSet({ openDetail });
  initTestlab({ openDetail });
  initHome();
  initGames();
  document.addEventListener("open-detail", (e) => openDetail(e.detail));
  ctl.onToast(toast);
  $("rescore-all").addEventListener("click", async () => {
    const n = await ctl.recomputeAll();
    toast(n ? t("{n} scores recomputed from the cache.", { n }) : t("No analysed track."));
  });
  subscribe(() => {
    renderQueue();
    renderLibrary();
    renderProgression();
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.jobs.size) e.preventDefault();
  });
  try {
    const { rescored } = await ctl.init();
    if (rescored) toast(tn(rescored, "{n} score recomputed from the cache (new version or weights).", "{n} scores recomputed from the cache (new version or weights)."));
  } catch (err) {
    console.error(err);
    toast(t("Local storage unavailable: {msg}. Analyses will not be kept.", { msg: err.message }), "error", 8000);
  }
  notify();
  if (state.ui.tab === "tab-home") showHome();
  // after the library is loaded (matching needs it); also finishes a Spotify login redirect
  initSpotify()
    .catch((err) => console.error(err))
    .then(() => ctl.autoFetchGenres());
}

main();
