// Which Spotify device plays: the one chosen before if it is still online,
// else the active one (the app or the Web Player that played last), else a
// computer (desktop app or open.spotify.com), else any. Restricted devices
// cannot be controlled through the Web API.

/** @param {{id:string, type:string, active:boolean, restricted:boolean}[]} list */
export function pickDevice(list, preferredId = null) {
  const ok = list.filter((d) => !d.restricted);
  return ok.find((d) => d.id === preferredId) ?? ok.find((d) => d.active) ?? ok.find((d) => d.type === "Computer") ?? ok[0] ?? null;
}
