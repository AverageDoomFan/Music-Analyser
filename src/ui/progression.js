// Progression tab: ordered playlist grouped by perceptual stage + chart.

import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { toM3U, toText } from "../playlist/progression.js";
import { formatDuration, formatScore, formatDelta, escapeHtml } from "../util/format.js";
import { renderScoreChart } from "./charts.js";
import { toast } from "./toast.js";

let onOpen = () => {};

export function initProgression({ openDetail }) {
  onOpen = openDetail;
  const $ = (id) => document.getElementById(id);
  const tol = $("tolerance");
  tol.addEventListener("input", () => { $("tolerance-value").textContent = tol.value; });
  tol.addEventListener("change", () => { if (state.progression) build(); });
  $("build-progression").addEventListener("click", build);
  $("prog-mode").addEventListener("change", () => { if (state.progression) build(); });
  $("export-m3u").addEventListener("click", () => download(toM3U(state.progression.steps), "progression.m3u", "audio/x-mpegurl"));
  $("export-txt").addEventListener("click", () => download(toText(state.progression.steps), "progression.txt", "text/plain"));
  $("progression-output").addEventListener("click", (e) => {
    const item = e.target.closest("[data-id]");
    if (item) onOpen(item.dataset.id);
  });
}

function build() {
  const p = ctl.buildProgression(Number(document.getElementById("tolerance").value), { byStyle: document.getElementById("prog-mode").value === "style" });
  if (!p.steps.length) toast("Aucun morceau analysé.", "error");
  renderProgression();
}

function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderProgression() {
  const p = state.progression;
  document.getElementById("export-m3u").disabled = !p?.steps.length;
  document.getElementById("export-txt").disabled = !p?.steps.length;
  const out = document.getElementById("progression-output");
  if (!p) return;
  if (out._builtAt === p.builtAt) return;
  out._builtAt = p.builtAt;
  if (!p.steps.length) {
    out.innerHTML = `<p class="empty">Aucun morceau analysé pour l'instant.</p>`;
    return;
  }
  const totalDuration = p.steps.reduce((a, s) => a + (s.duration ?? 0), 0);
  const groups = [];
  for (const s of p.steps) {
    const g = p.byStyle ? s.group : s.stage;
    if (!groups.length || groups.at(-1).stage !== g) groups.push({ stage: g, items: [] });
    groups.at(-1).items.push(s);
  }
  out.innerHTML = `
    <div class="card">
      <div class="chart-title"><strong>Courbe d'intensité de la playlist</strong><span class="muted small">points creux = sauts ≥ 12 points</span></div>
      <div class="chart-host"></div>
    </div>
    <div class="stats">
      <span><b>${p.stats.count}</b> morceaux</span>
      <span><b>${formatDuration(totalDuration)}</b> au total</span>
      <span>plus grand saut <b>${Math.round(p.stats.maxJump)}</b> points</span>
      <span><b>${p.stats.bigJumps}</b> saut${p.stats.bigJumps > 1 ? "s" : ""} important${p.stats.bigJumps > 1 ? "s" : ""}</span>
    </div>
    ${p.stats.bigJumps ? `<p class="notice">Les sauts importants signalent des zones où il manque des morceaux intermédiaires dans ta bibliothèque.</p>` : ""}
    ${groups.map((g) => `
      <div class="stage-group">
        <h3>${escapeHtml(g.stage)} <small>${g.items.length} morceau${g.items.length > 1 ? "x" : ""}</small></h3>
        <ol class="progression-list">${g.items.map(itemHtml).join("")}</ol>
      </div>`).join("")}`;
  renderScoreChart(out.querySelector(".chart-host"), p.steps.map((s) => ({ id: s.id, label: s.name, score: s.score, flag: s.bigJump })), {
    height: 220,
    xLabel: "ordre de lecture →",
    onSelect: onOpen,
  });
}

function itemHtml(s) {
  return `<li class="prog-item" data-id="${s.id}" style="cursor:pointer">
    <span class="pos">${s.position}</span>
    <span><span class="track-name">${escapeHtml(s.name)}</span></span>
    <span class="num"><b>${formatScore(s.score)}</b></span>
    <span class="jump${s.bigJump ? " big" : ""}" title="écart de score avec le morceau précédent · fin du précédent → début de celui-ci : ${formatDelta(s.seam)}">${s.position > 1 ? formatDelta(s.jump) : ""}</span>
  </li>`;
}
