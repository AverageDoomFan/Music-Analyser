// The speed dial (live-draw.js drawGauge) used as a guess input: which value a
// point of the canvas points at. Pure, tested in Node. Keep the geometry in
// sync with drawGauge: centre (w/2, h/2 + 8), arc from 135° over 270°.

const A0 = Math.PI * 0.75;
const SPAN = Math.PI * 1.5;

/**
 * Value (0..max, rounded) under the point (x, y) of a w × h dial, or null at
 * the very centre. Points in the gap at the bottom snap to the nearer end.
 */
export function dialValueAt(x, y, w, h, max) {
  const dx = x - w / 2, dy = y - (h / 2 + 8);
  if (Math.hypot(dx, dy) < 6) return null;
  let a = Math.atan2(dy, dx) - A0;
  while (a < 0) a += Math.PI * 2;
  while (a >= Math.PI * 2) a -= Math.PI * 2;
  if (a > SPAN) a = a - SPAN < (Math.PI * 2 - SPAN) / 2 ? SPAN : 0;
  return Math.round((a / SPAN) * max);
}
