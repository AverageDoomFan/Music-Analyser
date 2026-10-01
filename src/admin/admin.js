// Admin panel (admin.html). Only for accounts with the admin role: the role is
// a document admins/{uid} created by hand in the Firebase console, and the
// Firestore rules refuse every cross-user read to anyone else. The checks in
// this file only decide what to show; the rules are what keep the data safe.

import { t, tn, translateDom } from "../i18n/index.js";
import { escapeHtml, formatDate } from "../util/format.js";
import { cloudConfigured, loadCloud, currentUser, isAdmin, signIn, signOut } from "../cloud/firebase.js";
import { fromCloud, fromFile, mergeDatasets, overview, userStats, disputedTracks, modelVerdict } from "./aggregate.js";

const $ = (id) => document.getElementById(id);
const LIMITS = { duels: 10000, reports: 1000 };
const ROWS = 300;

const st = {
  cloud: null,     // dataset read from Firestore
  files: [],       // [{ label, ds }]
  ds: mergeDatasets([]),
  view: "overview",
  user: "all",
  search: "",
};

init();

async function init() {
  translateDom();
  $("adm-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (!b) return;
    st.view = b.dataset.view;
    for (const x of $("adm-tabs").querySelectorAll("[data-view]")) x.setAttribute("aria-selected", String(x === b));
    render();
  });
  $("adm-user").addEventListener("change", (e) => { st.user = e.target.value; render(); });
  $("adm-search").addEventListener("input", (e) => { st.search = e.target.value.trim().toLowerCase(); render(); });
  $("adm-reload").addEventListener("click", () => loadFromCloud().catch(showError));
  $("adm-files").addEventListener("change", (e) => addFiles(e.target.files).finally(() => { e.target.value = ""; }));
  $("adm-export").addEventListener("click", exportDataset);
  $("adm-view").addEventListener("click", onViewClick);
  await gate();
}

// ------------------------------------------------------------------ access

async function gate() {
  const box = $("adm-gate");
  $("adm-app").hidden = true;
  if (!cloudConfigured()) {
    box.innerHTML = `<div class="card adm-gate"><h2>${t("Cloud not set up")}</h2>
      <p>${t("This copy of the app has no Firebase project, so there are no accounts and no admin role. Follow FIREBASE.md to create the project, then come back.")}</p></div>`;
    return;
  }
  let user;
  try {
    user = await currentUser();
  } catch (err) {
    box.innerHTML = `<div class="card adm-gate"><p class="notice">${escapeHtml(t("Cannot reach Firebase: {msg}", { msg: err.message }))}</p></div>`;
    return;
  }
  renderAccount(user);
  if (!user) {
    box.innerHTML = `<div class="card adm-gate"><h2>${t("Admins only")}</h2><p>${t("Sign in with an admin account.")}</p>
      <button class="btn primary" id="adm-signin" type="button">${t("Sign in with Google")}</button></div>`;
    $("adm-signin").addEventListener("click", async () => {
      try { await signIn(); } catch (err) { return showError(err); }
      gate();
    });
    return;
  }
  if (!(await isAdmin())) {
    box.innerHTML = `<div class="card adm-gate"><h2>${t("Access denied")}</h2>
      <p>${t("This account does not have the admin role.")}</p>
      <p class="muted small">${t("To make it an admin, the project owner creates the document admins/{uid} in the Firebase console (Firestore). uid of this account:", { uid: "&lt;uid&gt;" })} <code>${escapeHtml(user.uid)}</code></p></div>`;
    return;
  }
  box.innerHTML = "";
  $("adm-app").hidden = false;
  await loadFromCloud().catch(showError);
}

function renderAccount(user) {
  const box = $("adm-account");
  if (!user) { box.innerHTML = ""; return; }
  box.innerHTML = `<span>${escapeHtml(user.displayName || user.email || user.uid)}</span>
    <button class="btn small" id="adm-signout" type="button">${t("Sign out")}</button>
    <a class="btn small ghost" href="index.html">${t("Back to the app")}</a>`;
  $("adm-signout").addEventListener("click", async () => { await signOut(); location.reload(); });
}

