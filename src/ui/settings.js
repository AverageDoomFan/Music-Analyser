// Settings dialog: language, model weights, learning from corrections,
// genre sources, backup, diagnostic and reports, reset.

import { ALGORITHM_VERSION, FEATURE_VERSION, DEFAULT_WEIGHTS, DIMENSIONS, AGGREGATIONS } from "../config.js";
import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { t, tn, getLang, setLang, LANGUAGES } from "../i18n/index.js";
import { escapeHtml } from "../util/format.js";
import { toast } from "./toast.js";
import { getBackdropMode, setBackdropMode } from "./backdrop.js";
import { cloudConfigured, isAdmin } from "../cloud/firebase.js";
import { acc, isSignedIn, updateProfile } from "../cloud/account.js";
import { syncPrefs, setSyncPrefs } from "../cloud/sync.js";
import { cloudSettings, setShare, syncNow, deleteMyCloudData, status as syncStatus } from "../cloud/share.js";

const dialog = () => document.getElementById("settings-dialog");
let draft = null;
let proposal = null;
let genres = { auto: true, lastfmKey: "" };
let reports = [];
let cloud = { admin: false, share: false, error: null };

export function initSettings() {
  document.getElementById("open-settings").addEventListener("click", open);
  const d = dialog();
  d.addEventListener("input", (e) => {
    const key = e.target.dataset.weight;
    if (!key) return;
    draft[key] = Number(e.target.value);
    e.target.closest(".weight-row").querySelector("output").textContent = draft[key].toFixed(2);
    d.querySelector("[data-action=apply-weights]").disabled = false;
  });
  d.addEventListener("change", async (e) => {
    if (e.target.id === "language") return setLang(e.target.value);
    if (e.target.name === "backdrop") return setBackdropMode(e.target.value);
    if (e.target.id === "dev-share") {
      cloud.share = e.target.checked;
      try {
        const res = await setShare(cloud.share);
        if (res) toast(t("Shared: {duels} new duels, {reports} new reports.", res));
      } catch (err) {
        toast(err.message, "error");
      }
      return render();
    }
    if (e.target.id === "genre-auto") {
      genres.auto = e.target.checked;
      await ctl.setGenreSettings({ auto: genres.auto });
      toast(genres.auto ? t("Genre lookup on: new tracks are looked up in the background.") : t("Genre lookup off."));
      return;
    }
    if (e.target.id === "lastfm-key") {
      genres.lastfmKey = e.target.value.trim();
      await ctl.setGenreSettings({ lastfmKey: genres.lastfmKey });
      toast(genres.lastfmKey ? t("Last.fm key saved: used for tracks MusicBrainz does not know.") : t("Last.fm key removed."));
      return;
    }
    if (e.target.id === "cloud-public") {
      try {
        await updateProfile({ isPublic: e.target.checked });
        toast(e.target.checked ? t("Your account is public: others can find your page.") : t("Your account is private: only your friends see your page."));
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(err.message, "error");
      }
      return;
    }
    if (e.target.id === "cloud-share") return setSyncPrefs({ share: e.target.checked });
    if (e.target.id === "cloud-community") {
      await setSyncPrefs({ community: e.target.checked });
      toast(t("Scores recomputed."));
      return;
    }
    if (e.target.name === "aggregation") {
      await ctl.setAggregation(e.target.value);
      toast(t("Scores recomputed from the cached curves."));
      return;
    }
    if (e.target.id !== "import-json" || !e.target.files[0]) return;
    try {
      const { count, weights, aggregation, duels, reports } = await ctl.importDatabase(e.target.files[0]);
      toast(tn(count, "{n} track imported / merged.", "{n} tracks imported / merged.") + (duels || reports ? " " + t("New: {duels} duels, {reports} reports.", { duels, reports }) : ""));
      if (weights && confirm(t("The file also holds weights. Apply them?"))) {
        await ctl.setWeights({ ...DEFAULT_WEIGHTS, ...weights });
        draft = { ...state.weights };
        render();
      }
      if (aggregation && aggregation !== state.aggregation && confirm(t("The file uses another way of computing the score. Apply it?"))) {
        await ctl.setAggregation(aggregation);
        render();
      }
    } catch (err) {
      toast(err.message, "error");
    }
    e.target.value = "";
  });
  d.addEventListener("click", async (e) => {
    if (e.target === d) return d.close();
    const action = e.target.closest("[data-action]")?.dataset.action;
    switch (action) {
      case "close": d.close(); break;
      case "go-account": d.close(); document.getElementById("tab-stats")?.click(); break;
      case "apply-weights":
        await ctl.setWeights(draft);
        toast(t("Weights applied, scores recomputed."));
        render();
        break;
      case "reset-weights":
        draft = { ...DEFAULT_WEIGHTS };
        await ctl.setWeights(draft);
        toast(t("Default weights restored."));
        render();
        break;
      case "learn":
        proposal = ctl.proposeWeights();
        render();
        break;
      case "learn-apply":
        await ctl.setWeights(proposal.weights);
        draft = { ...state.weights };
        proposal = null;
        toast(t("Weights fitted to your corrections."));
        render();
        break;
      case "learn-cancel": proposal = null; render(); break;
      case "export": {
        const n = await ctl.exportDatabase();
        toast(t("Exported: {tracks} tracks, {duels} duels, {reports} reports.", n));
        break;
      }
      case "import": d.querySelector("#import-json").click(); break;
      case "diagnostic":
      case "diagnostic-full": {
        const n = await ctl.exportDiagnostic({ full: action === "diagnostic-full" });
        toast(tn(n, "Diagnostic export: {n} track.", "Diagnostic export: {n} tracks."));
        break;
      }
      case "reports-export": {
        const n = await ctl.exportReports();
        toast(tn(n, "{n} report exported.", "{n} reports exported."));
        break;
      }
      case "reports-clear":
        if (!confirm(t("Delete the saved reports?"))) break;
        await ctl.clearReports();
        reports = [];
        render();
        break;
      case "cloud-sync":
        try {
          const res = await syncNow();
          toast(t("Shared: {duels} new duels, {reports} new reports.", res));
        } catch (err) {
          toast(err.message, "error");
        }
        render();
        break;
      case "cloud-delete":
        if (!confirm(t("Delete everything you shared (duels, reports, profile) from the cloud? Your local data stays."))) break;
        try {
          await deleteMyCloudData();
          await refreshCloud();
          toast(t("Your cloud data is deleted."));
        } catch (err) {
          toast(err.message, "error");
        }
        render();
        break;
      case "clear":
        if (!confirm(t("Delete every local analysis, correction and setting of this app in this browser? Your audio files are not touched."))) break;
        await ctl.clearAllData();
        toast(t("Local data deleted."));
        d.close();
        break;
    }
  });
}

