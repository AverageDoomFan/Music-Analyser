// Account page, online parts: sign-in card, profile and friend code, friends,
// database search (tracks and users), leaderboards and other users' pages.
// stats.js draws the page (my listening, my library, duels) and calls these.
// Everything a user typed (names, track titles) is escaped before display.

import { state } from "../app/store.js";
import { t, tn } from "../i18n/index.js";
import { escapeHtml as esc } from "../util/format.js";
import { intensityColor } from "./live-draw.js";
import { toast } from "./toast.js";
import { cloudConfigured } from "../cloud/firebase.js";
import {
  acc, onAccount, isSignedIn, myUid, signIn, signUp, signInGoogle, resetPassword, signOut,
  createProfile, updateProfile, newFriendCode, deleteAccount,
} from "../cloud/account.js";
import { addFriend, removeFriend, friends as loadFriends, searchUsers, profileOf, libraryOf, board as loadBoard } from "../cloud/social.js";
import { search as searchTracks, usable } from "../cloud/tracks.js";
import { addShared, syncStatus, onSync } from "../cloud/sync.js";
import { showCode, heatFromCard } from "../cloud/pack.js";
import { dateKey } from "../games/daily.js";
import { parseDiagnostic, compactProfile } from "../stats/duel.js";

export const ac = {
  form: "signin",          // signed out: "signin" | "signup" | "reset"
  editing: false,          // profile form open
  busy: false,
  error: "",
  friends: null,           // [{ uid, name, profile }] once loaded
  duels: new Map(),        // uid → duel profile (or { missing: true })
  search: { kind: "tracks", q: "", results: null, busy: false },
  boards: { id: "daily", data: null, busy: false },
  user: null,              // { uid, profile, library } of the page shown
  showDelete: false,
};

let rerender = () => {};
/** stats.js gives its render function; account changes redraw the page. */
export function initAccountUi(render) {
  rerender = render;
  onAccount(() => {
    if (!isSignedIn()) { ac.friends = null; ac.duels.clear(); }
    else if (!ac.friends) refreshFriends();
    rerender();
  });
  onSync(() => { if (document.querySelector(".ac-sync")) updateSyncLine(); });
}

async function refreshFriends() {
  try {
    ac.friends = await loadFriends();
  } catch (err) {
    console.warn(err);
    ac.friends = [];
  }
  rerender();
}

const initial = (name) => (String(name ?? "").trim()[0] ?? "?").toUpperCase();
const avatar = (name, cls = "") => `<span class="ac-av ${cls}" aria-hidden="true">${esc(initial(name))}</span>`;
const pill = (v) => (v == null ? `<span class="st-pill st-pill-none">—</span>` : `<span class="st-pill" style="--c:${intensityColor(v)}">${Math.round(v)}</span>`);

// ------------------------------------------------------------------ header card

/** The account card at the top of the page. */
export function accountCard() {
  if (!cloudConfigured()) {
    return `<div class="ac-card ac-off">
      ${avatar("?")}
      <div><b>${t("Offline mode")}</b><p class="st-muted small">${t("Online accounts are not set up on this copy of the app: everything stays in this browser.")}</p></div>
    </div>`;
  }
  if (acc.status === "loading") return `<div class="ac-card"><span class="ac-spin" aria-hidden="true"></span><span class="st-muted">${t("Connecting…")}</span></div>`;
  if (acc.status === "error") {
    return `<div class="ac-card ac-off">${avatar("!")}<div><b>${t("Online features unavailable")}</b><p class="st-muted small">${esc(acc.error)}</p></div></div>`;
  }
  if (acc.status === "signed-out") return signInCard();
  if (acc.status === "needs-profile") return profileSetupCard();
  const p = acc.profile;
  return `<div class="ac-card ac-me">
    ${avatar(p.name, "lg")}
    <div class="ac-who">
      <div class="ac-name"><b>${esc(p.name)}</b> <span class="ac-badge ${p.public ? "pub" : "priv"}">${p.public ? t("Public") : t("Private")}</span></div>
      <div class="st-muted small">${esc(acc.user?.email ?? "")} · <span class="ac-sync">${syncLine()}</span></div>
    </div>
    <div class="ac-code" title="${esc(t("Give this code to a friend: they type it to add you."))}">
      <span class="st-muted small">${t("Friend code")}</span>
      <button type="button" class="ac-code-val" data-st="ac-copy-code">${esc(showCode(acc.code) || "—")}</button>
    </div>
    <div class="ac-actions">
      <button type="button" class="btn small" data-st="ac-edit" aria-expanded="${ac.editing}">${t("Edit")}</button>
      <button type="button" class="btn small ghost" data-st="ac-signout">${t("Sign out")}</button>
    </div>
    ${ac.editing ? editPanel() : ""}
  </div>`;
}

