// Rules of the "Find this score" game (pure, tested in Node).

/** A target anywhere from near silence to off the charts: 5..110. */
export function huntTarget(rand = Math.random) {
  return 5 + Math.floor(rand() * 106);
}

/** Points of a try: 100 on the dot, 0 from 25 away. */
export const huntPoints = (target, score) => Math.max(0, Math.round(100 - 4 * Math.abs(score - target)));

/** The try closest to the target (the first one on a tie). */
export const bestTry = (target, tries) =>
  tries.reduce((b, x) => (!b || Math.abs(x.score - target) < Math.abs(b.score - target) ? x : b), null);
