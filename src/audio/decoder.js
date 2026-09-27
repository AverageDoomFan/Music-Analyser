// Decodes encoded audio (mp3, wav, ogg, flac… whatever the browser supports)
// to the analysis input: mono Float32Array at ANALYSIS.sampleRate, plus
// clipping measured on the original channels before the mixdown.

import { ANALYSIS } from "../config.js";
import { measureClipping } from "./features.js";

const OfflineCtx = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;

export async function decodeToMono(arrayBuffer) {
  const Ctx = OfflineCtx();
  if (!Ctx) throw new Error("Web Audio API indisponible dans ce navigateur.");
  const ctx = new Ctx(1, 1, ANALYSIS.sampleRate);
  let audio;
  try {
    audio = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    throw new Error("Format non décodable par ce navigateur.");
  }
  return audioBufferToMono(audio);
}

function audioBufferToMono(audio) {
  const channels = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
  return mixDown(channels, audio.sampleRate);
}

function mixDown(channels, sampleRate) {
  const clipping = measureClipping(channels);
  const mono = new Float32Array(channels[0].length);
  const g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] * g;
  return { mono, sampleRate, duration: mono.length / sampleRate, channels: channels.length, clipping };
}