function syncLine() {
  if (syncStatus.busy) return t("syncing…");
  if (syncStatus.error) return `<span class="ac-warn">${esc(t("last sync failed"))}</span>`;
  return syncStatus.last ? t("synced") : t("signed in");
}
function updateSyncLine() {
  for (const el of document.querySelectorAll(".ac-sync")) el.innerHTML = syncLine();
}

function signInCard() {
  const f = ac.form;
  const title = f === "signup" ? t("Create an account") : f === "reset" ? t("Reset your password") : t("Sign in");
  return `<form class="ac-card ac-auth" data-form="${f}" novalidate>
    <div class="ac-auth-text">
      <b>${title}</b>
      <p class="st-muted small">${t("Your account shares analyses (no need to analyse a track someone already did), keeps your library and listening online, and unlocks friends, duels and leaderboards.")}</p>
    </div>
    <div class="ac-fields">
      <input type="email" name="email" autocomplete="email" placeholder="${esc(t("Email"))}" aria-label="${esc(t("Email"))}" required>
      ${f === "reset" ? "" : `<input type="password" name="password" autocomplete="${f === "signup" ? "new-password" : "current-password"}" placeholder="${esc(t(f === "signup" ? "Password (8+ characters)" : "Password"))}" aria-label="${esc(t("Password"))}" minlength="${f === "signup" ? 8 : 1}" required>`}
      <button class="btn primary" type="submit" ${ac.busy ? "disabled" : ""}>${f === "signup" ? t("Create the account") : f === "reset" ? t("Send the link") : t("Sign in")}</button>
      ${f === "reset" ? "" : `<button class="btn" type="button" data-st="ac-google" ${ac.busy ? "disabled" : ""}><span class="ac-g" aria-hidden="true">G</span>${t("Continue with Google")}</button>`}
    </div>
    ${ac.error ? `<p class="ac-error" role="alert">${esc(ac.error)}</p>` : ""}
    <div class="ac-switch small">
      ${f !== "signin" ? `<button type="button" class="linklike" data-st="ac-form" data-form="signin">${t("I have an account")}</button>` : `<button type="button" class="linklike" data-st="ac-form" data-form="signup">${t("Create an account")}</button>`}
      ${f === "signin" ? `<button type="button" class="linklike" data-st="ac-form" data-form="reset">${t("Forgot your password?")}</button>` : ""}
    </div>
  </form>`;
}

const privacyNote = () => `<p class="st-muted small ac-privacy">${t("Stored online: your name, the public / private choice, the Spotify ids and scores of your library, your listening log (only you can read it), your votes (only the mean is shown) and your best game scores. Your email stays in the sign-in service, never on your page. Audio never leaves your computer. You can delete everything from this page.")}</p>`;

