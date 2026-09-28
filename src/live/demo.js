// Demo mode of the live scan: a fake Spotify that "plays" test-bench tracks
// into a MediaStream, captured exactly like the system audio. Lets you try
// the whole live flow (modes, charts, final analysis) without Spotify.

import { suiteTracks } from "../testlab/suite.js";

const DEMO = [
  { id: "structure", name: "Structure complète (intro, drop, break…)", artist: "Banc d'essai" },
  { id: "intensity-min", name: "Nappe calme", artist: "Banc d'essai" },
  { id: "mood-max", name: "Majeur, rapide et lumineux", artist: "Banc d'essai" },
  { id: "sweep-noise", name: "Le bruit arrive", artist: "Banc d'essai" },
  { id: "intensity-max", name: "Extrême bruitiste", artist: "Banc d'essai" },
  { id: "sweep-tempo", name: "Tempo 80 → 170 BPM", artist: "Banc d'essai" },
];

function wavToFloat(buf) {
  const v = new DataView(buf);
  const n = (buf.byteLength - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(44 + i * 2, true) / 32768;
  return out;
}

/**
 * @param {{audible?:boolean, onProgress?:(done:number,total:number)=>void}} o
 */
export async function createDemo({ audible = true, onProgress = () => {} } = {}) {
  const ctx = new AudioContext({ sampleRate: 44100 });
  const dest = ctx.createMediaStreamDestination();
  const monitor = ctx.createGain();
  monitor.gain.value = audible ? 0.6 : 0;
  monitor.connect(ctx.destination);

  // render the tracks in the test-bench worker
  const worker = new Worker(new URL("../testlab/testlab.worker.js", import.meta.url), { type: "module" });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker timeout")), 8000);
    worker.onmessage = (e) => { if (e.data?.ready) { clearTimeout(timer); resolve(); } };
    worker.onerror = (e) => { e.preventDefault?.(); clearTimeout(timer); reject(new Error("Démo indisponible (worker).")); };
  });
  const known = new Set(suiteTracks(20).map((t) => t.id));
  const buffers = new Map();
  let done = 0;
  for (const d of DEMO) {
    if (!known.has(d.id)) continue;
    const wav = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.wav));
      worker.postMessage({ id: d.id, seconds: 20 });
    });
    const mono = wavToFloat(wav);
    const b = ctx.createBuffer(2, mono.length, 44100);
    b.copyToChannel(mono, 0);
    b.copyToChannel(mono, 1);
    buffers.set(d.id, b);
    onProgress(++done, DEMO.length);
  }
  worker.terminate();

  const tracks = DEMO.filter((d) => buffers.has(d.id)).map((d) => ({
    id: `demo-${d.id}`, uri: `spotify:track:demo-${d.id}`, name: d.name, artists: [d.artist], album: "Démo",
    durationMs: Math.round(buffers.get(d.id).duration * 1000), isrc: null, url: null, isLocal: false, image: null, demo: true,
  }));

  let src = null, cur = null;
  const stop = () => {
    try { src?.stop(); } catch { /* already stopped */ }
    src = null;
    if (cur) { cur.progressMs = cur.ms + Math.max(0, (ctx.currentTime - cur.at) * 1000); cur.playing = false; }
  };
  const player = {
    async play(uri, ms) {
      stop();
      if (ctx.state === "suspended") await ctx.resume();
      const id = uri.replace("spotify:track:demo-", "");
      const b = buffers.get(id);
      if (!b) { const e = new Error("Titre de démo inconnu."); e.status = 404; throw e; }
      src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(dest);
      src.connect(monitor);
      const at = ctx.currentTime + 0.25; // like Spotify, a short latency
      src.start(at, Math.min(b.duration - 0.05, ms / 1000));
      cur = { id: `demo-${id}`, ms, at, playing: true };
    },
    async pause() { stop(); },
    async state() {
      if (!cur) return null;
      return { itemId: cur.id, isPlaying: cur.playing, progressMs: cur.playing ? cur.ms + Math.max(0, (ctx.currentTime - cur.at) * 1000) : cur.progressMs };
    },
  };
  return {
    stream: dest.stream,
    tracks,
    player,
    setAudible(on) { monitor.gain.value = on ? 0.6 : 0; },
    close() { stop(); ctx.close().catch(() => {}); },
  };
}
