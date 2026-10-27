export const SAMPLE_RATE = 16000;
export const WINDOW_SAMPLES = 160000;
export const OVERLAP_SAMPLES = 32000;
export function trackKey(t) {
  return `${t.source}:${t.id}:${Math.round(t.durationMs)}`;
}
export function validToken(token) {
  return typeof token === "string" && /^[a-f0-9]{64}$/i.test(token);
}
export function pcm16(samples) {
  const buffer = new ArrayBuffer(samples.length * 2),
    view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++)
    view.setInt16(
      i * 2,
      Math.round(
        Math.max(-1, Math.min(1, samples[i])) *
          (samples[i] < 0 ? 32768 : 32767),
      ),
      true,
    );
  return new Uint8Array(buffer);
}
/** Linear resampler preserving fractional phase across worklet callbacks. */
export class Resampler {
  constructor(inputRate, outputRate = SAMPLE_RATE) {
    this.step = inputRate / outputRate;
    this.phase = 0;
    this.pending = new Float32Array();
  }
  push(input) {
    const joined = new Float32Array(this.pending.length + input.length);
    joined.set(this.pending);
    joined.set(input, this.pending.length);
    const out = [];
    while (this.phase + 1 < joined.length) {
      const index = Math.floor(this.phase),
        mix = this.phase - index;
      out.push(joined[index] * (1 - mix) + joined[index + 1] * mix);
      this.phase += this.step;
    }
    const consumed = Math.min(Math.floor(this.phase), joined.length);
    this.pending = joined.slice(consumed);
    this.phase -= consumed;
    return Float32Array.from(out);
  }
}
export class Chunker {
  constructor(emit) {
    this.emit = emit;
    this.snapshot = null;
    this.buffer = new Float32Array();
    this.start = null;
    this.freshSamples = 0;
  }
  update(snapshot) {
    if (
      !this.snapshot ||
      snapshot.epoch !== this.snapshot.epoch ||
      trackKey(snapshot.track) !== trackKey(this.snapshot.track) ||
      snapshot.playbackRate !== this.snapshot.playbackRate ||
      snapshot.status !== "playing"
    ) {
      this.flush();
    }
    this.snapshot = snapshot;
  }
  flush() {
    // Retain overlap as context, but never submit overlap alone a second time.
    if (this.snapshot && this.start !== null && this.freshSamples > 0) {
      this.emitChunk(this.buffer.length);
    }
    this.buffer = new Float32Array();
    this.start = null;
    this.freshSamples = 0;
  }
  emitChunk(samples) {
    const s = this.snapshot;
    this.emit(
      {
        trackKey: trackKey(s.track),
        epoch: s.epoch,
        startMs: this.start,
        playbackRate: s.playbackRate,
        samples,
      },
      pcm16(this.buffer.subarray(0, samples)),
    );
  }
  push(samples, now = Date.now()) {
    const s = this.snapshot;
    if (!s || s.status !== "playing" || now - s.observedAtMs > 2000) return;
    if (this.start === null)
      this.start = Math.max(
        0,
        s.positionMs +
          (now - s.observedAtMs - samples.length / 16) * s.playbackRate,
      );
    const next = new Float32Array(this.buffer.length + samples.length);
    next.set(this.buffer);
    next.set(samples, this.buffer.length);
    this.buffer = next;
    this.freshSamples += samples.length;
    while (this.buffer.length >= WINDOW_SAMPLES) {
      this.emitChunk(WINDOW_SAMPLES);
      this.buffer = this.buffer.slice(WINDOW_SAMPLES - OVERLAP_SAMPLES);
      this.freshSamples = Math.max(0, this.buffer.length - OVERLAP_SAMPLES);
      this.start += ((WINDOW_SAMPLES - OVERLAP_SAMPLES) / 16) * s.playbackRate;
    }
  }
}
