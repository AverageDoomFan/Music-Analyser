// Tab audio capture (getDisplayMedia). The user explicitly shares a browser
// tab with its audio; we record the PCM they are hearing, in real time.
// Nothing is downloaded from any server and nothing bypasses a protection:
// it is the same audio the browser is already playing to the user.

const WORKLET_SOURCE = `
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.buffers = null;
    this.filled = 0;
    this.port.onmessage = (e) => { this.recording = e.data.recording; };
  }
  process(inputs) {
    const input = inputs[0];
    if (!this.recording || !input || !input.length) return true;
    const size = 8192;
    if (!this.buffers || this.buffers.length !== input.length) {
      this.buffers = input.map(() => new Float32Array(size));
      this.filled = 0;
    }
    const n = input[0].length;
    for (let c = 0; c < input.length; c++) this.buffers[c].set(input[c], this.filled);
    this.filled += n;
    if (this.filled + n > size) {
      const out = this.buffers.map((b) => b.slice(0, this.filled));
      this.port.postMessage(out, out.map((b) => b.buffer));
      this.filled = 0;
    }
    return true;
  }
}
registerProcessor("pcm-recorder", PcmRecorder);
`;

export function tabCaptureSupported() {
  const md = globalThis.navigator?.mediaDevices;
  const mobile = /Android|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent ?? "");
  return !!md?.getDisplayMedia && !!globalThis.AudioWorkletNode && !mobile;
}

export class TabAudioCapture {
  constructor({ onChunk = () => {}, onEnded = () => {} } = {}) {
    this.onChunk = onChunk;
    this.onEnded = onEnded;
    this.chunks = [];
    this.samples = 0;
    this.recording = false;
  }

  /** Must be called from a user gesture. */
  async start() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
        systemAudio: "exclude",
      });
    } catch (err) {
      throw new Error(err?.name === "NotAllowedError" ? "Partage refusé." : `Capture impossible : ${err?.message ?? err}`);
    }
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Aucun son partagé : choisis cet onglet et coche « Partager l'audio de l'onglet ».");
    }
    this.stream = stream;
    audioTrack.addEventListener("ended", () => this.onEnded());

    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.source = this.ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    this.node = new AudioWorkletNode(this.ctx, "pcm-recorder", { numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e) => {
      this.chunks.push(e.data);
      this.samples += e.data[0].length;
      this.onChunk(e.data, this.samples / this.sampleRate);
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // keeps the graph pulled without playing the audio twice
    this.source.connect(this.node).connect(mute).connect(this.ctx.destination);
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Records only while true (e.g. while the video itself is playing, not an ad). */
  setRecording(on) {
    if (on === this.recording || !this.node) return;
    this.recording = on;
    this.node.port.postMessage({ recording: on });
  }

  get seconds() {
    return this.sampleRate ? this.samples / this.sampleRate : 0;
  }

  /** Stops capturing and returns the recorded PCM. */
  async stop() {
    this.setRecording(false);
    await new Promise((r) => setTimeout(r, 60)); // let the last chunk arrive
    this.dispose();
    const nCh = Math.max(1, ...this.chunks.map((c) => c.length));
    const channels = Array.from({ length: nCh }, () => new Float32Array(this.samples));
    let off = 0;
    for (const chunk of this.chunks) {
      for (let c = 0; c < nCh; c++) channels[c].set(chunk[c] ?? chunk[0], off);
      off += chunk[0].length;
    }
    this.chunks = [];
    return { channels, sampleRate: this.sampleRate };
  }

  dispose() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
    this.stream = this.ctx = this.node = this.source = null;
  }
}
