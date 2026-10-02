// Reordering a list in place with block moves (Spotify's "reorder items"):
// pure functions, used by src/spotify/reorder.js.

/**
 * Moves that turn the current order into `order`, where order[i] is the
 * current position of the item that must end at position i. Each move takes
 * a block already in the right sequence, so a partly sorted playlist needs
 * few calls.
 * @returns {{start:number, before:number, length:number}[]}
 */
export function planMoves(order) {
  const cur = order.map((_, i) => i);
  const moves = [];
  for (let i = 0; i < order.length; i++) {
    if (cur[i] === order[i]) continue;
    const p = cur.indexOf(order[i], i + 1);
    let length = 1;
    while (i + length < order.length && cur[p + length] === order[i + length]) length++;
    moves.push({ start: p, before: i, length });
    cur.splice(i, 0, ...cur.splice(p, length));
    i += length - 1;
  }
  return moves;
}

/** What Spotify does with the moves (the block always moves up here). */
export function applyMoves(list, moves) {
  const out = [...list];
  for (const m of moves) out.splice(m.before, 0, ...out.splice(m.start, m.length));
  return out;
}

/**
 * Target order of a playlist's entries: analysed tracks in progression order
 * (same mode and flexibility as the Progression tab), then the others in their
 * current order. A track present twice keeps both copies, side by side.
 * @param {object[]} tracks the playlist's entries, in their current order
 * @param {(trackId:string) => object|null} recordOf
 * @returns {{ order:number[], sorted:number, rest:number }}
 */
export function progressionOrder(tracks, recordOf, orderIds) {
  const byRecord = new Map();
  const rest = [];
  tracks.forEach((track, i) => {
    const rec = recordOf(track.id);
    if (rec) {
      if (!byRecord.has(rec.id)) byRecord.set(rec.id, []);
      byRecord.get(rec.id).push(i);
    } else {
      rest.push(i);
    }
  });
  const ids = orderIds([...byRecord.keys()]).filter((id) => byRecord.has(id));
  const placed = new Set(ids);
  for (const [id, at] of byRecord) if (!placed.has(id)) rest.push(...at); // not orderable: kept with the others
  rest.sort((a, b) => a - b);
  const order = [...new Set(ids)].flatMap((id) => byRecord.get(id));
  return { order: [...order, ...rest], sorted: order.length, rest: rest.length };
}