async function open() {
  draft = { ...state.weights };
  proposal = null;
  genres = await ctl.genreSettings();
  reports = await ctl.getReports();
  await refreshCloud();
  render();
  dialog().showModal();
}

async function refreshCloud() {
  if (!cloudConfigured()) return;
  try {
    cloud.admin = isSignedIn() ? await isAdmin() : false;
    cloud.share = (await cloudSettings()).share;
    cloud.error = null;
  } catch (err) {
    cloud.error = err.message;
  }
}

/** Opt-in sharing of duels and reports with the developer (admin panel). */
function devShareHtml() {
  if (!isSignedIn()) return "";
  const st = syncStatus;
  return `
      <h3>${t("Share with the developer")}</h3>
      <p class="muted small">${t("Optional. Turn sharing on to send your duels, your reports for analysis and a small profile (name, e-mail, counters) to the app's database, where only the admins can read them, to improve the algorithm. Never audio or file paths. You can delete what you shared at any time.")}</p>
      ${cloud.error ? `<p class="notice">${escapeHtml(cloud.error)}</p>` : ""}
      <p class="muted small">uid: <code>${escapeHtml(acc.user?.uid ?? "")}</code>${cloud.admin ? ` · <b>${t("admin")}</b>` : ""}</p>
      <label class="inline"><input type="checkbox" id="dev-share" ${cloud.share ? "checked" : ""}> ${t("Share my duels and reports")}</label>
      <p class="muted small">${st.syncing ? t("Sharing…") : st.error ? escapeHtml(st.error) : st.lastSync ? t("Last shared at {time}.", { time: new Date(st.lastSync).toLocaleTimeString() }) : ""}</p>
      <div class="settings-actions">
        ${cloud.share ? `<button class="btn" data-action="cloud-sync">${t("Share now")}</button>` : ""}
        ${cloud.admin ? `<a class="btn primary" href="admin.html" target="_blank" rel="noopener">${t("Open the admin panel")} ↗</a>` : ""}
        <button class="btn danger" data-action="cloud-delete">${t("Delete my cloud data")}</button>
      </div>
`;
}

