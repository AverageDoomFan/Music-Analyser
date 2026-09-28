// Home tab: entry points and a status overview of the app.

import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import * as auth from "../spotify/auth.js";
import { escapeHtml } from "../util/format.js";

const $ = (id) => document.getElementById(id);
let extra = { playlists: 0 };

export function initHome() {
  $("panel-home").addEventListener("click", (e) => {
    const el = e.target.closest("[data-home]");
    if (!el) return;
    const target = el.dataset.home;
    if (target === "import") $("file-input").click();
    else if (target === "settings") $("open-settings").click();
    else $(target)?.click();
  });
  subscribe(() => { if (!$("panel-home").hidden) render(); });
}

export async function showHome() {
  extra = {
    playlists: (await ctl.importedPlaylists().catch(() => [])).length,
  };
  render();
}

function render() {
  const recs = [...state.records.values()];
  const analysed = recs.filter((r) => r.finalScore != null);
  const tests = recs.filter((r) => r.source?.kind === "test").length;
  const captured = recs.filter((r) => r.source?.kind === "spotify").length;
  const toRate = ctl.lyricsToRate().length;
  const labelled = recs.filter((r) => r.genre?.source === "user").length;
  const avg = analysed.length ? Math.round(analysed.reduce((a, r) => a + r.finalScore, 0) / analysed.length) : null;
  const items = [
    ["Morceaux analysés", analysed.length, analysed.length ? `intensité moyenne ${avg}${tests ? ` · dont ${tests} de test` : ""}` : "importe des fichiers ou scanne une playlist", "tab-library"],
    ["Spotify", auth.isLoggedIn() ? "connecté" : "non connecté", `${extra.playlists} playlist${extra.playlists > 1 ? "s" : ""} importée${extra.playlists > 1 ? "s" : ""} · ${captured} titre${captured > 1 ? "s" : ""} capté${captured > 1 ? "s" : ""}`, "tab-spotify"],
    ["Paroles à noter", toRate, toRate ? "morceaux chantés sans note" : "rien en attente", "tab-library"],
    ["Genres étiquetés", labelled, labelled ? "les autres reçoivent des suggestions" : "étiquette quelques morceaux (bouton Genres)", "tab-library"],
  ];
  $("home-status").innerHTML = items.map(([k, v, sub, t]) => `<button type="button" class="home-stat" data-home="${t}"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b><small>${escapeHtml(sub)}</small></button>`).join("");
}