function profileSetupCard() {
  return `<form class="ac-card ac-auth" data-form="profile" novalidate>
    <div class="ac-auth-text">
      <b>${t("Choose how others see you")}</b>
      <p class="st-muted small">${t("Signed in as {email}. One last step: your name and whether your page is public.", { email: esc(acc.user?.email ?? "") })}</p>
    </div>
    <div class="ac-fields">
      <input type="text" name="name" maxlength="30" autocomplete="nickname" placeholder="${esc(t("Display name"))}" aria-label="${esc(t("Display name"))}" value="${esc(acc.user?.name ?? "")}" required>
      <label class="inline small"><input type="checkbox" name="public" checked> ${t("Public account: anyone can find my page; my name shows in the leaderboards")}</label>
      <button class="btn primary" type="submit" ${ac.busy ? "disabled" : ""}>${t("Create my profile")}</button>
      <button class="btn ghost" type="button" data-st="ac-signout">${t("Sign out")}</button>
    </div>
    ${ac.error ? `<p class="ac-error" role="alert">${esc(ac.error)}</p>` : ""}
    ${privacyNote()}
  </form>`;
}

function editPanel() {
  const p = acc.profile;
  const google = acc.user?.provider === "google.com";
  return `<form class="ac-edit" data-form="edit" novalidate>
    <label>${t("Display name")} <input type="text" name="name" maxlength="30" value="${esc(p.name)}" required></label>
    <label class="inline"><input type="checkbox" name="public" ${p.public ? "checked" : ""}> ${t("Public account")}</label>
    <p class="st-muted small">${t("Public: anyone can find your page (name, library and listening summaries) and your name shows in the leaderboards. Private: only your friends see your page; leaderboards say “private user”.")}</p>
    <div class="ac-row">
      <button class="btn primary small" type="submit">${t("Save")}</button>
      <button class="btn small" type="button" data-st="ac-new-code">${t("New friend code")}</button>
    </div>
    ${privacyNote()}
    <details class="ac-danger" ${ac.showDelete ? "open" : ""}>
      <summary>${t("Delete my account")}</summary>
      <p class="small">${t("Deletes your profile, library, listening log, votes, friendships and leaderboard entries, then the account. Shared track analyses stay, without your name. Your local data in this browser is kept.")}</p>
      <div class="ac-row">
        ${google ? "" : `<input type="password" name="confirm" autocomplete="current-password" placeholder="${esc(t("Password"))}" aria-label="${esc(t("Password"))}">`}
        <button class="btn danger small" type="button" data-st="ac-delete">${t("Delete everything")}</button>
      </div>
    </details>
  </form>`;
}

// ------------------------------------------------------------------ events