// ------------------------------------------------------------------ data

async function loadFromCloud() {
  const { db, F } = await loadCloud();
  $("adm-sources").textContent = t("Loading…");
  const owner = (snap) => snap.ref.parent.parent?.id ?? "?";
  const [users, duels, reports] = await Promise.all([
    F.getDocs(F.collection(db, "users")),
    F.getDocs(F.query(F.collectionGroup(db, "duels"), F.limit(LIMITS.duels))),
    F.getDocs(F.query(F.collectionGroup(db, "reports"), F.limit(LIMITS.reports))),
  ]);
  st.cloud = fromCloud({
    users: users.docs.map((d) => ({ id: d.id, ...d.data() })),
    duels: duels.docs.map((d) => ({ user: owner(d), ...d.data() })),
    reports: reports.docs.map((d) => ({ user: owner(d), ...d.data() })),
  });
  st.cloudCapped = duels.size >= LIMITS.duels || reports.size >= LIMITS.reports;
  rebuild();
}

async function addFiles(files) {
  for (const file of files) {
    try {
      st.files = st.files.filter((f) => f.label !== file.name);
      st.files.push({ label: file.name, ds: fromFile(JSON.parse(await file.text()), file.name) });
    } catch (err) {
      showError(new Error(`${file.name}: ${err.message}`));
    }
  }
  rebuild();
}

function rebuild() {
  st.ds = mergeDatasets([st.cloud, ...st.files.map((f) => f.ds)].filter(Boolean));
  const parts = [];
  if (st.cloud) parts.push(t("Cloud: {users} users, {duels} duels, {reports} reports", { users: st.cloud.users.length, duels: st.cloud.duels.length, reports: st.cloud.reports.length }) + (st.cloudCapped ? ` (${t("capped")})` : ""));
  for (const f of st.files) parts.push(`${t("File")} ${f.label}`);
  $("adm-sources").textContent = parts.join(" · ");
  const sel = $("adm-user");
  const cur = st.user;
  sel.innerHTML = `<option value="all">${t("All users")}</option>` +
    st.ds.users.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name || u.email || u.id)}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "all";
  st.user = sel.value;
  render();
}

/** The dataset restricted to the chosen user and search. */
function filtered() {
  const ds = st.ds;
  const byUser = (x) => st.user === "all" || x.user === st.user;
  const q = st.search;
  const match = (...names) => !q || names.some((n) => String(n ?? "").toLowerCase().includes(q));
  return {
    users: st.user === "all" ? ds.users : ds.users.filter((u) => u.id === st.user),
    duels: ds.duels.filter((d) => byUser(d) && match(d.aName, d.bName, d.a, d.b)),
    reports: ds.reports.filter((r) => byUser(r) && match(r.name, r.id, r.comment)),
  };
}

// ------------------------------------------------------------------ views

