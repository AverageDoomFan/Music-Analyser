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

const $ = (id) => document.getElementById(id);

function initImport() {
  const zone = $("dropzone");
  const input = $("file-input");
  const accept = (files) => {
    const { accepted, rejected } = ctl.importFiles(files);
    if (rejected) toast(`${rejected} fichier${rejected > 1 ? "s" : ""} ignoré${rejected > 1 ? "s" : ""} (format non audio).`, "error");
    if (!accepted && !rejected) toast("Aucun fichier reçu.");
  };
  input.addEventListener("change", () => {
    accept(input.files);
    input.value = "";
  });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  // Allow dropping anywhere on the page.
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
  const tabs = [["tab-library", "panel-library"], ["tab-progression", "panel-progression"]];
  for (const [tabId, panelId] of tabs) {
    $(tabId).addEventListener("click", () => {
      for (const [t, p] of tabs) {
        $(t).setAttribute("aria-selected", String(t === tabId));
        $(p).hidden = p !== panelId;
      }
      state.ui.tab = tabId;
      notify();
    });
  }
}

function renderQueue() {
  const q = state.queue;
  const box = $("queue");
  box.hidden = q.total === 0;
  if (!q.total) return;
  const active = [...state.jobs.values()].filter((j) => j.stage !== "queued").length;
  const parts = [`${q.done}/${q.total} traité${q.done > 1 ? "s" : ""}`];
  if (active) parts.push(`${active} en cours`);
  if (q.cached) parts.push(`${q.cached} déjà en cache`);
  if (q.errors) parts.push(`${q.errors} erreur${q.errors > 1 ? "s" : ""}`);
  $("queue-text").textContent = (q.done === q.total ? "Analyse terminée · " : "Analyse… ") + parts.join(" · ");
  const partial = [...state.jobs.values()].reduce((a, j) => a + (j.stage === "features" ? j.progress * 0.9 + 0.1 : j.stage === "decode" ? 0.08 : 0), 0);
  $("queue-bar").style.width = `${Math.min(100, ((q.done + partial) / q.total) * 100)}%`;
}

async function main() {
  $("version-info").textContent = `· algorithme v${ALGORITHM_VERSION}`;
  initImport();
  initTabs();
  initLibrary({ openDetail });
  initDetail();
  initCorrection();
  initSettings();
  initProgression({ openDetail });
  ctl.onToast(toast);
  $("rescore-all").addEventListener("click", async () => {
    const n = await ctl.recomputeAll();
    toast(n ? `${n} scores recalculés depuis le cache.` : "Aucun morceau analysé.");
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
    if (rescored) toast(`${rescored} score${rescored > 1 ? "s" : ""} recalculé${rescored > 1 ? "s" : ""} depuis le cache (nouvelle version ou pondérations).`);
  } catch (err) {
    console.error(err);
    toast(`Stockage local indisponible : ${err.message}. Les analyses ne seront pas conservées.`, "error", 8000);
  }
  notify();
}

main();
