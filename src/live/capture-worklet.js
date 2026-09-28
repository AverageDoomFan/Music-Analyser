// AudioWorklet: downmixes the captured stream to mono and posts blocks of
// ~46 ms to the main thread.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const len = input[0]?.length ?? 128;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < input.length; c++) v += input[c][i];
      this.buf[this.n++] = input.length ? v / input.length : 0;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(2048);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
