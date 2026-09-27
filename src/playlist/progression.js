// Progression builder: orders tracks from calmest to most extreme while
// keeping transitions smooth. Not a plain sort(score):
//   1. start from the score order (the global direction must stay monotonic),
//   2. locally reorder tracks whose scores are close (within `tolerance`) to
//      minimise a perceptual transition cost based on all sub-scores,
//   3. report the remaining big jumps so the user knows where tracks are missing.

import { stageFor } from "../config.js";

const DIMS = ["energy", "tempo", "density", "brightness", "harshness", "loudness", "complexity", "noise"];

/**
 * @param {{id:string, score:number, subscores:Object}[]} items
 * @param {{tolerance?:number, jumpThreshold?:number}} options
 */
export function buildProgression(items, { tolerance = 6, jumpThreshold = 12 } = {}) {
  const order = [...items].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  const cost = (a, b) => transitionCost(a, b);

  // Local search: adjacent swaps and short segment reversals inside the tolerance window.
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < Math.min(order.length, i + 6); j++) {
        if (Math.abs(order[j].score - order[i].score) > tolerance) break;
        const before = pathCost(order, i - 1, j + 1, cost);
        reverse(order, i, j);
        const after = pathCost(order, i - 1, j + 1, cost);
        if (after + 1e-9 < before) improved = true;
        else reverse(order, i, j);
      }
    }
  }

  const steps = order.map((item, i) => {
    const prev = order[i - 1];
    const jump = prev ? item.score - prev.score : 0;
    return {
      ...item,
      position: i + 1,
      stage: stageFor(item.score).label,
      jump,
      bigJump: prev ? Math.abs(jump) >= jumpThreshold : false,
      transition: prev ? Math.round(cost(prev, item) * 10) / 10 : 0,
    };
  });
  const jumps = steps.filter((s) => s.bigJump);
  const totalCost = steps.reduce((a, s) => a + s.transition, 0);
  return {
    steps,
    stats: {
      count: steps.length,
      maxJump: steps.reduce((m, s) => Math.max(m, Math.abs(s.jump)), 0),
      bigJumps: jumps.length,
      meanTransition: steps.length > 1 ? totalCost / (steps.length - 1) : 0,
    },
  };
}

/** Distance between two tracks: score step (backwards steps cost more) + timbre/rhythm difference. */
export function transitionCost(a, b) {
  const d = b.score - a.score;
  const scorePart = d >= 0 ? d : -2.5 * d;
  let sq = 0;
  for (const k of DIMS) sq += ((a.subscores?.[k] ?? 0) - (b.subscores?.[k] ?? 0)) ** 2;
  return scorePart + 0.35 * Math.sqrt(sq / DIMS.length);
}

function pathCost(order, from, to, cost) {
  let c = 0;
  for (let k = Math.max(0, from); k < Math.min(order.length, to + 1) - 1; k++) c += cost(order[k], order[k + 1]);
  return c;
}

function reverse(arr, i, j) {
  while (i < j) {
    [arr[i], arr[j]] = [arr[j], arr[i]];
    i++;
    j--;
  }
}

/** Extended M3U playlist (file names only: the app never knows local paths). */
export function toM3U(steps) {
  const lines = ["#EXTM3U", "#PLAYLIST:Progression d'intensité"];
  for (const s of steps) {
    lines.push(`#EXTINF:${Math.round(s.duration ?? -1)},${s.name} [${Math.round(s.score)}]`);
    lines.push(s.name);
  }
  return lines.join("\n") + "\n";
}

export function toText(steps) {
  return steps.map((s) => `${String(s.position).padStart(3, " ")}. [${String(Math.round(s.score)).padStart(3, " ")}] ${s.stage.padEnd(18, " ")} ${s.name}`).join("\n") + "\n";
}
