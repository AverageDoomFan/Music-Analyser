// Playback engine (Web Audio): plays a track from any position, optionally
// isolates a frequency range (one lane), and schedules cue sounds on notes
// with sample accuracy. One track is decoded at a time (kept for the session).

const LOOKAHEAD = 0.15;   // s of cues scheduled ahead
const TICK_MS = 30;

// One pitch per lane (pentatonic, so simultaneous cues stay distinguishable).
const CUE_FREQS = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568.0, 2093.0, 2637.0];

let ctx = null;
const listeners = new Set();

function audioCtx() {
  ctx ??= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  return ctx;
}

export const engine = {
  id: null,            // id of the loaded track
  buffer: null,        // decoded AudioBuffer (native rate, all channels)
  playing: false,
  lastPosition: 0,     // where playback stopped (resume point)
  musicVolume: 0.8,
  cueVolume: 0.7,
  isolate: null,       // { lo, hi } Hz or null
  musicOn: true,
  cueSource: null,     // () => [{ notes: Float64Array (s), lane: number }]
  _nodes: null,
  _timer: null,
  _cueBuffers: null,
  _startCtx: 0,
  _startOffset: 0,
  _cursor: null,
  _scheduledUntil: 0,

  /** Decodes a file once per session (by id). */
  async load(id, file) {
    if (this.id === id && this.buffer) return this.buffer;
    this.stop();
    const c = audioCtx();
    const buf = await c.decodeAudioData(await file.arrayBuffer());
    this.id = id;
    this.buffer = buf;
    this.lastPosition = 0;
    emit();
    return buf;
  },

  get duration() { return this.buffer?.duration ?? 0; },

  /** Current playback position (s) in the track. */
  get position() {
    if (!this.playing) return this.lastPosition;
    return Math.min(this.duration, this._startOffset + (ctx.currentTime - this._startCtx));
  },

  async play(offset = this.lastPosition) {
    if (!this.buffer) return;
    this.stop(false);
    const c = audioCtx();
    if (c.state === "suspended") await c.resume();
    offset = Math.max(0, Math.min(offset, this.duration - 0.01));
    const when = c.currentTime + 0.05;
    const music = c.createGain();
    music.gain.value = this.musicOn ? this.musicVolume : 0;
    const cues = c.createGain();
    cues.gain.value = this.cueVolume;
    music.connect(c.destination);
    cues.connect(c.destination);

    const src = c.createBufferSource();
    src.buffer = this.buffer;
    let tail = src;
    if (this.isolate) {
      // two cascaded biquads per side: ~24 dB/octave band-pass
      const { lo, hi } = this.isolate;
      const nyq = c.sampleRate / 2;
      for (let i = 0; i < 2; i++) {
        if (lo > 25) tail = chain(tail, filter(c, "highpass", lo));
        if (hi < nyq * 0.95) tail = chain(tail, filter(c, "lowpass", hi));
      }
    }
    tail.connect(music);
    src.onended = () => {
      if (this._nodes?.src === src) {
        this.lastPosition = this.position >= this.duration - 0.05 ? 0 : this.position;
        this._teardown();
        emit();
      }
    };
    src.start(when, offset);
    this._nodes = { src, music, cues };
    this._startCtx = when;
    this._startOffset = offset;
    this.playing = true;
    this._cursor = new Map();
    this._scheduledUntil = 0;
    this._cueBuffers ??= CUE_FREQS.map((f) => makeCue(c, f));
    this._timer = setInterval(() => this._scheduleCues(), TICK_MS);
    this._scheduleCues();
    emit();
  },

  stop(remember = true) {
    if (!this.playing) return;
    if (remember) this.lastPosition = this.position;
    const src = this._nodes?.src;
    this._teardown();
    try { src?.stop(); } catch { /* already stopped */ }
    emit();
  },

  toggle(offset) {
    if (this.playing) this.stop();
    else this.play(offset);
  },

  /** Live settings; restarts playback when the audio graph must change. */
  set({ musicVolume, cueVolume, isolate, musicOn } = {}) {
    if (musicVolume != null) this.musicVolume = musicVolume;
    if (cueVolume != null) this.cueVolume = cueVolume;
    if (musicOn != null) this.musicOn = musicOn;
    const graphChange = isolate !== undefined && JSON.stringify(isolate) !== JSON.stringify(this.isolate);
    if (isolate !== undefined) this.isolate = isolate;
    if (this._nodes) {
      this._nodes.music.gain.value = this.musicOn ? this.musicVolume : 0;
      this._nodes.cues.gain.value = this.cueVolume;
    }
    if (graphChange && this.playing) this.play(this.position);
    emit();
  },

  /** Cue notes changed (selection, new extraction): reschedule from now. */
  refreshCues() {
    if (!this.playing) return;
    // notes already scheduled keep playing; cursors restart after them
    this._cursor = new Map();
  },

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  _scheduleCues() {
    if (!this.playing || !this.cueSource) return;
    const c = ctx;
    const now = this.position;
    const horizon = now + LOOKAHEAD;
    for (const { notes, lane } of this.cueSource()) {
      let i = this._cursor.get(lane);
      // new or changed lane: start after what earlier ticks already scheduled
      if (i == null) i = lowerBound(notes, Math.max(now + 0.01, this._scheduledUntil));
      while (i < notes.length && notes[i] < horizon) {
        const at = this._startCtx + (notes[i] - this._startOffset);
        if (at >= c.currentTime) {
          const s = c.createBufferSource();
          s.buffer = this._cueBuffers[lane % this._cueBuffers.length];
          s.connect(this._nodes.cues);
          s.start(at);
        }
        i++;
      }
      this._cursor.set(lane, i);
    }
    this._scheduledUntil = horizon;
  },

  _teardown() {
    clearInterval(this._timer);
    this._timer = null;
    this._nodes?.music.disconnect();
    this._nodes?.cues.disconnect();
    this._nodes = null;
    this.playing = false;
  },
};

function emit() {
  for (const fn of listeners) fn(engine);
}

function filter(c, type, freq) {
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = 0.707;
  return f;
}

function chain(a, b) {
  a.connect(b);
  return b;
}

/** Short pitched "tick": sine with a fast decay plus a tiny noise transient. */
function makeCue(c, freq) {
  const dur = 0.06;
  const n = Math.round(dur * c.sampleRate);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  let seed = Math.round(freq);
  for (let i = 0; i < n; i++) {
    const t = i / c.sampleRate;
    seed = (seed * 1103515245 + 12345) >>> 0;
    const noise = (seed / 4294967296) * 2 - 1;
    d[i] = 0.6 * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.018) + 0.25 * noise * Math.exp(-t / 0.002);
  }
  return buf;
}

export function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
