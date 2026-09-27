// Decodes encoded audio (mp3, wav, ogg, flac… whatever the browser supports)
// to a mono Float32Array at a fixed sample rate, and measures clipping on the
// original channels before they are mixed down.

import { ANALYSIS } from "../config.js";
import { measureClipping } from "./features.js";

export async function decodeToMono(arrayBuffer) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error("Web Audio API indisponible dans ce navigateur.");
  const ctx = new Ctx(1, 1, ANALYSIS.sampleRate);
  let audio;
  try {
    audio = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    throw new Error("Format non décodable par ce navigateur.");
  }
  const channels = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
  const clipping = measureClipping(channels);
  const mono = new Float32Array(audio.length);
  const g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] * g;
  return { mono, sampleRate: audio.sampleRate, duration: audio.duration, channels: audio.numberOfChannels, clipping };
}
