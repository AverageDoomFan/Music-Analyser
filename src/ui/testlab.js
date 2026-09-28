// Test bench tab: generates the synthetic suite in a worker, feeds it to the
// normal import pipeline, then compares measured values with expectations.

import { state, subscribe } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { VARIABLES, SWEEPS, suiteTracks, evaluate } from "../testlab/suite.js";
import { escapeHtml } from "../util/format.js";
import { player } from "./player.js";
import { toast } from "./toast.js";

const $ = (id) => document.getElementById(id);
const picked = new Set([...VARIABLES.map((v) => v.key), ...SWEEPS.map((s) => s.key)]);
let running = false;
let lastKey = "";
let openDetail = () => {};

export function initTestlab(o) {
  openDetail = o.openDetail;
  const all = [...VARIABLES.map((v) => ({ key: v.key, label: v.label, hint: v.hint })), ...SWEEPS.map((s) => ({ key: s.key, label: s.label.replace(/^Balayage · /, "↗ "), hint: s.hint }))];
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
    if (!confirm("Supprimer tous les morceaux de test de la bibliothèque ?")) return;
    const n = await ctl.deleteTestTracks();
    toast(`${n} morceau${n > 1 ? "x" : ""} de test supprimé${n > 1 ? "s" : ""}.`);
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
    w.onerror = (e) => { e.preventDefault?.(); clearTimeout(timer); reject(new Error("Génération impossible (worker).")); };
  });
}

async function run() {
  if (running) return;
  const seconds = Number($("lab-seconds").value) || 20;
  const list = suiteTracks(seconds).filter((t) => picked.has(t.variable));
  if (!list.length) return toast("Choisis au moins une variable.");
  running = true;
  $("lab-run").disabled = true;
  $("lab-progress").hidden = false;
  let worker;
  try {
    worker = await spawn();
    let done = 0;
    const batch = [];
    for (const t of list) {
      $("lab-status").textContent = `Génération ${done + 1}/${list.length} · ${t.name}`;
      const wav = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.wav));
        worker.postMessage({ id: t.id, seconds });
      });
      done++;
      $("lab-bar").style.width = `${(done / list.length) * 50}%`;
      batch.push({ file: new File([wav], `${t.name}.wav`, { type: "audio/wav", lastModified: 0 }), testId: t.id });
    }
    $("lab-status").textContent = "Analyse… (suivi dans la file en haut de la page)";
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
    $("lab-status").textContent = "Terminé.";
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
    $("lab-results").innerHTML = `<p class="muted small">Aucun morceau de test analysé : clique « Générer et analyser ».</p>`;
    return;
  }
  const res = evaluate(byTest).filter((r) => r.rows.some((x) => x.recordId));
  const ok = res.filter((r) => r.ok === true).length, ko = res.filter((r) => r.ok === false).length;
  $("lab-summary").innerHTML = `<span><b>${ok}</b> conforme${ok > 1 ? "s" : ""}</span><span><b style="color:${ko ? "var(--bad)" : "inherit"}">${ko}</b> non conforme${ko > 1 ? "s" : ""}</span><span class="muted small">sur ${res.length} test${res.length > 1 ? "s" : ""}</span>`;
  $("lab-results").innerHTML = res.map(cardHtml).join("");
}

function cardHtml(r) {
  const cls = r.ok === true ? "ok" : r.ok === false ? "ko" : "";
  const badge = r.ok === true ? `<span class="lab-badge ok">conforme</span>` : r.ok === false ? `<span class="lab-badge ko">à revoir</span>` : `<span class="lab-badge na">incomplet</span>`;
  const numeric = r.rows.map((x) => x.raw).filter((v) => typeof v === "number");
  const scale = r.measure === "BPM" ? null : Math.max(100, ...numeric);
  return `<div class="lab-card ${cls}">
    <h3><span>${escapeHtml(r.label)}</span>${badge}</h3>
    <div class="small muted">${escapeHtml(r.hint ?? "")}</div>
    <div class="small">Mesure : <b>${escapeHtml(r.measure)}</b>${r.alsoLabel ? ` <span class="muted">(entre parenthèses : ${escapeHtml(r.alsoLabel)})</span>` : ""}</div>
    ${!r.sweep && scale && numeric.length === 3 ? `<div class="lab-bar" aria-hidden="true">${r.rows.map((x, i) => `<i style="left:${(x.raw / scale) * 100}%;background:${["#60a5fa", "#a3a3a3", "#f97316"][i]}" title="${x.level}"></i>`).join("")}</div>` : ""}
    <div class="lab-levels ${r.sweep ? "one" : ""}">${r.rows.map((x) => `
      <div class="lab-level ${x.ok === false ? "bad" : ""}">
        <span class="lv">${escapeHtml(x.level)}</span>
        <b>${escapeHtml(x.measured)}${x.also ? ` <small class="muted">(${escapeHtml(x.also)})</small>` : ""}</b>
        ${!r.sweep ? `<span class="muted">attendu : ${escapeHtml(x.expected)}</span>` : ""}
        ${x.recordId ? `<div class="acts">
          ${state.files.has(x.recordId) ? `<button type="button" class="btn small" data-act="play" data-id="${escapeHtml(x.recordId)}">▶</button>` : ""}
          <button type="button" class="btn small" data-act="open" data-id="${escapeHtml(x.recordId)}">Détails</button></div>` : ""}
      </div>`).join("")}
    </div>
  </div>`;
}
