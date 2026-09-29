// Library / detail playback. Local files play on the shared Web Audio engine;
// tracks captured from Spotify play on the user's Spotify app (Web API
// playback control, needs Spotify Premium and an open Spotify app).
import { state } from "../app/store.js";
import { engine } from "../audio/engine.js";
import * as auth from "../spotify/auth.js";
import * as api from "../spotify/api.js";
import { t } from "../i18n/index.js";
import { toast } from "./toast.js";
import { pickDevice } from "../spotify/devices.js";

const DEVICE_KEY = "mea.spotify.device";
const listeners = new Set();
// Spotify playback, followed locally (position extrapolated from the start)
const sp = { id: null, playing: false, offset: 0, startedAt: 0 };

const spotifyUri = (id) => {
  const src = state.records.get(id)?.source;
  return src?.kind === "spotify" && src.uri?.startsWith("spotify:track:") ? src.uri : null;
};
const spPosition = () => (sp.playing ? sp.offset + (performance.now() - sp.startedAt) / 1000 : sp.offset);
const notify = () => { for (const fn of listeners) fn(); };

/** Spotify device to play on: the one chosen in the live tab, else the active one, else the first. */
async function deviceId() {
  let saved = null;
  try { saved = localStorage.getItem(DEVICE_KEY); } catch { /* ignore */ }
  const list = await api.devices();
  const pick = pickDevice(list, saved);
  if (!pick) throw new Error(t("No Spotify device: open Spotify (the app or open.spotify.com), then try again."));
  return pick.id;
}

export const savedDevice = () => { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } };

export function rememberDevice(id) {
  try { if (id) localStorage.setItem(DEVICE_KEY, id); } catch { /* ignore */ }
}

async function stopSpotify() {
  if (!sp.playing) return;
  sp.offset = spPosition();
  sp.playing = false;
  notify();
  await api.pause(await deviceId()).catch(() => {});
}

export const player = {
  get current() { return sp.playing ? sp.id : engine.id; },

  /** Local file in this session, or a Spotify capture while logged in with playback rights. */
  canPlay(id) {
    if (!id) return false;
    if (state.files.has(id)) return true;
    return !!spotifyUri(id) && auth.isLoggedIn() && auth.hasScopes(auth.PLAYBACK_SCOPES);
  },

  /** Where a track would play: "file", "spotify" or null. */
  kind(id) {
    if (state.files.has(id)) return "file";
    return this.canPlay(id) ? "spotify" : null;
  },

  /** Play / stop a track (resumes where it stopped). */
  async toggle(id) {
    if (this.isPlaying(id)) return this.stop();
    const resume = sp.id === id ? sp.offset : engine.id === id ? engine.lastPosition : 0;
    return this.playAt(id, resume);
  },

  /** Play a track from a given time (s); returns false if it cannot be played here. */
  async playAt(id, t0) {
    const file = state.files.get(id);
    if (file) {
      await stopSpotify();
      await engine.load(id, file);
      engine.set({ isolate: null, musicOn: true });
      engine.cueSource = null;
      await engine.play(t0);
      return true;
    }
    const uri = spotifyUri(id);
    if (!uri || !this.canPlay(id)) return false;
    engine.stop();
    try {
      await api.play(await deviceId(), uri, (t0 ?? 0) * 1000);
    } catch (err) {
      toast(t("Spotify playback failed: {msg}", { msg: err.message }), "error", 7000);
      return false;
    }
    Object.assign(sp, { id, playing: true, offset: t0 ?? 0, startedAt: performance.now() });
    notify();
    return true;
  },

  isPlaying(id) {
    // a Spotify track that reached its end has stopped
    const dur = state.records.get(sp.id)?.duration;
    if (sp.playing && dur && spPosition() > dur + 1) { sp.playing = false; sp.offset = 0; }
    return (sp.playing && sp.id === id) || (engine.id === id && engine.playing);
  },
  position(id) {
    if (sp.id === id) return spPosition();
    return engine.id === id ? engine.position : null;
  },
  stop() {
    engine.stop();
    stopSpotify().catch(() => {});
  },
  onChange(fn) {
    engine.onChange(fn);
    listeners.add(fn);
  },
};
