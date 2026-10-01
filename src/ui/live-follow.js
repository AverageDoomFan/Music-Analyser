// Live tab, "Follow my Spotify listening": the switch next to the scan modes
// and the start of the follow mode (src/live/follow.js). The capture, the
// gauge and the charts are the Live tab's own: the Follower reports its
// status in the same shape as the Scanner.

import * as ctl from "../app/controller.js";
import * as auth from "../spotify/auth.js";
import * as api from "../spotify/api.js";
import { analyzePcm } from "../audio/analyzer.js";
import { Follower, followOutcome, heardCoverage, DRAFT_THRESHOLD } from "../live/follow.js";
import { t, tn } from "../i18n/index.js";
import { toast } from "./toast.js";
import { recordListen } from "../stats/log-store.js";
import { importKnown } from "../cloud/sync.js";

const $ = (id) => document.getElementById(id);
const KEY = "mea.live.follow";

let on = false;
let ctx = null;

/** Whether the follow mode is chosen. */
export const followOn = () => on;

/**
 * @param {object} c  hooks into the Live tab: { lv, beginCapture, setRunning,
 *   requestWakeLock, releaseWakeLock, applyPendingLyrics, renderEstimate, demoOn }
 */
export function initFollow(c) {
  ctx = c;
  try { on = localStorage.getItem(KEY) === "1"; } catch { /* storage blocked */ }
  $("lv-follow").addEventListener("click", () => {
    if (ctx.lv.status?.running) return;
    set(!on);
  });
  // picking a scan mode leaves the follow mode
  $("lv-modes").addEventListener("click", (e) => {
    if (e.target.closest("button[data-mode]") && !ctx.lv.status?.running && on) set(false);
  });
  render();
}

function set(value) {
  on = value;
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* ignore */ }
  render();
  ctx.renderEstimate();
}

function render() {
  $("lv-follow").setAttribute("aria-checked", String(on));
  $("lv-setup").classList.toggle("following", on);
  $("lv-start").textContent = on ? t("▶ Follow my listening") : t("▶ Start the scan");
  if (on) $("lv-setup-summary").textContent = t("Follow my Spotify listening");
}

/** Summary line of the setup (in place of the scan estimate). */
export function followSummary() {
  $("lv-estimate").textContent = t("Play music in Spotify yourself: each track is analysed when it changes. Heard at least {p} %: added to the library; less: saved as a draft to validate or delete.", { p: Math.round(DRAFT_THRESHOLD * 100) });
  $("lv-setup-summary").textContent = t("Follow my Spotify listening");
}

/** Status line under the transport buttons while following. */
export function followOverall(s) {
  const c = s.counts ?? {};
  const parts = [tn(s.queue.length, "{n} track followed", "{n} tracks followed")];
  const records = (c.done ?? 0) - (c.draft ?? 0);
  if (records) parts.push(tn(records, "{n} track added", "{n} tracks added"));
  if (c.draft) parts.push(tn(c.draft, "{n} draft", "{n} drafts"));
  if (c.error) parts.push(tn(c.error, "{n} error", "{n} errors"));
  if (s.error) parts.push(s.error);
  $("lv-overall-text").textContent = parts.join(" · ");
  // the bar shows how much of the current track was heard (60 % = a normal record)
  const cur = s.current;
  const heard = cur && s.running ? heardCoverage(cur.plan.map((g) => ({ pos: g.recordedFrom ?? g.pos, len: g.filled ?? 0 })), cur.duration) : 0;
  $("lv-overall-bar").style.width = `${Math.round(heard * 100)}%`;
}

/** Starts following the user's own Spotify listening. */
export async function startFollowing() {
  const { lv } = ctx;
  if (lv.status?.running) return;
  if (ctx.demoOn()) throw new Error(t("The follow mode listens to your own Spotify: untick “Demo mode” first."));
  if (!auth.isLoggedIn()) throw new Error(t("Log in to Spotify first (Spotify tab)."));
  if (!auth.hasScopes(["user-read-playback-state"])) {
    $("lv-scope-warn").hidden = false;
    throw new Error(t("Log in to Spotify again to allow reading the playback state."));
  }
  await ctx.beginCapture();
  let lastTrackId = null;
  lv.scanner = new Follower({
    player: { state: () => api.playbackState() },
    analyze: (mono, sr, extra) => analyzePcm(mono, sr, extra),
    analyzeLive: (mono, sr, extra) => analyzePcm(mono, sr, extra),
    decide: (track, coverage) => followOutcome(coverage, ctl.capturedRecord(track, { drafts: true })),
    save: async (track, features, info) => {
      const rec = await ctl.saveCaptured(track, features, info);
      await ctx.applyPendingLyrics(track);
      return rec;
    },
    scoring: ctl.scoring,
    // the Stats tab's listening log: only the follow mode counts as listening
    onListen: (l) => { recordListen(l).catch((err) => console.warn(err)); },
    onUpdate: (s) => {
      lv.status = s; lv.lastUpdate = performance.now(); lv.dirty = true;
      // a track someone already shared is loaded while it plays: no draft, no capture needed
      const tk = s.current?.track;
      if (tk?.id && tk.id !== lastTrackId) { lastTrackId = tk.id; importKnown([tk]).catch(() => {}); }
    },
  });
  $("lv-setup").open = false;
  $("lv-follow").disabled = true;
  ctx.requestWakeLock();
  ctx.setRunning(true);
  toast(t("Following your Spotify listening: play music in Spotify."));
  try {
    const st = await lv.scanner.run();
    const c = st.counts ?? {};
    if (st.error) toast(t("Follow mode interrupted: {msg}", { msg: st.error }), "error", 9000);
    else {
      const drafts = c.draft ?? 0;
      const records = (c.done ?? 0) - drafts;
      toast(`${t("Follow mode stopped")}: ${tn(records, "{n} track added", "{n} tracks added")}${drafts ? `, ${tn(drafts, "{n} draft to validate in the Library", "{n} drafts to validate in the Library")}` : ""}.`);
    }
  } finally {
    $("lv-follow").disabled = false;
    ctx.setRunning(false);
    ctx.releaseWakeLock();
    ctx.renderEstimate();
  }
}