/** Click on a [data-st] element whose action starts with "ac-". Returns true when handled. */
export async function onAccountClick(a, el) {
  if (!a.startsWith("ac-")) return false;
  const run = async (fn) => {
    ac.busy = true;
    ac.error = "";
    rerender();
    try {
      await fn();
    } catch (err) {
      ac.error = err.message;
      toast(err.message, "error");
    } finally {
      ac.busy = false;
      rerender();
    }
  };
  switch (a) {
    case "ac-form": ac.form = el.dataset.form; ac.error = ""; rerender(); break;
    case "ac-google": await run(() => signInGoogle()); break;
    case "ac-signout": await signOut(); ac.editing = false; break;
    case "ac-edit": ac.editing = !ac.editing; rerender(); break;
    case "ac-copy-code":
      try {
        await navigator.clipboard.writeText(showCode(acc.code));
        toast(t("Friend code copied."));
      } catch {
        prompt(t("Your friend code:"), showCode(acc.code));
      }
      break;
    case "ac-new-code":
      if (!confirm(t("Make a new friend code? The old one stops working; your friends stay friends."))) break;
      await run(async () => { await newFriendCode(); toast(t("New friend code ready.")); });
      break;
    case "ac-delete": {
      if (!confirm(t("Delete your online account and everything stored with it? This cannot be undone."))) break;
      const pwd = el.closest("form")?.querySelector("[name=confirm]")?.value ?? "";
      await run(async () => {
        await deleteAccount({ password: pwd, onProgress: (msg) => toast(msg) });
        ac.editing = false;
        toast(t("Account deleted."));
      });
      break;
    }
    case "ac-add-friend": {
      const input = document.getElementById("ac-friend-code");
      await run(async () => {
        const p = await addFriend(input?.value);
        toast(t("{name} is now your friend.", { name: p?.name ?? "?" }));
        await refreshFriends();
      });
      break;
    }
    case "ac-unfriend": {
      const f = ac.friends?.find((x) => x.uid === el.dataset.uid);
      if (!f || !confirm(t("Remove {name} from your friends?", { name: f.name }))) break;
      await run(async () => { await removeFriend(f.uid); ac.duels.delete(f.uid); await refreshFriends(); });
      break;
    }
    case "ac-search-kind": ac.search.kind = el.dataset.kind; ac.search.results = null; rerender(); break;
    case "ac-add-track": {
      const hit = ac.search.results?.find((x) => x.id === el.dataset.id);
      if (!hit) break;
      await run(async () => {
        const rec = await addShared(hit);
        toast(t("“{name}” added to your library, without analysing.", { name: rec.name }));
      });
      break;
    }
    case "ac-open-track": document.dispatchEvent(new CustomEvent("open-detail", { detail: el.dataset.id })); break;
    case "ac-board": ac.boards.id = el.dataset.board; ac.boards.data = null; rerender(); break;
    case "ac-user": await openUser(el.dataset.uid); break;
    case "ac-refresh-friends": await refreshFriends(); break;
    default: return false;
  }
  return true;
}

/** Form submits (sign-in, sign-up, reset, profile, search, add friend). */
export async function onAccountSubmit(form) {
  const kind = form.dataset.form;
  const v = (n) => form.querySelector(`[name=${n}]`)?.value ?? "";
  const checked = (n) => !!form.querySelector(`[name=${n}]`)?.checked;
  ac.error = "";
  try {
    ac.busy = true;
    if (kind === "signin") await signIn(v("email"), v("password"));
    else if (kind === "signup") await signUp(v("email"), v("password"));
    else if (kind === "reset") {
      await resetPassword(v("email"));
      toast(t("Check your inbox: a link to choose a new password is on its way."));
      ac.form = "signin";
    } else if (kind === "profile") await createProfile({ name: v("name"), isPublic: checked("public") });
    else if (kind === "edit") {
      await updateProfile({ name: v("name"), isPublic: checked("public") });
      ac.editing = false;
      toast(t("Profile saved."));
    } else if (kind === "search") {
      ac.search.q = v("q");
      ac.search.busy = true;
      ac.busy = false;
      rerender();
      ac.search.results = ac.search.kind === "users" ? await searchUsers(ac.search.q) : await searchTracks(ac.search.q);
      ac.search.busy = false;
    } else if (kind === "friend") {
      ac.busy = false;
      return onAccountClick("ac-add-friend", form);
    }
  } catch (err) {
    ac.error = err.message;
    ac.search.busy = false;
    if (kind === "search" || kind === "edit") toast(err.message, "error");
  } finally {
    ac.busy = false;
    rerender();
  }
}

// ------------------------------------------------------------------ views

const needSignIn = (what) => `<div class="st-card st-empty"><h3>${t("Sign in first")}</h3><p>${esc(what)}</p></div>`;

