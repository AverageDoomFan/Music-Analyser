// Test bench tab: generates the synthetic suite in a worker, feeds it to the
// normal import pipeline, then compares measured values with expectations.

import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { VARIABLES, SWEEPS, suiteTracks, evaluate } from "../testlab/suite.js";
import { escapeHtml } from "../util/format.js";
import { player } from "./player.js";
import { toast } from "./toast.js";
import { t, tn } from "../i18n/index.js";

const $ = (id) => document.getElementById(id);
const picked = new Set([...VARIABLES.map((v) => v.key), ...SWEEPS.map((s) => s.key)]);
let running = false;
let lastKey = "";
let openDetail = () => {};

export function initTestlab(o) {
  openDetail = o.openDetail;
  const all = [...VARIABLES.map((v) => ({ key: v.key, label: v.label, hint: v.hint })), ...SWEEPS.map((s) => ({ key: s.key, label: s.label.replace(/^[^·]+· /, "↗ "), hint: s.hint }))];
  $("lab-vars").innerHTML = all.map((v) => `<button type="button" class="chip-btn" data-var="${v.key}" aria-pressed="true" title="${escapeHtml(v.hint)}">${escapeHtml(v.label)}</button>`).join("");
  $("lab-vars").addEventListener("click", (e) => {
    const b = e.target.closest("[data-var]");
    if (!b) return;
    const k = b.dataset.var;
    picked.has(k) ? picked.delete(k) : picked.add(k);
    b.setAttribute("aria-pressed", String(picked.has(k)));
  });
  $("lab-run").addEventListener("click", run);
  $("lab-refresh").addEventListener("click", () => { lastKey = ""; render(); });
  $("lab-delete").addEventListener("click", async () => {
    if (!confirm(t("Delete every test track from the library?"))) return;
    const n = await ctl.deleteTestTracks();
    toast(tn(n, "{n} test track deleted.", "{n} test tracks deleted."));
  });
  $("lab-results").addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const id = el.dataset.id;
    if (el.dataset.act === "open") openDetail(id);
    if (el.dataset.act === "play") player.isPlaying(id) ? player.stop() : player.playAt(id, 0);
  });
  subscribe(() => { if (!$("panel-lab").hidden) render(); });
}

export function showTestlab() {
  lastKey = "";
  render();
}

function spawn() {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("../testlab/testlab.worker.js", import.meta.url), { type: "module" });
    const timer = setTimeout(() => { w.terminate(); reject(new Error("worker timeout")); }, 8000);
    w.onmessage = (e) => { if (e.data?.ready) { clearTimeout(timer); resolve(w); } };
    w.onerror = (e) => { e.preventDefault?.(); clearTimeout(timer); reject(new Error(t("Generation failed (worker)."))); };
  });
}

async function run() {
  if (running) return;
  const seconds = Number($("lab-seconds").value) || 20;
  const list = suiteTracks(seconds).filter((t) => picked.has(t.variable));
  if (!list.length) return toast(t("Pick at least one variable."));
  running = true;
  $("lab-run").disabled = true;
  $("lab-progress").hidden = false;
  let worker;
  try {
    worker = await spawn();
    let done = 0;
    const batch = [];
    for (const tk of list) {
      $("lab-status").textContent = `${t("Generating")} ${done + 1}/${list.length} · ${tk.name}`;
      const wav = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.wav));
        worker.postMessage({ id: tk.id, seconds });
      });
      done++;
      $("lab-bar").style.width = `${(done / list.length) * 50}%`;
      batch.push({ file: new File([wav], `${tk.name}.wav`, { type: "audio/wav", lastModified: 0 }), testId: tk.id });
    }
    $("lab-status").textContent = t("Analysing… (progress in the queue at the top of the page)");
    ctl.importTestTracks(batch);
    // wait for the pipeline
    await new Promise((resolve) => {
      const tick = () => {
        const q = state.queue;
        $("lab-bar").style.width = `${50 + (q.total ? (q.done / q.total) * 50 : 50)}%`;
        if (!state.jobs.size) return resolve();
        setTimeout(tick, 400);
      };
      setTimeout(tick, 400);
    });
    $("lab-status").textContent = t("Done.");
    lastKey = "";
    render();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    worker?.terminate();
    running = false;
    $("lab-run").disabled = false;
    setTimeout(() => { $("lab-progress").hidden = true; }, 1500);
  }
}

