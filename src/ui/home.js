// Home tab: entry points and a status overview of the app.

import { state, subscribe } from "../app/store.js";
import { isCounted } from "../core/track.js";
import * as ctl from "../app/controller.js";
import * as auth from "../spotify/auth.js";
import { escapeHtml } from "../util/format.js";
import { t, tn } from "../i18n/index.js";

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
    genres: await ctl.genreStatus().catch(() => null),
  };
  render();
}

function render() {
  const recs = [...state.records.values()];
  const analysed = recs.filter(isCounted);
  const drafts = recs.filter((r) => r.draft).length;
  const draftsText = tn(drafts, "{n} draft to validate", "{n} drafts to validate");
  const tests = recs.filter((r) => r.source?.kind === "test").length;
  const captured = recs.filter((r) => r.source?.kind === "spotify").length;
  const toRate = ctl.lyricsToRate().length;
  const g = extra.genres;
  const avg = analysed.length ? Math.round(analysed.reduce((a, r) => a + r.finalScore, 0) / analysed.length) : null;
  const items = [
    [t("Analysed tracks"), analysed.length, analysed.length ? t("average intensity {n}", { n: avg }) + (tests ? ` · ${tn(tests, "{n} test track", "{n} test tracks")}` : "") + (drafts ? ` · ${draftsText}` : "") : drafts ? draftsText : t("import files or scan a playlist"), "tab-library"],
    ["Spotify", auth.isLoggedIn() ? t("connected") : t("not connected"), `${tn(extra.playlists, "{n} playlist imported", "{n} playlists imported")} · ${tn(captured, "{n} track captured", "{n} tracks captured")}`, "tab-spotify"],
    [t("Lyrics to rate"), toRate, toRate ? t("sung tracks without a rating") : t("nothing pending"), "tab-library"],
    [t("Genres"), g ? `${g.labelled}/${g.analysed}` : "—", genreLine(g), "tab-library"],
  ];
  $("home-status").innerHTML = items.map(([k, v, sub, tab]) => `<button type="button" class="home-stat" data-home="${tab}"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b><small>${escapeHtml(sub)}</small></button>`).join("");
}

/** Where the genres come from, in one line. */
export function genreLine(g) {
  if (!g) return "";
  if (g.job) return t("looking up on MusicBrainz… {d}/{n}", { d: g.job.done, n: g.job.total });
  const parts = [];
  if (g.musicbrainz) parts.push(t("{n} from MusicBrainz", { n: g.musicbrainz }));
  if (g.lastfm) parts.push(t("{n} from Last.fm", { n: g.lastfm }));
  if (g.spotify) parts.push(t("{n} from Spotify", { n: g.spotify }));
  if (g.user) parts.push(t("{n} labelled by you", { n: g.user }));
  if (!parts.length) {
    if (g.run?.errors && !g.run.found) return t("MusicBrainz unreachable: check your connection, then try again.");
    return g.run ? t("no genre found yet") : t("looked up automatically on MusicBrainz");
  }
  return parts.join(" · ");
}
