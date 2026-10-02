// Arrow next to a score: how much it moved since the last algorithm update.
// Green up / red down with the points gained or lost; a grey dash within ±1.

import { algoTrend } from "../core/track.js";
import { t } from "../i18n/index.js";

export function trendHtml(record) {
  const tr = algoTrend(record);
  if (!tr) return `<span class="trend"></span>`; // keeps the scores aligned
  const d = Math.round(tr.delta);
  const title = t("Since algorithm v{v}: {a} → {b}", { v: tr.from, a: Math.round(tr.before), b: Math.round(record.finalScore) });
  if (Math.abs(d) <= 1) return `<span class="trend flat" title="${title}" aria-label="${title}"><i></i></span>`;
  const up = d > 0;
  return `<span class="trend ${up ? "up" : "down"}" title="${title}" aria-label="${title}">${up ? "▲" : "▼"}${Math.abs(d)}</span>`;
}
