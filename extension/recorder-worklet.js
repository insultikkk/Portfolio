import { Resampler } from "./audio.js";
class StillRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Resampler(sampleRate);
    this.pending = new Float32Array();
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels)
      for (let i = 0; i < mono.length; i++)
        mono[i] += channel[i] / channels.length;
    const data = this.resampler.push(mono),
      combined = new Float32Array(this.pending.length + data.length);
    combined.set(this.pending);
    combined.set(data, this.pending.length);
    this.pending = combined;
    if (this.pending.length >= 1600) {
      const samples = this.pending;
      this.pending = new Float32Array();
      this.port.postMessage(samples, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor("still-recorder", StillRecorder);
