// Spotify tab: connect (PKCE), import a playlist's track list, match it with
// local analysed files, preview the intensity order and create a NEW
// playlist in the user's account. Nothing is sent anywhere but to Spotify,
// and only the playlist data needed here is kept (cleared on disconnect).

import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import * as auth from "../spotify/auth.js";
import * as api from "../spotify/api.js";
import { matchPlaylist, candidatesFor } from "../spotify/match.js";
import { formatDuration, formatScore, escapeHtml } from "../util/format.js";
import { toast } from "./toast.js";
import { playlistPoints, playlistStats, drawMap, compareHtml } from "./playlist-insights.js";
import { t, tn } from "../i18n/index.js";

const $ = (id) => document.getElementById(id);

const sp = {
  user: null,          // { id, display_name }
  playlists: [],
  playlist: null,      // { id, name, url, tracks: [...] , importedAt }
  manual: {},          // trackId → recordId | null
  matches: new Map(),
  order: null,
  imported: [],
  compareId: "",
  hits: [],
  hover: null,
  diff: null,
};

export async function initSpotify() {
  $("sp-redirect").textContent = auth.redirectUri();
  $("sp-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(auth.redirectUri());
      toast(t("Address copied."));
    } catch {
      toast(auth.redirectUri());
    }
  });
  $("sp-client").value = auth.getClientId();
  $("sp-save-client").addEventListener("click", () => {
    try {
      auth.setClientId($("sp-client").value);
      toast(t("Client ID saved."));
      renderAccount();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("sp-login").addEventListener("click", async () => {
    try {
      await auth.beginLogin();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("sp-logout").addEventListener("click", async () => {
    if (!confirm(t("Log out of Spotify and delete the imported playlist and saved matches in this browser?"))) return;
    auth.logout();
    await ctl.spotifyStore.clear();
    Object.assign(sp, { user: null, playlists: [], playlist: null, manual: {}, matches: new Map(), order: null, imported: [], diff: null, compareId: "" });
    renderAll();
    toast(t("Logged out. Also remove the access on spotify.com/account/apps if you no longer use the app."));
  });
  $("sp-import").addEventListener("click", importPlaylist);
  $("sp-tracks").addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-track]");
    if (!sel) return;
    sp.manual[sel.dataset.track] = sel.value || null;
    ctl.spotifyStore.set("matches", sp.manual);
    rematch();
  });
  $("sp-preview").addEventListener("click", () => { buildOrder(); renderOrder(); });
  $("sp-unmatched").addEventListener("change", () => { if (sp.order) { buildOrder(); renderOrder(); } });
  $("sp-order-mode").addEventListener("change", () => { if (sp.order) { buildOrder(); renderOrder(); } });
  $("sp-genres").addEventListener("click", fetchGenres);
  $("sp-create").addEventListener("click", createSorted);
  $("sp-go-live").addEventListener("click", () => $("tab-live").click());
  $("sp-switch").addEventListener("click", switchPlaylist);
  $("sp-forget").addEventListener("click", forgetPlaylist);
  $("sp-compare").addEventListener("change", (e) => { sp.compareId = e.target.value; renderInsights(); });
  $("sp-diff").addEventListener("click", (e) => { if (e.target.closest("[data-go-live]")) $("tab-live").click(); });
  const map = $("sp-map");
  map.addEventListener("mousemove", (e) => {
    const hit = hitAt(e);
    const id = hit?.p.record.id ?? null;
    map.style.cursor = hit ? "pointer" : "default";
    if (id === sp.hover) return;
    sp.hover = id;
    $("sp-map-tip").innerHTML = hit ? `<b>${escapeHtml(hit.p.track.name)}</b> — ${escapeHtml(hit.p.track.artists.join(", "))} · ${t("intensity")} ${Math.round(hit.p.score)} · ${t("mood")} ${Math.round(hit.p.valence)}${hit.other ? t(" (compared playlist)") : ""}` : t("Each dot is an analysed track: intensity across, mood (dark → bright) up. Click: details.");
    renderInsights(false);
  });
  map.addEventListener("click", (e) => {
    const hit = hitAt(e);
    if (hit) document.dispatchEvent(new CustomEvent("open-detail", { detail: hit.p.record.id }));
  });
  new ResizeObserver(() => renderInsights(false)).observe(map);

  // library changes (new files, analyses) → re-match
  let lastKey = "";
  subscribe(() => {
    const key = [...state.records.values()].map((r) => `${r.id}:${r.finalScore ?? ""}`).join("|");
    if (key === lastKey || !sp.playlist) return;
    lastKey = key;
    rematch();
  });

  // back from Spotify's consent screen?
  try {
    const res = await auth.handleRedirect();
    if (res) {
      document.getElementById("tab-spotify").click();
      toast(res.ok ? t("Spotify account connected.") : res.error, res.ok ? "info" : "error");
    }
  } catch (err) {
    toast(t("Spotify login: {msg}", { msg: err.message }), "error");
  }
  sp.playlist = await ctl.spotifyStore.get("playlist").catch(() => null) ?? null;
  sp.manual = await ctl.spotifyStore.get("matches").catch(() => null) ?? {};
  await loadImported();
  if (sp.playlist) rematch();
  await loadAccount();
}

async function loadAccount() {
  renderAccount();
  if (!auth.isLoggedIn()) return;
  try {
    sp.user = await api.me();
    sp.playlists = await api.myPlaylists(sp.user.id);
  } catch (err) {
    toast(err.message, "error");
    if (!auth.isLoggedIn()) sp.user = null;
  }
  renderAll();
}

async function importPlaylist() {
  const id = $("sp-playlist").value;
  if (!id) return;
  const btn = $("sp-import");
  btn.disabled = true;
  $("sp-import-status").textContent = t("Importing…");
  try {
    const info = sp.playlists.find((p) => p.id === id) ?? {};
    const tracks = await api.playlistTracks(id);
    sp.playlist = { id, name: info.name ?? "Playlist", url: info.url ?? null, tracks, importedAt: Date.now() };
    sp.diff = await ctl.rememberPlaylist(sp.playlist);
    await loadImported();
    if (sp.playlist.id !== (await ctl.spotifyStore.get("playlist"))?.id) sp.manual = {};
    await ctl.spotifyStore.set("playlist", sp.playlist);
    await ctl.spotifyStore.set("matches", sp.manual);
    $("sp-import-status").textContent = tn(tracks.length, "{n} track imported.", "{n} tracks imported.");
    $("sp-name").value = `${sp.playlist.name} · ${t("intensity progression")}`;
    sp.order = null;
    rematch();
    ctl.scheduleGenreFetch();
  } catch (err) {
    $("sp-import-status").textContent = "";
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function rematch() {
  if (!sp.playlist) return renderAll();
  sp.matches = matchPlaylist(sp.playlist.tracks, [...state.records.values()], sp.manual);
  if (sp.order) buildOrder();
  renderAll();
}

/** Matched & analysed tracks in progression order, then (optionally) the others. */
function buildOrder() {
  const tracks = sp.playlist.tracks;
  const byRecord = new Map();
  for (const t of tracks) {
    const m = sp.matches.get(t.id);
    if (m && state.records.get(m.recordId)?.finalScore != null) byRecord.set(m.recordId, t);
  }
  const byStyle = $("sp-order-mode").value === "style";
  const ordered = ctl.orderRecords([...byRecord.keys()], 6, { byStyle }).steps.map((s) => ({ track: byRecord.get(s.id), score: s.score, stage: s.stage, group: s.group }));
  const rest = $("sp-unmatched").value === "end" ? tracks.filter((t) => ![...byRecord.values()].includes(t)).map((track) => ({ track, score: null, rest: true })) : [];
  sp.order = [...ordered, ...rest];
}

async function createSorted() {
  if (!sp.user || !sp.playlist) return;
  if (!sp.order) buildOrder();
  const uris = sp.order.map((o) => o.track.uri).filter((u) => u && u.startsWith("spotify:track:"));
  if (!uris.length) return toast(t("No track to add."), "error");
  const name = $("sp-name").value.trim() || `${sp.playlist.name} · ${t("intensity progression")}`;
  if (!confirm(t("Create the private playlist “{name}” ({n} tracks) on your Spotify account?", { name, n: uris.length }))) return;
  const btn = $("sp-create");
  btn.disabled = true;
  $("sp-result").textContent = t("Creating…");
  try {
    const created = await api.createPlaylist(sp.user.id, name, t("Ordered from calmest to most intense (Music Energy Analyzer) from “{name}”.", { name: sp.playlist.name }));
    await api.addTracks(created.id, uris);
    const url = created.external_urls?.spotify;
    $("sp-result").innerHTML = `${t("Playlist created: {n} tracks", { n: uris.length })}. ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${t("Open in Spotify")}</a>` : ""}`;
  } catch (err) {
    $("sp-result").textContent = "";
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------

function renderAll() {
  renderAccount();
  renderPlaylists();
  renderTracks();
  renderOrder();
  renderImported();
  renderDiff();
  renderInsights();
}

// ---------- genres ----------

/** Looks up the tracks still without genres on MusicBrainz (Spotify no longer gives any). */
async function fetchGenres() {
  const st = $("sp-genres-status");
  const btn = $("sp-genres");
  btn.disabled = true;
  st.textContent = t("Asking MusicBrainz (one track per second)…");
  const tick = setInterval(() => ctl.genreStatus().then((g) => { if (g.job) st.textContent = t("MusicBrainz… {d}/{n} tracks", { d: g.job.done, n: g.job.total }); }), 1000);
  try {
    const res = await ctl.fetchGenres();
    st.textContent = res.errors && !res.found
      ? t("MusicBrainz unreachable: check your connection, then try again.")
      : res.total ? tn(res.found, "Genres found for {n} track.", "Genres found for {n} tracks.") : t("Every analysed track already has genres. To look them all up again: “Refresh genres” in the library.");
    rematch();
  } catch (err) {
    st.textContent = t("Failed: {msg}", { msg: err.message });
  } finally {
    clearInterval(tick);
    btn.disabled = false;
  }
}

// ---------- imported playlists, changes since last import, map ----------

async function loadImported() {
  sp.imported = await ctl.importedPlaylists();
}

function renderImported() {
  const row = $("sp-imported-row");
  row.hidden = sp.imported.length < 1 || !sp.user;
  const opt = (p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${p.tracks.length} · ${new Date(p.importedAt).toLocaleDateString()})</option>`;
  $("sp-imported").innerHTML = sp.imported.map(opt).join("");
  if (sp.playlist) $("sp-imported").value = sp.playlist.id;
  const others = sp.imported.filter((p) => p.id !== sp.playlist?.id);
  $("sp-compare").innerHTML = `<option value="">—</option>` + others.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  if (others.some((p) => p.id === sp.compareId)) $("sp-compare").value = sp.compareId;
  else sp.compareId = "";
}

async function switchPlaylist() {
  const pl = sp.imported.find((p) => p.id === $("sp-imported").value);
  if (!pl || pl.id === sp.playlist?.id) return;
  sp.playlist = pl;
  sp.manual = {};
  sp.diff = null;
  sp.order = null;
  await ctl.spotifyStore.set("playlist", pl);
  await ctl.spotifyStore.set("matches", sp.manual);
  $("sp-name").value = `${pl.name} · ${t("intensity progression")}`;
  rematch();
}

async function forgetPlaylist() {
  const id = $("sp-imported").value;
  const pl = sp.imported.find((p) => p.id === id);
  if (!pl || !confirm(t("Forget the imported playlist “{name}”? (Its tracks' analyses are kept.)", { name: pl.name }))) return;
  await ctl.forgetPlaylist(id);
  if (sp.playlist?.id === id) {
    sp.playlist = null;
    await ctl.spotifyStore.set("playlist", null);
  }
  await loadImported();
  renderAll();
}

function renderDiff() {
  const box = $("sp-diff");
  const d = sp.diff;
  box.hidden = !d || (!d.added.length && !d.removed.length);
  if (box.hidden) return;
  const list = (arr) => arr.slice(0, 8).map((tk) => escapeHtml(tk.name)).join(", ") + (arr.length > 8 ? t(" and {n} more", { n: arr.length - 8 }) : "");
  box.innerHTML = `${t("Since the import of {d}:", { d: new Date(d.previousAt).toLocaleDateString() })}
    ${d.added.length ? `<b>+${d.added.length}</b> ${t("added")} (${list(d.added)})` : ""}
    ${d.added.length && d.removed.length ? " · " : ""}
    ${d.removed.length ? `<b>−${d.removed.length}</b> ${t("removed")} (${list(d.removed)})` : ""}
    ${d.added.length ? ` <button class="btn small" type="button" data-go-live>${t("Scan the new ones")}</button>` : ""}`;
}

function hitAt(e) {
  const r = $("sp-map").getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 10;
  for (const h of sp.hits) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

function renderInsights(withStats = true) {
  if (!sp.playlist || $("sp-work").hidden) return;
  const other = sp.imported.find((p) => p.id === sp.compareId) ?? null;
  const main = playlistPoints(sp.playlist);
  sp.hits = drawMap($("sp-map"), { main, other: other ? playlistPoints(other) : [] }, sp.hover);
  if (withStats) $("sp-compare-stats").innerHTML = compareHtml(playlistStats(sp.playlist), other ? playlistStats(other) : null);
}

function renderAccount() {
  const hasClient = !!auth.getClientId();
  const logged = auth.isLoggedIn();
  $("sp-config").hidden = logged;
  $("sp-login").hidden = logged;
  $("sp-login").disabled = !hasClient;
  $("sp-logout").hidden = !logged;
  $("sp-status").textContent = logged
    ? sp.user ? t("Connected: {name}", { name: sp.user.display_name ?? sp.user.id }) : t("Connected.")
    : hasClient ? t("Ready to log in.") : t("Enter your Spotify app's Client ID first.");
}

function renderPlaylists() {
  const box = $("sp-playlists");
  box.hidden = !sp.user;
  if (!sp.user) return;
  const sel = $("sp-playlist");
  const current = sel.value || sp.playlist?.id;
  const editable = sp.playlists.filter((p) => p.editable);
  const others = sp.playlists.filter((p) => !p.editable);
  sel.innerHTML = editable.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.count != null ? ` (${p.count})` : ""}</option>`).join("") +
    (others.length ? `<optgroup label="${t("Not readable (neither owner nor collaborator)")}">${others.map((p) => `<option value="${p.id}" disabled>${escapeHtml(p.name)} — ${escapeHtml(p.owner ?? "")}</option>`).join("")}</optgroup>` : "");
  if (current && editable.some((p) => p.id === current)) sel.value = current;
}

function renderTracks() {
  const work = $("sp-work");
  work.hidden = !sp.playlist;
  if (!sp.playlist) return;
  const records = [...state.records.values()];
  const tracks = sp.playlist.tracks;
  const matched = tracks.filter((t) => sp.matches.has(t.id));
  const analysed = matched.filter((t) => state.records.get(sp.matches.get(t.id).recordId)?.finalScore != null);
  $("sp-title").innerHTML = `${escapeHtml(sp.playlist.name)}${sp.playlist.url ? ` · <a href="${escapeHtml(sp.playlist.url)}" target="_blank" rel="noopener">${t("open in Spotify")}</a>` : ""}`;
  const captured = matched.filter((t) => state.records.get(sp.matches.get(t.id).recordId)?.source?.kind === "spotify").length;
  $("sp-summary").textContent = t("{n} tracks · {f} matched files · {c} captured live · {a} analysed", { n: tracks.length, f: matched.length - captured, c: captured, a: analysed.length });
  $("sp-tracks").innerHTML = tracks.map((tk, i) => {
    const m = sp.matches.get(tk.id);
    const rec = m ? state.records.get(m.recordId) : null;
    const cands = candidatesFor(tk, records, 8);
    if (rec && !cands.some((c) => c.id === rec.id)) cands.unshift({ id: rec.id, name: rec.name, score: m.score });
    const options = `<option value="">— ${t("no file")} —</option>` + cands.map((c) =>
      `<option value="${c.id}" ${rec?.id === c.id ? "selected" : ""}>${escapeHtml(c.name)} (${Math.round(c.score * 100)} %)</option>`).join("");
    return `<tr>
      <td class="num">${i + 1}</td>
      <td><div class="track-name">${tk.url ? `<a href="${escapeHtml(tk.url)}" target="_blank" rel="noopener">${escapeHtml(tk.name)}</a>` : escapeHtml(tk.name)}</div><div class="sp-artist">${escapeHtml(tk.artists.join(", "))}${tk.isLocal ? t(" · Spotify local file") : ""}</div></td>
      <td class="num hide-sm">${formatDuration(tk.durationMs / 1000)}</td>
      <td>${tk.isLocal ? `<span class="muted small">${t("not editable through the API")}</span>` : rec?.source?.kind === "spotify" ? `<span class="src-tag">${t("Captured live")} · ${rec.source.mode === "full" ? t("whole") : `${Math.round((rec.source.coverage ?? 0) * 100)} %`}</span>` : `<select data-track="${escapeHtml(tk.id)}" aria-label="${t("Local file for {name}", { name: escapeHtml(tk.name) })}">${options}</select>`}</td>
      <td class="num">${rec?.finalScore != null ? `<b>${formatScore(rec.finalScore)}</b>` : rec ? `<span class="sp-miss">${t("analysing…")}</span>` : `<span class="sp-miss">—</span>`}</td>
    </tr>`;
  }).join("");
}

function renderOrder() {
  const list = $("sp-order");
  if (!sp.order || !sp.playlist) {
    list.innerHTML = "";
    return;
  }
  let html = "", group = null, restShown = false;
  for (const o of sp.order) {
    if (o.group && o.group !== group) { group = o.group; html += `<li class="sp-order-group">${escapeHtml(group)}</li>`; }
    if (o.rest && !restShown) {
      restShown = true;
      const n = sp.order.filter((x) => x.rest).length;
      html += `<li class="sp-order-group rest">${t("Not analysed or without a matched file ({n}): added at the end in the original order", { n })}</li>`;
    }
    html += `<li>${escapeHtml(o.track.name)} <span class="muted">— ${escapeHtml(o.track.artists.join(", "))} · ${o.score != null ? `${formatScore(o.score)} · ${escapeHtml(o.stage)}` : t("not analysed")}</span></li>`;
  }
  list.innerHTML = html;
}
