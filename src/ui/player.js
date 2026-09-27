// Library / detail playback, on top of the shared Web Audio engine.
import { state } from "../app/store.js";
import { engine } from "../audio/engine.js";

export const player = {
  get current() { return engine.id; },

  /** Play / stop a track (resumes where it stopped). */
  async toggle(id) {
    if (engine.id === id && engine.playing) return engine.stop();
    await this.playAt(id, engine.id === id ? engine.lastPosition : 0);
  },

  /** Play a track from a given time; returns false if its file is not in this session. */
  async playAt(id, t) {
    const file = state.files.get(id);
    if (!file) return false;
    await engine.load(id, file);
    engine.set({ isolate: null, musicOn: true });
    engine.cueSource = null;
    await engine.play(t);
    return true;
  },

  isPlaying(id) { return engine.id === id && engine.playing; },
  position(id) { return engine.id === id ? engine.position : null; },
  stop() { engine.stop(); },
  onChange(fn) { engine.onChange(fn); },
};
