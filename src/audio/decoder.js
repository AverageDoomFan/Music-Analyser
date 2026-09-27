// Turns audio into the analysis input: mono Float32Array at ANALYSIS.sampleRate,
// plus clipping measured on the original channels before the mixdown.
//   decodeToMono(arrayBuffer)       – encoded files (mp3, wav, ogg, flac… per browser)
//   pcmToMono(channels, sampleRate) – raw PCM, e.g. captured tab audio

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

export async function pcmToMono(channels, sampleRate) {
  if (sampleRate === ANALYSIS.sampleRate) return mixDown(channels, sampleRate);
  const Ctx = OfflineCtx();
  const length = channels[0].length;
  const outLength = Math.ceil((length * ANALYSIS.sampleRate) / sampleRate);
  const ctx = new Ctx(channels.length, outLength, ANALYSIS.sampleRate);
  const buffer = ctx.createBuffer(channels.length, length, sampleRate);
  channels.forEach((ch, i) => buffer.copyToChannel(ch, i));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return audioBufferToMono(await ctx.startRendering());
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