const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)} %`);
const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const date = (ms) => (ms ? formatDate(ms) : "—");
const userName = (id) => {
  const u = st.ds.users.find((x) => x.id === id);
  return u ? u.name || u.email || id : id;
};
const sym = { a: ">", b: "<", tie: "=" };
const more = (n) => (n > ROWS ? `<p class="adm-more">${t("{shown} of {n} rows shown: filter by user or search.", { shown: ROWS, n })}</p>` : "");

function render() {
  const ds = filtered();
  const html = { overview: overviewHtml, users: usersHtml, duels: duelsHtml, disputed: disputedHtml, reports: reportsHtml }[st.view](ds);
  $("adm-view").innerHTML = html;
}

function overviewHtml(ds) {
  const o = overview(ds);
  const tile = (k, v, sub = "") => `<div class="adm-tile"><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const recent = [...ds.duels.slice(0, 8).map((d) => ({ at: d.at, html: `${escapeHtml(userName(d.user))} · ${escapeHtml(d.aName ?? d.a)} <b>${sym[d.winner]}</b> ${escapeHtml(d.bName ?? d.b)}` })),
    ...ds.reports.slice(0, 8).map((r) => ({ at: Date.parse(r.at), html: `${escapeHtml(userName(r.user))} · ⚑ ${escapeHtml(r.name)} (${num(r.finalScore)} → ${num(r.expected)})` }))]
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 10);
  return `
    <div class="adm-tiles">
      ${tile(t("Users"), o.users)}
      ${tile(t("Duels"), o.duels, tn(o.judged, "{n} with the model's scores", "{n} with the model's scores"))}
      ${tile(t("Model agrees"), pct(o.agreement), t("share of duels where the model's scores at the time gave the same answer"))}
      ${tile(t("Reports"), o.reports)}
      ${tile(t("Report gap"), o.meanReportDelta == null ? "—" : `${o.meanReportDelta > 0 ? "+" : ""}${num(o.meanReportDelta, 1)}`, t("mean expected − model score (|gap| {g})", { g: num(o.meanAbsReportDelta, 1) }))}
    </div>
    <h3>${t("By algorithm version")}</h3>
    ${o.byAlgorithm.length ? table([t("Algorithm"), t("Duels"), t("Model agrees")], o.byAlgorithm.map((a) => [escapeHtml(a.algorithm), a.duels, bar(a.rate)]), [false, true, false]) : `<p class="muted small">${t("No duel with scores yet.")}</p>`}
    <h3>${t("Latest activity")}</h3>
    ${recent.length ? `<ul class="small">${recent.map((x) => `<li>${date(x.at)} — ${x.html}</li>`).join("")}</ul>` : `<p class="muted small">${t("Nothing yet.")}</p>`}`;
}

const bar = (rate) => (rate == null ? "—" : `<span class="adm-bar" style="width:${Math.round(rate * 80)}px"></span> ${pct(rate)}`);

function usersHtml() {
  const rows = userStats(st.ds).filter((u) => st.user === "all" || u.id === st.user);
  if (!rows.length) return `<p class="muted">${t("No user yet.")}</p>`;
  return table(
    [t("User"), t("E-mail"), t("Last sync"), t("Tracks"), t("Duels"), t("Reports"), t("Model agrees"), t("Algorithm"), t("Average score")],
    rows.map((u) => [
      `${escapeHtml(u.name || "—")}${u.source === "file" ? ` <span class="muted small">(${t("file")})</span>` : ""}<div class="muted small"><code>${escapeHtml(u.id)}</code></div>`,
      escapeHtml(u.email || "—"), date(u.lastSync), num(u.counts?.tracks), u.duelCount, u.reportCount, bar(u.agreement),
      escapeHtml(u.app?.algorithm ?? "—"), num(u.library?.averageScore, 1),
    ]),
    [false, false, false, true, true, true, false, false, true],
  );
}

function duelsHtml(ds) {
  if (!ds.duels.length) return `<p class="muted">${t("No duel.")}</p>`;
  const rows = ds.duels.slice(0, ROWS).map((d) => {
    const m = modelVerdict(d.scores);
    const s = d.scores ?? [];
    return [
      date(d.at), escapeHtml(userName(d.user)),
      `${escapeHtml(d.aName ?? d.a)} <span class="muted small">${num(s[0])}</span>`,
      `<b>A ${sym[d.winner]} B</b>`,
      `${escapeHtml(d.bName ?? d.b)} <span class="muted small">${num(s[1])}</span>`,
      m ? `A ${sym[m]} B` : "—",
      m ? (m === d.winner ? `<span class="adm-ok">${t("agrees")}</span>` : `<span class="adm-ko">${t("disagrees")}</span>`) : "—",
      escapeHtml(d.source ?? "—"), escapeHtml(d.algorithm ?? "—"),
    ];
  });
  return table([t("Date"), t("User"), "A", t("Answer"), "B", t("Model then"), "", t("Source"), t("Algorithm")], rows) + more(ds.duels.length);
}