function render() {
  const corrected = ctl.correctionSamples().length;
  dialog().innerHTML = `
    <div class="dialog-head"><h2>${t("Settings")}</h2><button class="icon-btn" data-action="close" aria-label="${t("Close")}">✕</button></div>
    <div class="dialog-body">
      <h3>${t("Language")}</h3>
      <select id="language" aria-label="${t("Language")}">${LANGUAGES.map((l) => `<option value="${l.key}" ${l.key === getLang() ? "selected" : ""}>${l.label}</option>`).join("")}</select>

      <h3>${t("Background")}</h3>
      <div class="segmented" role="radiogroup" aria-label="${t("Background")}">${[["on", t("Animated")], ["still", t("Still")], ["off", t("Off")]].map(([k, label]) => `
        <label><input type="radio" name="backdrop" value="${k}" ${getBackdropMode() === k ? "checked" : ""}><span>${label}</span></label>`).join("")}
      </div>
      <p class="muted small">${t("Slow coloured light behind every tab that warms up with the track you play or open. “Still” keeps the colours without movement.")}</p>

      <h3>${t("From the curve to the score")}</h3>
      <p class="muted small">${t("Each track is analysed in windows of a few seconds: intensity and every sub-score form a curve. Choose how that curve becomes a score (also available above the library).")}</p>
      <div class="agg-options">${AGGREGATIONS.map((a) => `
        <label><input type="radio" name="aggregation" value="${a.key}" ${state.aggregation === a.key ? "checked" : ""}> <strong>${a.label}</strong><small>${a.hint}</small></label>`).join("")}
      </div>

      <h3>${t("Intensity weights")}</h3>
      <p class="muted small">${t("Relative importance of each dimension. “Noise” is a push towards 100 for tracks that are already intense. Scores are recomputed from the cache, without reading the audio again.")}</p>
      <div class="weights">${DIMENSIONS.map((dim) => `
        <label class="weight-row" title="${escapeHtml(dim.hint)}">
          <span>${dim.label}</span>
          <input type="range" min="0" max="4" step="0.05" value="${draft[dim.key]}" data-weight="${dim.key}">
          <output>${Number(draft[dim.key]).toFixed(2)}</output>
        </label>`).join("")}
      </div>
      <div class="settings-actions">
        <button class="btn primary" data-action="apply-weights" disabled>${t("Apply")}</button>
        <button class="btn" data-action="reset-weights">${t("Defaults")}</button>
      </div>

      <h3>${t("Learn from my corrections")}</h3>
      <p class="muted small">${tn(corrected, "Fits the global weights so the automatic score gets closer to your corrections ({n} corrected track).", "Fits the global weights so the automatic score gets closer to your corrections ({n} corrected tracks).")}</p>
      ${proposal ? proposalHtml() : `<button class="btn" data-action="learn" ${corrected < 3 ? `disabled title="${t("At least 3 corrected tracks are needed.")}"` : ""}>${t("Propose weights")}</button>`}

      <h3>${t("Genres")}</h3>
      <label class="inline"><input type="checkbox" id="genre-auto" ${genres.auto ? "checked" : ""}> ${t("Look up genres automatically on MusicBrainz")}</label>
      <p class="muted small">${t("MusicBrainz (musicbrainz.org) is an open music database. For each analysed track the app sends it the ISRC, or else the artist and title, one track per second, and keeps the genres voted for the track, its album and its artist. A track tagged instrumental there is marked as such unless you said otherwise. “Refresh genres” in the library looks everything up again.")}</p>
      <label class="inline">${t("Last.fm API key (optional)")} <input type="text" id="lastfm-key" value="${escapeHtml(genres.lastfmKey)}" autocomplete="off" spellcheck="false" size="34" placeholder="${t("32 characters")}"></label>
      <p class="muted small">${t("With your own free key (last.fm/api/account/create), tracks MusicBrainz does not know get Last.fm's top tags instead. The key stays in this browser.")}</p>

      <h3>${t("Backup")}</h3>
      <div class="settings-actions">
        <button class="btn" data-action="export">${t("Export the database (JSON)")}</button>
        <button class="btn" data-action="import">${t("Import a JSON")}</button>
        <input type="file" id="import-json" accept="application/json,.json" hidden>
      </div>
      <p class="muted small">${t("Holds fingerprints, names, features, scores, corrections, your duels (> < =, with the scores at the time of each answer) and your reports for analysis, plus the algorithm version — never the audio. Importing merges everything without duplicates.")}</p>

      <h3>${t("Reports for analysis")}</h3>
      <p class="muted small">${t("From a track's details, “Report for analysis” saves everything the model knows about it (every measure and its curve, sub-scores, how they are built) with your comment and expected score. Export them and send the file to get the model fixed on those tracks. No audio, no file path.")}</p>
      ${reports.length ? `<ul class="report-list">${reports.slice(-8).reverse().map((r) => `<li><b>${escapeHtml(r.name)}</b> <span class="muted small">${Math.round(r.finalScore)}${r.expected != null ? ` → ${t("expected")} ${Math.round(r.expected)}` : ""}${r.comment ? ` · ${escapeHtml(r.comment.slice(0, 80))}` : ""}</span></li>`).join("")}</ul>` : ""}
      <div class="settings-actions">
        <button class="btn" data-action="reports-export" ${reports.length ? "" : "disabled"}>${tn(reports.length, "Export {n} report", "Export {n} reports")}</button>
        ${reports.length ? `<button class="btn" data-action="reports-clear">${t("Delete the reports")}</button>` : ""}
      </div>

${cloudHtml()}
${devShareHtml()}
      <h3>${t("Diagnostic export")}</h3>
      <p class="muted small">${t("A compact file to improve the model on your real library: for every track, its name, genres, scores, sub-scores, the measures they are made of, and your corrections, lyrics ratings and duels. No audio, no file path.")}</p>
      <div class="settings-actions"><button class="btn" data-action="diagnostic">${t("Export the diagnostic")}</button>
        <button class="btn" data-action="diagnostic-full" title="${escapeHtml(t("Also every measure over time and how each sub-score is built: a bigger file, for an exact refit of the model."))}">${t("Full diagnostic")}</button></div>

      <h3>${t("Local data")}</h3>
      <button class="btn danger" data-action="clear">${t("Delete local data")}</button>
      <p class="muted small">${t("Algorithm v{a} · extractor v{f} · {n} tracks cached (IndexedDB).", { a: ALGORITHM_VERSION, f: FEATURE_VERSION, n: state.records.size })}</p>
    </div>`;
}

