// "Le score ne correspond pas" dialog: targeted questions with a live
// preview of the recalculated score, then accept or cancel.

import { DIMENSIONS } from "../config.js";
import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { QUESTIONS, questionById, selectFollowUps, applyCorrection, deltaSymbol } from "../scoring/correction.js";
import { formatScore, formatDelta, escapeHtml } from "../util/format.js";
import { toast } from "./toast.js";

const dialog = () => document.getElementById("correction-dialog");
let ctx = null; // { id, answers, followUps, showAll }

export function initCorrection() {
  const d = dialog();
  d.addEventListener("click", async (e) => {
    if (e.target === d) return d.close();
    const choice = e.target.closest("[data-q]");
    if (choice) {
      const { q, i } = choice.dataset;
      const idx = Number(i);
      if (ctx.answers[q] === idx) delete ctx.answers[q];
      else ctx.answers[q] = idx;
      if (q === "overall") refreshFollowUps();
      return render();
    }
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "cancel") d.close();
    if (action === "show-all") { ctx.showAll = true; render(); }
    if (action === "accept") {
      await ctl.saveCorrection(ctx.id, cleanAnswers());
      toast("Correction enregistrée.");
      d.close();
    }
  });
}

export function openCorrection(id) {
  const r = state.records.get(id);
  if (!r?.auto) return;
  ctx = { id, answers: { ...(r.correction?.answers ?? {}) }, followUps: [], showAll: false };
  refreshFollowUps();
  // keep previously answered questions visible
  for (const qid of Object.keys(ctx.answers)) if (qid !== "overall" && !ctx.followUps.includes(qid)) ctx.followUps.push(qid);
  render();
  dialog().showModal();
}

function refreshFollowUps() {
  const r = state.records.get(ctx.id);
  const overall = ctx.answers.overall;
  ctx.followUps = overall == null ? [] : selectFollowUps(r.auto, overall, state.weights);
}

function visibleQuestions() {
  if (ctx.answers.overall == null) return [QUESTIONS[0]];
  if (ctx.showAll) return QUESTIONS;
  return [QUESTIONS[0], ...ctx.followUps.map(questionById)];
}

/** Only answers to questions currently shown count. */
function cleanAnswers() {
  const shown = new Set(visibleQuestions().map((q) => q.id));
  return Object.fromEntries(Object.entries(ctx.answers).filter(([k]) => shown.has(k)));
}

function render() {
  const r = state.records.get(ctx.id);
  const answers = cleanAnswers();
  const questions = visibleQuestions();
  const hasAnswers = Object.keys(answers).length > 0;
  const result = hasAnswers ? applyCorrection(r.auto, answers, state.weights) : null;
  const hidden = QUESTIONS.length - questions.length;

  dialog().innerHTML = `
    <div class="dialog-head">
      <div><h2>Le score ne correspond pas</h2><div class="muted small">${escapeHtml(r.name)}</div></div>
      <button class="icon-btn" data-action="cancel" aria-label="Fermer">✕</button>
    </div>
    <div class="dialog-body">
      ${questions.map((q) => questionHtml(q, r)).join("")}
      ${ctx.answers.overall != null && hidden > 0 ? `<p class="small muted">${ctx.followUps.length ? "Questions choisies là où l'analyse est la moins sûre." : "L'analyse est déjà fiable sur les autres dimensions."} <button class="link-btn" data-action="show-all">Afficher toutes les questions</button></p>` : ""}
      ${result ? previewHtml(r, result) : ""}
    </div>
    <div class="dialog-actions">
      <button class="btn" data-action="cancel">Annuler</button>
      <button class="btn primary" data-action="accept" ${hasAnswers ? "" : "disabled"}>Accepter la correction</button>
    </div>`;
}

function questionHtml(q, r) {
  const dim = q.dims[0];
  const conf = dim ? r.auto.confidences?.[dim] : null;
  const hint = dim ? `analyse : ${Math.round(r.auto.subscores[dim])}/100${conf != null ? `, fiabilité ${Math.round(conf * 100)} %` : ""}` : `analyse : ${formatScore(r.auto.score)}/100`;
  return `<div class="question" role="group" aria-label="${escapeHtml(q.text)}">
    <p>${escapeHtml(q.text)}<span class="hint">${hint}</span></p>
    <div class="choices">${q.options.map((o, i) => `<button type="button" data-q="${q.id}" data-i="${i}" aria-pressed="${ctx.answers[q.id] === i}">${escapeHtml(o)}</button>`).join("")}</div>
  </div>`;
}

function previewHtml(r, result) {
  const deltas = Object.entries(result.deltas).filter(([, d]) => deltaSymbol(d) !== "=");
  const label = (k) => DIMENSIONS.find((d) => d.key === k)?.label ?? k;
  return `
    <div class="compare card">
      <div><div class="muted small">Score automatique</div><div class="big-score">${formatScore(r.auto.score)}</div></div>
      <div class="muted">→</div>
      <div><div class="muted small">Nouveau score</div><div class="big-score">${formatScore(result.score)}</div></div>
    </div>
    ${deltas.length ? `<div class="small"><strong>Correction utilisateur :</strong></div>
    <ul class="delta-list">${deltas.map(([k, d]) => `<li><span>${label(k)}</span><span><code>${deltaSymbol(d)}</code> <span class="muted">(${formatDelta(d)})</span></span></li>`).join("")}</ul>` : ""}
    ${Math.round(result.modelScore) !== Math.round(result.score) ? `<p class="muted small">Le modèle recalculé donne ${formatScore(result.modelScore)} ; le score est ramené dans la zone de ton ressenti général.</p>` : ""}`;
}
