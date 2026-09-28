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

const $ = (id) => document.getElementById(id);

const sp = {
  user: null,          // { id, display_name }
  playlists: [],
  playlist: null,      // { id, name, url, tracks: [...] , importedAt }
  manual: {},          // trackId → recordId | null
  matches: new Map(),
  order: null,
};

export async function initSpotify() {
  $("sp-redirect").textContent = auth.redirectUri();
  $("sp-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(auth.redirectUri());
      toast("Adresse copiée.");
    } catch {
      toast(auth.redirectUri());
    }
  });
  $("sp-client").value = auth.getClientId();
  $("sp-save-client").addEventListener("click", () => {
    try {
      auth.setClientId($("sp-client").value);
      toast("Client ID enregistré.");
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
    if (!confirm("Déconnecter Spotify et effacer la playlist importée et les associations enregistrées dans ce navigateur ?")) return;
    auth.logout();
    await ctl.spotifyStore.clear();
    Object.assign(sp, { user: null, playlists: [], playlist: null, manual: {}, matches: new Map(), order: null });
    renderAll();
    toast("Déconnecté. Pense aussi à retirer l'accès sur spotify.com/account/apps si tu n'utilises plus l'application.");
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
  $("sp-create").addEventListener("click", createSorted);
  $("sp-go-live").addEventListener("click", () => $("tab-live").click());

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
      toast(res.ok ? "Compte Spotify connecté." : res.error, res.ok ? "info" : "error");
    }
  } catch (err) {
    toast(`Connexion Spotify : ${err.message}`, "error");
  }
  sp.playlist = await ctl.spotifyStore.get("playlist").catch(() => null) ?? null;
  sp.manual = await ctl.spotifyStore.get("matches").catch(() => null) ?? {};
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
  $("sp-import-status").textContent = "Import…";
  try {
    const info = sp.playlists.find((p) => p.id === id) ?? {};
    const tracks = await api.playlistTracks(id);
    sp.playlist = { id, name: info.name ?? "Playlist", url: info.url ?? null, tracks, importedAt: Date.now() };
    if (sp.playlist.id !== (await ctl.spotifyStore.get("playlist"))?.id) sp.manual = {};
    await ctl.spotifyStore.set("playlist", sp.playlist);
    await ctl.spotifyStore.set("matches", sp.manual);
    $("sp-import-status").textContent = `${tracks.length} titres importés.`;
    $("sp-name").value = `${sp.playlist.name} · progression d'intensité`;
    sp.order = null;
    rematch();
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
  const ordered = ctl.orderRecords([...byRecord.keys()]).steps.map((s) => ({ track: byRecord.get(s.id), score: s.score, stage: s.stage }));
  const rest = $("sp-unmatched").value === "end" ? tracks.filter((t) => ![...byRecord.values()].includes(t)).map((track) => ({ track, score: null })) : [];
  sp.order = [...ordered, ...rest];
}

async function createSorted() {
  if (!sp.user || !sp.playlist) return;
  if (!sp.order) buildOrder();
  const uris = sp.order.map((o) => o.track.uri).filter((u) => u && u.startsWith("spotify:track:"));
  if (!uris.length) return toast("Aucun titre à ajouter.", "error");
  const name = $("sp-name").value.trim() || `${sp.playlist.name} · progression d'intensité`;
  if (!confirm(`Créer la playlist privée « ${name} » (${uris.length} titres) sur ton compte Spotify ?`)) return;
  const btn = $("sp-create");
  btn.disabled = true;
  $("sp-result").textContent = "Création…";
  try {
    const created = await api.createPlaylist(sp.user.id, name, `Ordonnée du plus calme au plus intense (Music Energy Analyzer) à partir de « ${sp.playlist.name} ».`);
    await api.addTracks(created.id, uris);
    const url = created.external_urls?.spotify;
    $("sp-result").innerHTML = `Playlist créée : ${uris.length} titres. ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Ouvrir dans Spotify</a>` : ""}`;
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
}

function renderAccount() {
  const hasClient = !!auth.getClientId();
  const logged = auth.isLoggedIn();
  $("sp-config").hidden = logged;
  $("sp-login").hidden = logged;
  $("sp-login").disabled = !hasClient;
  $("sp-logout").hidden = !logged;
  $("sp-status").textContent = logged
    ? sp.user ? `Connecté : ${sp.user.display_name ?? sp.user.id}` : "Connecté."
    : hasClient ? "Prêt à se connecter." : "Renseigne d'abord le Client ID de ton application Spotify.";
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
    (others.length ? `<optgroup label="Non lisibles (ni propriétaire ni collaborateur)">${others.map((p) => `<option value="${p.id}" disabled>${escapeHtml(p.name)} — ${escapeHtml(p.owner ?? "")}</option>`).join("")}</optgroup>` : "");
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
  $("sp-title").innerHTML = `${escapeHtml(sp.playlist.name)}${sp.playlist.url ? ` · <a href="${escapeHtml(sp.playlist.url)}" target="_blank" rel="noopener">ouvrir dans Spotify</a>` : ""}`;
  const captured = matched.filter((t) => state.records.get(sp.matches.get(t.id).recordId)?.source?.kind === "spotify").length;
  $("sp-summary").textContent = `${tracks.length} titres · ${matched.length - captured} fichiers associés · ${captured} captés en direct · ${analysed.length} analysés`;
  $("sp-tracks").innerHTML = tracks.map((t, i) => {
    const m = sp.matches.get(t.id);
    const rec = m ? state.records.get(m.recordId) : null;
    const cands = candidatesFor(t, records, 8);
    if (rec && !cands.some((c) => c.id === rec.id)) cands.unshift({ id: rec.id, name: rec.name, score: m.score });
    const options = `<option value="">— aucun fichier —</option>` + cands.map((c) =>
      `<option value="${c.id}" ${rec?.id === c.id ? "selected" : ""}>${escapeHtml(c.name)} (${Math.round(c.score * 100)} %)</option>`).join("");
    return `<tr>
      <td class="num">${i + 1}</td>
      <td><div class="track-name">${t.url ? `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.name)}</a>` : escapeHtml(t.name)}</div><div class="sp-artist">${escapeHtml(t.artists.join(", "))}${t.isLocal ? " · fichier local Spotify" : ""}</div></td>
      <td class="num hide-sm">${formatDuration(t.durationMs / 1000)}</td>
      <td>${t.isLocal ? `<span class="muted small">non modifiable via l'API</span>` : rec?.source?.kind === "spotify" ? `<span class="src-tag">Capté en direct · ${rec.source.mode === "full" ? "entier" : `${Math.round((rec.source.coverage ?? 0) * 100)} %`}</span>` : `<select data-track="${escapeHtml(t.id)}" aria-label="Fichier local pour ${escapeHtml(t.name)}">${options}</select>`}</td>
      <td class="num">${rec?.finalScore != null ? `<b>${formatScore(rec.finalScore)}</b>` : rec ? `<span class="sp-miss">analyse…</span>` : `<span class="sp-miss">—</span>`}</td>
    </tr>`;
  }).join("");
}

function renderOrder() {
  const list = $("sp-order");
  if (!sp.order || !sp.playlist) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = sp.order.map((o) => `<li>${escapeHtml(o.track.name)} <span class="muted">— ${escapeHtml(o.track.artists.join(", "))} · ${o.score != null ? `${formatScore(o.score)} · ${escapeHtml(o.stage)}` : "non analysé"}</span></li>`).join("");
}
