// Single shared audio element to listen to session files while correcting.
import { state } from "../app/store.js";

const audio = new Audio();
let currentUrl = null;
const listeners = new Set();

export const player = {
  current: null,
  toggle(id) {
    if (this.current === id && !audio.paused) {
      audio.pause();
      return;
    }
    if (this.current !== id) {
      const file = state.files.get(id);
      if (!file) return;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(file);
      audio.src = currentUrl;
      this.current = id;
    }
    audio.play().catch(() => {});
  },
  stop() {
    audio.pause();
    this.current = null;
    emit();
  },
  isPlaying(id) { return this.current === id && !audio.paused; },
  onChange(fn) { listeners.add(fn); },
};

function emit() { for (const fn of listeners) fn(); }
audio.addEventListener("play", emit);
audio.addEventListener("pause", emit);
audio.addEventListener("ended", () => { player.current = null; emit(); });