function disputedHtml(ds) {
  const list = disputedTracks(ds);
  if (!list.length) return `<p class="muted">${t("No disagreement with the model yet.")}</p>`;
  return `<p class="muted small">${t("Each duel answer that contradicts the model pushes one track up and the other down; reports add their expected − model gap. ▲ = people hear it more intense than the model, ▼ = calmer.")}</p>` +
    table(
      [t("Track"), t("Verdict"), "▲", "▼", t("Duels"), t("Contradicted"), t("Report gap"), t("Users"), t("Comments")],
      list.slice(0, ROWS).map((e) => [
        `${escapeHtml(e.name)}<div class="muted small"><code>${escapeHtml(e.id)}</code></div>`,
        e.direction > 0 ? `<span class="adm-up">▲ ${t("too low")}</span>` : e.direction < 0 ? `<span class="adm-down">▼ ${t("too high")}</span>` : "—",
        e.up, e.down, e.duels, e.contradicted,
        e.reportDelta == null ? "—" : `${e.reportDelta > 0 ? "+" : ""}${num(e.reportDelta, 1)}`,
        e.users, `<div class="adm-comment">${escapeHtml(e.comments.slice(0, 3).join("\n"))}</div>`,
      ]),
      [false, false, true, true, true, true, true, true, false],
    ) + more(list.length);
}

function reportsHtml(ds) {
  if (!ds.reports.length) return `<p class="muted">${t("No report.")}</p>`;
  const rows = ds.reports.slice(0, ROWS).map((r, i) => {
    const gap = Number.isFinite(r.expected) && Number.isFinite(r.finalScore) ? r.expected - r.finalScore : null;
    return [
      date(Date.parse(r.at)), escapeHtml(userName(r.user)),
      `${escapeHtml(r.name)}<div class="muted small"><code>${escapeHtml(r.id)}</code></div>`,
      num(r.finalScore), num(r.expected),
      gap == null ? "—" : `<span class="${gap > 0 ? "adm-up" : "adm-down"}">${gap > 0 ? "+" : ""}${num(gap, 1)}</span>`,
      `<div class="adm-comment">${escapeHtml(r.comment || "")}</div>`,
      escapeHtml(r.algorithm ?? "—"),
      r.data ? `<button class="btn small" type="button" data-report="${i}">JSON</button>` : "—",
    ];
  });
  st.shownReports = ds.reports.slice(0, ROWS);
  return table([t("Date"), t("User"), t("Track"), t("Model"), t("Expected"), t("Gap"), t("Comment"), t("Algorithm"), ""], rows, [false, false, false, true, true, true, false, false, false]) + more(ds.reports.length);
}

function table(head, rows, numeric = []) {
  return `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h, i) => `<th class="${numeric[i] ? "num" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric[i] ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// ------------------------------------------------------------------ actions

function onViewClick(e) {
  const b = e.target.closest("[data-report]");
  if (!b) return;
  const r = st.shownReports?.[Number(b.dataset.report)];
  if (!r?.data) return;
  download(r.data, `report-${String(r.name).replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 50)}.json`);
}

function exportDataset() {
  const ds = filtered();
  const data = {
    app: "mea-admin-dataset", exportedAt: new Date().toISOString(),
    filter: { user: st.user, search: st.search },
    users: ds.users,
    duels: ds.duels,
    reports: ds.reports.map((r) => ({ ...r, data: r.data ? safeParse(r.data) : null })),
  };
  download(JSON.stringify(data, null, 1), "music-analyser-admin-dataset.json");
}

const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showError(err) {
  console.error(err);
  const msg = err?.code === "permission-denied" ? t("Permission denied by the database rules: this account is not an admin.") : err?.message ?? String(err);
  $("adm-sources").textContent = msg;
}
