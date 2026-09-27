// YouTube analysis: official embedded player + tab audio capture.
// The user shares this tab (with audio); we record only while the video
// itself is playing (not during ads or pauses), then analyse locally.

import { state } from "../app/store.js";
import * as ctl from "../app/controller.js";
import { YouTubeSource, YOUTUBE_UNAVAILABLE_MESSAGE } from "../audio/sources.js";
import { TabAudioCapture, tabCaptureSupported } from "../audio/capture.js";
import { createPlayer, PLAYER_STATE } from "../audio/youtube-player.js";
import { FEATURE_VERSION } from "../config.js";
import { formatDuration, formatScore } from "../util/format.js";
import { toast } from "./toast.js";

const MIN_SECONDS = 20;
const MAX_SECONDS = 15 * 60;
const $ = (id) => document.getElementById(id);

let session = null; // { source, player, capture, timer, lastT, duration, title }

export function initYouTube() {
  $("youtube-form").addEventListener("submit", (e) => {
    e.preventDefault();
    openYouTube($("youtube-url").value);
  });
  $("yt-start").addEventListener("click", start);
  $("yt-stop").addEventListener("click", () => finish());
  $("yt-cancel").addEventListener("click", () => close());
  if (!tabCaptureSupported()) $("youtube-status").textContent = YOUTUBE_UNAVAILABLE_MESSAGE;
}

export async function openYouTube(url) {
  const status = $("youtube-status");
  const source = new YouTubeSource(url ?? "");
  if (!source.videoId) {
    status.textContent = "Lien YouTube non reconnu.";
    return;
  }
  if (!tabCaptureSupported()) {
    status.textContent = YOUTUBE_UNAVAILABLE_MESSAGE;
    return;
  }
  close();
  $("youtube-url").value = source.watchUrl;
  status.textContent = "";
  session = { source, player: null, capture: null, timer: null, lastT: 0, duration: 0, title: "" };
  const panel = $("yt-panel");
  panel.hidden = false;
  setButtons({ start: false, stop: false });
  setStatus("Chargement du lecteur…");
  $("yt-bar").style.width = "0%";

  const cached = state.records.get(`youtube:${source.videoId}`);
  try {
    const current = session;
    const player = await createPlayer($("yt-player-host"), source.videoId, {
      onStateChange: (s) => { if (s === PLAYER_STATE.ENDED && current === session && session.capture) finish(); },
      onError: (msg) => { if (current === session) { setStatus(msg); setButtons({ start: false, stop: false }); } },
    });
    if (current !== session) return player.destroy();
    session.player = player;
    session.duration = player.getDuration() || 0;
    refreshTitle();
    setButtons({ start: true, stop: false });
    setStatus(cached?.features?.featureVersion === FEATURE_VERSION
      ? `Déjà analysée (score ${formatScore(cached.finalScore)}). Tu peux relancer une capture pour la réanalyser.`
      : "Prêt. La vidéo sera lue en entier en temps réel pendant la capture.");
  } catch (err) {
    setStatus(err.message);
  }
}

async function start() {
  if (!session?.player) return;
  const s = session;
  s.capture = new TabAudioCapture({ onEnded: () => { if (s === session) finish("partage arrêté"); } });
  setButtons({ start: false, stop: false });
  setStatus("Dans la fenêtre de partage : choisis cet onglet et coche « Partager l'audio de l'onglet ».");
  try {
    await s.capture.start();
  } catch (err) {
    s.capture = null;
    setStatus(err.message);
    setButtons({ start: true, stop: false });
    return;
  }
  s.player.seekTo(0, true);
  s.player.playVideo();
  s.lastT = -1;
  s.timer = setInterval(() => poll(s), 250);
}

function poll(s) {
  if (s !== session || !s.capture) return;
  const playerState = s.player.getPlayerState();
  const t = s.player.getCurrentTime() || 0;
  // Record only while the main video advances: ads and pauses are skipped.
  const advancing = playerState === PLAYER_STATE.PLAYING && t > s.lastT + 0.05;
  s.capture.setRecording(advancing);
  s.lastT = Math.max(s.lastT, t);
  s.duration = s.player.getDuration() || s.duration;
  refreshTitle();
  const secs = s.capture.seconds;
  const total = Math.min(s.duration || MAX_SECONDS, MAX_SECONDS);
  $("yt-bar").style.width = `${Math.min(100, (secs / total) * 100)}%`;
  setStatus(`Capture : ${formatDuration(secs)} / ${formatDuration(total)}${advancing ? "" : " — en pause (pub, chargement ou pause)"}`);
  setButtons({ start: false, stop: secs >= MIN_SECONDS });
  if (secs >= MAX_SECONDS) finish();
}

async function finish(reason) {
  const s = session;
  if (!s?.capture) return;
  clearInterval(s.timer);
  s.timer = null;
  try { s.player?.pauseVideo(); } catch { /* player gone */ }
  const capture = s.capture;
  s.capture = null;
  if (capture.seconds < MIN_SECONDS) {
    capture.dispose();
    setStatus(`Capture trop courte (${Math.round(capture.seconds)} s${reason ? `, ${reason}` : ""}) : au moins ${MIN_SECONDS} s de la vidéo sont nécessaires.`);
    setButtons({ start: true, stop: false });
    return;
  }
  setButtons({ start: false, stop: false });
  setStatus("Préparation de l'analyse…");
  const { channels, sampleRate } = await capture.stop();
  if (isSilent(channels)) {
    setStatus("Aucun son capturé : dans la fenêtre de partage, choisis cet onglet et coche « Partager l'audio de l'onglet ».");
    setButtons({ start: true, stop: false });
    return;
  }
  refreshTitle();
  await ctl.enqueuePcm({
    source: s.source,
    meta: { name: s.title || `YouTube ${s.source.videoId}`, duration: s.duration || null, type: "youtube" },
    channels,
    sampleRate,
  });
  toast(`Analyse de « ${s.title || s.source.videoId} » lancée (${formatDuration(channels[0].length / sampleRate)} capturées).`);
  close();
}

function close() {
  if (!session) return;
  clearInterval(session.timer);
  session.capture?.dispose();
  try { session.player?.destroy(); } catch { /* ignore */ }
  session = null;
  $("yt-panel").hidden = true;
  $("yt-player-host").innerHTML = "";
}

function refreshTitle() {
  const title = session?.player?.getVideoData?.()?.title;
  if (title) session.title = title;
  $("yt-title").textContent = session?.title || `Vidéo ${session?.source.videoId ?? ""}`;
}

function isSilent(channels) {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i += 7) peak = Math.max(peak, Math.abs(ch[i]));
  return peak < 1e-4;
}

function setStatus(text) { $("yt-status").textContent = text; }
function setButtons({ start, stop }) {
  $("yt-start").disabled = !start;
  $("yt-stop").disabled = !stop;
}