/** Database search view: tracks (shared analyses) or users (public accounts). */
export function searchView() {
  if (!cloudConfigured()) return offlineView();
  if (!isSignedIn()) return needSignIn(t("The shared database and the user search need an account."));
  const s = ac.search;
  const kinds = [["tracks", t("Tracks")], ["users", t("People")]];
  let results = "";
  if (s.busy) results = `<p class="st-muted">${t("Searching…")}</p>`;
  else if (s.results && !s.results.length) results = `<p class="st-muted">${s.kind === "users" ? t("No public account with this name.") : t("No shared track matches: words must be whole (e.g. “rip tear”).")}</p>`;
  else if (s.results && s.kind === "tracks") results = trackResults(s.results);
  else if (s.results) results = userResults(s.results);
  return `<form class="st-card ac-search" data-form="search" role="search">
      <div class="st-seg segmented small" role="group" aria-label="${esc(t("Search in"))}">
        ${kinds.map(([k, label]) => `<button type="button" data-st="ac-search-kind" data-kind="${k}" aria-pressed="${s.kind === k}">${label}</button>`).join("")}
      </div>
      <input type="search" name="q" value="${esc(s.q)}" placeholder="${esc(s.kind === "users" ? t("Start of a name") : t("Title or artist"))}" aria-label="${esc(t("Search"))}" autocomplete="off">
      <button class="btn primary" type="submit">${t("Search")}</button>
    </form>
    <p class="st-muted small ac-hint">${s.kind === "users" ? t("Only public accounts can be found. Add a private friend with their friend code (Friend duel).") : t("Every track analysed by someone, with its community score. Add one to your library: no analysis needed.")}</p>
    ${results}`;
}

function trackResults(list) {
  return `<article class="st-card"><ol class="ac-results">${list.map((x) => {
    const local = state.records.get(`spotify:${x.id}`);
    const score = x.mean ?? x.s;
    return `<li>
      ${pill(score)}
      <div class="ac-res-main">
        <b>${esc(x.t)}</b> <span class="st-muted">${esc(x.a)}</span>
        <span class="st-muted small">${x.vc ? tn(x.vc, "{n} vote", "{n} votes") : t("automatic score")}${x.bpm ? ` · ${Math.round(x.bpm)} BPM` : ""}${x.key ? ` · ${esc(x.key)}` : ""} · ${t("extractor v{v}", { v: esc(x.v) })}</span>
      </div>
      ${local?.finalScore != null
        ? `<button type="button" class="btn small ghost" data-st="ac-open-track" data-id="${esc(local.id)}">${t("In your library")}</button>`
        : !usable(x)
          ? `<span class="st-muted small" title="${esc(t("Analysed with another extractor version: analyse it again from a playlist to share the new version."))}">${t("older version")}</span>`
          : `<button type="button" class="btn small" data-st="ac-add-track" data-id="${esc(x.id)}">${t("Add to library")}</button>`}
    </li>`;
  }).join("")}</ol></article>`;
}

function userResults(list) {
  return `<article class="st-card"><ol class="ac-results">${list.map((u) => `
    <li>
      ${avatar(u.name)}
      <div class="ac-res-main"><b>${esc(u.name)}</b><span class="st-muted small">${u.lib?.count ? tn(u.lib.count, "{n} track", "{n} tracks") : t("no library yet")}${u.lib?.avg != null ? ` · ${t("average {n}", { n: Math.round(u.lib.avg) })}` : ""}</span></div>
      <button type="button" class="btn small" data-st="ac-user" data-uid="${esc(u.uid)}">${t("See the page")}</button>
    </li>`).join("")}</ol></article>`;
}

// ---------- leaderboards ----------

const BOARD_LIST = () => [
  ["today", t("Today's track"), t("points"), null],
  ["daily", t("Daily track"), t("total points"), t("best streak")],
  ["trivia", t("Guess the score"), t("total points"), t("best streak")],
  ["compare", t("Which is harder?"), t("agreements"), t("duels")],
  ["hunt", t("Find this score"), t("bullseyes"), t("hunts")],
];

