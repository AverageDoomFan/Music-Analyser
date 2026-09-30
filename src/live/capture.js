// Audio capture for the live scan. Two sources:
//  - "system": screen sharing with sound: a browser tab (e.g. Spotify Web,
//    "Also share tab audio"; it keeps playing out loud) or the entire screen
//    with "Share system audio" (Chrome / Edge on Windows);
//  - "device": an audio input, e.g. "CABLE Output" of VB-Cable when Spotify
//    plays into "CABLE Input" (silent scan).
// Blocks are delivered as mono Float32Array at the analysis rate (44.1 kHz).

import { ANALYSIS } from "../config.js";
import { StreamResampler } from "./resample.js";
import { t } from "../i18n/index.js";

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export const captureSupport = () => ({
  system: !!navigator.mediaDevices?.getDisplayMedia,
  device: !!navigator.mediaDevices?.getUserMedia,
  worklet: typeof AudioWorkletNode !== "undefined",
});

/** Audio inputs (labels need a first permission grant). */
export async function audioInputs({ ask = false } = {}) {
  if (ask) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: RAW });
    s.getTracks().forEach((t) => t.stop());
  }
  const list = await navigator.mediaDevices.enumerateDevices();
  return list.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, label: d.label || t("Audio input"), virtual: /cable|vb-audio|voicemeeter|blackhole|loopback|stereo mix|mixage stéréo/i.test(d.label) }));
}

/**
 * @param {{source:"system"|"device", deviceId?:string, onData:(Float32Array)=>void, onEnded?:()=>void}} o
 */
export async function startCapture({ source, deviceId, stream: given, onData, onEnded = () => {} }) {
  let stream;
  if (source === "stream") {
    stream = given; // demo mode: a MediaStream produced by the app itself
  } else if (source === "system") {
    // When a tab (e.g. Spotify Web) or a window is shared, Chrome brings it to
    // the front by default ("conditional focus"): the user would be taken away
    // from the app. A CaptureController asks it to keep the focus here.
    const controller = typeof CaptureController !== "undefined" ? new CaptureController() : null;
    const keepFocus = () => {
      try { controller?.setFocusBehavior?.("no-focus-change"); } catch { /* screen capture, or too late: nothing to do */ }
    };
    keepFocus(); // allowed before the call in recent Chrome
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: { ideal: 320 }, height: { ideal: 180 } },
      audio: { ...RAW, suppressLocalAudioPlayback: false },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "include",
      ...(controller ? { controller } : {}),
    });
    keepFocus(); // older versions only accept it right after the promise resolves
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(t("No shared sound: share the Spotify Web tab with “Also share tab audio” ticked, or “Entire screen” with “Also share system audio”."));
    }
  } else {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...RAW, channelCount: 2, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
  }
  const audioTrack = stream.getAudioTracks()[0];

  // Prefer a 44.1 kHz context (the browser resamples); fall back to the device rate + our resampler.
  let ctx, node;
  try {
    ctx = new AudioContext({ sampleRate: ANALYSIS.sampleRate, latencyHint: "playback" });
    node = ctx.createMediaStreamSource(stream);
  } catch {
    await ctx?.close().catch(() => {});
    ctx = new AudioContext({ latencyHint: "playback" });
    node = ctx.createMediaStreamSource(stream);
  }
  const resampler = new StreamResampler(ctx.sampleRate, ANALYSIS.sampleRate);
  const deliver = (block) => {
    const out = resampler.push(block);
    if (out.length) onData(out);
  };

  let proc;
  if (typeof AudioWorkletNode !== "undefined") {
    await ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
    proc = new AudioWorkletNode(ctx, "capture-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    proc.port.onmessage = (e) => deliver(e.data);
  } else {
    proc = ctx.createScriptProcessor(4096, 2, 1);
    proc.onaudioprocess = (e) => {
      const b = e.inputBuffer;
      const out = new Float32Array(b.length);
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < d.length; i++) out[i] += d[i] / b.numberOfChannels;
      }
      deliver(out);
    };
  }
  // analysers for the visuals (spectrum, spectrogram, stereo meters)
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.6;
  analyser.minDecibels = -110;
  analyser.maxDecibels = -10;
  const splitter = ctx.createChannelSplitter(2);
  const left = ctx.createAnalyser();
  const right = ctx.createAnalyser();
  left.fftSize = right.fftSize = 2048;
  node.connect(analyser);
  node.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  // the processor must reach the destination to run; muted so nothing is heard twice
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (source !== "stream") stream.getTracks().forEach((t) => t.stop());
    proc.port && (proc.port.onmessage = null);
    ctx.close().catch(() => {});
  };
  audioTrack.addEventListener("ended", () => {
    if (!stopped) { stop(); onEnded(); }
  });
  return {
    label: source === "stream" ? t("Demo (synthetic tracks)") : source === "system" ? t("System audio (screen sharing)") : audioTrack.label || t("Audio input"),
    contextRate: ctx.sampleRate,
    analyser, left, right,
    stop,
  };
}