function render() {
  const byTest = new Map();
  for (const r of state.records.values()) if (r.source?.kind === "test" && r.source.test && r.auto) byTest.set(r.source.test, r);
  const key = [...byTest.values()].map((r) => `${r.id}:${r.updatedAt}`).join("|");
  if (key === lastKey) return;
  lastKey = key;
  if (!byTest.size) {
    $("lab-summary").innerHTML = "";
    $("lab-results").innerHTML = `<p class="muted small">${t("No test track analysed: click “Generate and analyse”.")}</p>`;
    return;
  }
  const res = evaluate(byTest).filter((r) => r.rows.some((x) => x.recordId));
  const ok = res.filter((r) => r.ok === true).length, ko = res.filter((r) => r.ok === false).length;
  $("lab-summary").innerHTML = `<span><b>${ok}</b> ${t("passed")}</span><span><b style="color:${ko ? "var(--bad)" : "inherit"}">${ko}</b> ${t("failed")}</span><span class="muted small">${tn(res.length, "out of {n} test", "out of {n} tests")}</span>`;
  $("lab-results").innerHTML = res.map(cardHtml).join("");
}

function cardHtml(r) {
  const cls = r.ok === true ? "ok" : r.ok === false ? "ko" : "";
  const badge = r.ok === true ? `<span class="lab-badge ok">${t("pass")}</span>` : r.ok === false ? `<span class="lab-badge ko">${t("to check")}</span>` : `<span class="lab-badge na">${t("incomplete")}</span>`;
  const numeric = r.rows.map((x) => x.raw).filter((v) => typeof v === "number");
  const scale = r.measure === "BPM" ? null : Math.max(100, ...numeric);
  return `<div class="lab-card ${cls}">
    <h3><span>${escapeHtml(r.label)}</span>${badge}</h3>
    <div class="small muted">${escapeHtml(r.hint ?? "")}</div>
    <div class="small">${t("Measure:")} <b>${escapeHtml(r.measure)}</b>${r.alsoLabel ? ` <span class="muted">(${t("in brackets:")} ${escapeHtml(r.alsoLabel)})</span>` : ""}</div>
    ${!r.sweep && scale && numeric.length === 3 ? `<div class="lab-bar" aria-hidden="true">${r.rows.map((x, i) => `<i style="left:${(x.raw / scale) * 100}%;background:${["#60a5fa", "#a3a3a3", "#f97316"][i]}" title="${x.level}"></i>`).join("")}</div>` : ""}
    <div class="lab-levels ${r.sweep ? "one" : ""}">${r.rows.map((x) => `
      <div class="lab-level ${x.ok === false ? "bad" : ""}">
        <span class="lv">${escapeHtml(t(x.level))}</span>
        <b>${escapeHtml(x.measured)}${x.also ? ` <small class="muted">(${escapeHtml(x.also)})</small>` : ""}</b>
        ${!r.sweep ? `<span class="muted">${t("expected:")} ${escapeHtml(x.expected)}</span>` : ""}
        ${x.recordId ? `<div class="acts">
          ${state.files.has(x.recordId) ? `<button type="button" class="btn small" data-act="play" data-id="${escapeHtml(x.recordId)}">▶</button>` : ""}
          <button type="button" class="btn small" data-act="open" data-id="${escapeHtml(x.recordId)}">${t("Details")}</button></div>` : ""}
      </div>`).join("")}
    </div>
  </div>`;
}