function proposalHtml() {
  if (proposal.error) return `<p class="notice">${escapeHtml(proposal.error)}</p><button class="btn" data-action="learn-cancel">OK</button>`;
  const rows = DIMENSIONS.map((dim) => {
    const a = state.weights[dim.key], b = proposal.weights[dim.key];
    return `<li><span>${dim.label}</span><span>${a.toFixed(2)} → <strong>${b.toFixed(2)}</strong></span></li>`;
  }).join("");
  return `<div class="card">
    <ul class="delta-list">${rows}</ul>
    <p class="small">${t("Mean gap with your corrections: {a} → <strong>{b}</strong> points ({n} tracks).", { a: proposal.errorBefore.toFixed(1), b: proposal.errorAfter.toFixed(1), n: proposal.n })}</p>
    <div class="settings-actions">
      <button class="btn primary" data-action="learn-apply">${t("Apply")}</button>
      <button class="btn" data-action="learn-cancel">${t("Cancel")}</button>
    </div>
  </div>`;
}

/** Online account: privacy, sharing, community scores (when a Firebase project is set up). */
function cloudHtml() {
  if (!cloudConfigured()) return "";
  const p = syncPrefs();
  if (!isSignedIn()) {
    return `<h3>${t("Online account")}</h3>
      <p class="muted small">${t("Not signed in. Sign in from the Account tab to share analyses, vote on scores, add friends and appear in the leaderboards.")} <button class="linklike" data-action="go-account">${t("Account")}</button></p>`;
  }
  return `<h3>${t("Online account")}</h3>
    <p class="small">${t("Signed in as {name}.", { name: `<b>${escapeHtml(acc.profile.name)}</b>` })}</p>
    <label class="inline"><input type="checkbox" id="cloud-public" ${acc.profile.public ? "checked" : ""}> ${t("Public account")}</label>
    <p class="muted small">${t("Public: anyone can find your page (name, library and listening summaries) and your name shows in the leaderboards. Private: only your friends see your page; leaderboards say “private user”.")}</p>
    <label class="inline"><input type="checkbox" id="cloud-share" ${p.share ? "checked" : ""}> ${t("Share my analyses")}</label>
    <p class="muted small">${t("Tracks captured from Spotify go to the shared database (measures and title, never audio), so others get them without analysing.")}</p>
    <label class="inline"><input type="checkbox" id="cloud-community" ${p.community ? "checked" : ""}> ${t("Use community scores")}</label>
    <p class="muted small">${t("A track with votes takes the mean of everyone's votes instead of its automatic score. Your own correction or manual score always wins.")}</p>`;
}