/** Public leaderboards of every game (names of private accounts hidden). */
export function boardsView() {
  if (!cloudConfigured()) return offlineView();
  const b = ac.boards;
  const spec = BOARD_LIST().find((x) => x[0] === b.id) ?? BOARD_LIST()[0];
  if (!b.data && !b.busy) {
    b.busy = true;
    const id = spec[0] === "today" ? `day-${dateKey()}` : spec[0];
    loadBoard(id).then((d) => { b.data = d; }).catch((err) => { b.data = { error: err.message }; }).finally(() => { b.busy = false; rerender(); });
  }
  const row = (r) => `<li class="${r.me ? "me" : ""}">
      <span class="rank">${r.rank ?? "—"}</span>
      ${r.private && !r.me ? `<span class="ac-av priv" aria-hidden="true">?</span><span class="nm st-muted">${t("private user")}</span>`
        : `${avatar(r.name)}<button type="button" class="st-link nm" data-st="ac-user" data-uid="${esc(r.uid)}">${esc(r.name)}${r.me ? ` <small>(${t("you")})</small>` : ""}</button>`}
      <b class="v">${Math.round(r.v).toLocaleString()}</b>
      ${spec[3] ? `<span class="x st-muted small">${r.x != null ? `${Math.round(r.x)} ${esc(spec[3])}` : ""}</span>` : ""}
    </li>`;
  const d = b.data;
  return `<div class="st-seg segmented small ac-board-tabs" role="group" aria-label="${esc(t("Game"))}">
      ${BOARD_LIST().map(([k, label]) => `<button type="button" data-st="ac-board" data-board="${k}" aria-pressed="${k === spec[0]}">${label}</button>`).join("")}
    </div>
    <article class="st-card ac-board">
      <header class="st-card-head"><h3>${esc(spec[1])}</h3><span class="st-muted small">${esc(spec[2])}${spec[0] === "today" ? ` · ${dateKey()}` : ""}</span></header>
      ${!d ? `<p class="st-muted">${t("Loading…")}</p>`
        : d.error ? `<p class="ac-error">${esc(d.error)}</p>`
        : !d.rows.length ? `<p class="st-muted">${t("Nobody yet: play this game to open the board.")}</p>`
        : `<ol class="ac-rank">${d.rows.map(row).join("")}${d.mine ? `<li class="gap">…</li>${row(d.mine)}` : ""}</ol>`}
      ${isSignedIn() ? "" : `<p class="st-muted small">${t("Sign in to appear here: your game scores are posted as you play.")}</p>`}
    </article>`;
}

// ---------- someone's page ----------

async function openUser(uid) {
  if (!uid) return;
  if (uid === myUid()) {
    document.querySelector('[data-st="view"][data-view="library"]')?.click();
    return;
  }
  ac.user = { uid, loading: true };
  document.dispatchEvent(new CustomEvent("account-view", { detail: "user" }));
  const [profile, library] = await Promise.all([profileOf(uid), libraryOf(uid)]);
  if (ac.user?.uid !== uid) return;
  ac.user = { uid, profile, library, loading: false };
  if (library?.duel) ac.duels.set(uid, duelProfile(library.duel));
  rerender();
}

/**
 * Another user's page: their library and listening summaries (drawn by
 * stats.js from the cards), a duel when their library is readable.
 * `draw` = { library(card), heatmap(bins), kpis(list) } from stats.js.
 */
export function userView(draw) {
  const u = ac.user;
  if (!u) return `<div class="st-card st-empty"><p>${t("Pick someone in the search, a leaderboard or your friends.")}</p></div>`;
  if (u.loading) return `<div class="st-card st-empty"><p>${t("Loading…")}</p></div>`;
  if (!u.profile) return `<div class="st-card st-empty"><h3>${t("Private account")}</h3><p>${t("This page is private: only this person's friends can see it.")}</p></div>`;
  const p = u.profile;
  const lis = p.lis;
  const friend = ac.friends?.some((f) => f.uid === u.uid);
  const since = p.createdAt?.toDate ? p.createdAt.toDate().toLocaleDateString() : "";
  const heat = heatFromCard(lis);
  return `<article class="st-card ac-user-head">
      ${avatar(p.name, "xl")}
      <div>
        <h3>${esc(p.name)} <span class="ac-badge ${p.public ? "pub" : "priv"}">${p.public ? t("Public") : t("Private")}</span>${friend ? ` <span class="ac-badge friend">${t("Friend")}</span>` : ""}</h3>
        <p class="st-muted small">${since ? t("Member since {d}", { d: esc(since) }) : ""}</p>
      </div>
      <span class="spacer"></span>
      ${ac.duels.get(u.uid)?.tracks?.length ? `<button type="button" class="btn primary" data-st="ac-duel" data-uid="${esc(u.uid)}">${t("Duel")}</button>` : ""}
    </article>
    ${lis ? draw.kpis([
      [t("Listening time"), draw.minutes(lis.minutes), tn(lis.listens, "{n} listen", "{n} listens")],
      [t("Different tracks"), String(lis.uniqueTracks), tn(lis.activeDays, "on {n} day", "on {n} days")],
      [t("Average intensity"), lis.avg == null ? "—" : String(Math.round(lis.avg)), draw.stage(lis.avg), lis.avg],
      [t("Longest streak"), tn(lis.streak, "{n} day", "{n} days"), t("in a row with music")],
    ]) : ""}
    ${p.lib ? draw.library(p.lib) : `<div class="st-card st-empty"><p>${t("No library shared yet.")}</p></div>`}
    ${heat ? `<div class="st-grid-1">${draw.heatmap(heat)}</div>` : ""}`;
}

// ---------- friends in the duel view ----------

/** Duel profile from a shared library's duel data. */
function duelProfile(duel) {
  try {
    return compactProfile(parseDiagnostic({ app: "mea-diagnostic", ...duel }));
  } catch {
    return { tracks: [] };
  }
}

/** My online friends, for the duel's friend list: [{ id: "u:uid", uid, name, online: true }]. */
export function onlineFriends() {
  return (ac.friends ?? []).map((f) => ({ id: `u:${f.uid}`, uid: f.uid, name: f.name, online: true, tracks: ac.duels.get(f.uid)?.tracks?.length ? ac.duels.get(f.uid).tracks : null }));
}

/** A friend's duel profile, loaded once (null when they share no library). */
export async function friendDuel(uid) {
  const cached = ac.duels.get(uid);
  // "nothing shared yet" is checked again after a minute
  if (!cached || (cached.missing && Date.now() - cached.at > 60e3)) {
    const lib = await libraryOf(uid);
    ac.duels.set(uid, lib?.duel ? duelProfile(lib.duel) : { missing: true, tracks: [], at: Date.now() });
  }
  const d = ac.duels.get(uid);
  return d.missing ? null : d;
}

/** "Add a friend" card of the duel view (signed in) or a sign-in hint. */
export function friendCodeCard() {
  if (!cloudConfigured()) return "";
  if (!isSignedIn()) {
    return `<article class="st-card ac-friend-card"><div><h3>${t("Friends online")}</h3><p class="st-muted small">${t("Sign in to add friends with a code: their profile updates by itself, no file to swap.")}</p></div></article>`;
  }
  return `<form class="st-card ac-friend-card" data-form="friend">
    <div>
      <h3>${t("Add a friend")}</h3>
      <p class="st-muted small">${t("Type their friend code. Yours: {code} (click to copy).", { code: `<button type="button" class="linklike ac-code-inline" data-st="ac-copy-code">${esc(showCode(acc.code))}</button>` })}</p>
    </div>
    <div class="ac-row">
      <input id="ac-friend-code" name="code" type="text" maxlength="9" autocomplete="off" spellcheck="false" placeholder="ABCD-EFGH" aria-label="${esc(t("Friend code"))}">
      <button class="btn primary" type="submit">${t("Add")}</button>
    </div>
  </form>`;
}

function offlineView() {
  return `<div class="st-card st-empty"><h3>${t("Offline mode")}</h3><p>${t("Online accounts are not set up on this copy of the app: everything stays in this browser.")}</p></div>`;
}

export { esc };
