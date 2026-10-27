import { test } from "node:test";
import assert from "node:assert/strict";
import { Resampler, Chunker, pcm16, validToken } from "../audio.js";
test("resampler retains clock across arbitrarily sized callbacks", () => {
  for (const rate of [44100, 48000]) {
    const r = new Resampler(rate);
    let count = 0;
    for (let i = 0; i < rate * 10; i += 128)
      count += r.push(new Float32Array(Math.min(128, rate * 10 - i))).length;
    assert.ok(Math.abs(count - 160000) <= 1, `${rate}: ${count}`);
  }
});
test("little endian PCM clips safely", () => {
  const view = new DataView(pcm16(Float32Array.from([-2, 0, 2])).buffer);
  assert.equal(view.getInt16(0, true), -32768);
  assert.equal(view.getInt16(2, true), 0);
  assert.equal(view.getInt16(4, true), 32767);
});
const snapshot = {
  track: {
    source: "soundcloud",
    id: "https://soundcloud.com/a/b",
    durationMs: 180000,
  },
  epoch: "a",
  positionMs: 60000,
  observedAtMs: 1000,
  playbackRate: 1,
  status: "playing",
};
test("chunks preserve song offset and overlap", () => {
  const chunks = [];
  const c = new Chunker((header, pcm) => chunks.push({ header, pcm }));
  c.update(snapshot);
  c.push(new Float32Array(160000), 1000);
  c.push(new Float32Array(128000), 1000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].header.startMs, 50000);
  assert.equal(chunks[1].header.startMs, 58000);
  assert.equal(chunks[0].pcm.length, 320000);
});
test("seek and pause flush buffered audio without mixing epochs", () => {
  const chunks = [];
  const c = new Chunker((h) => chunks.push(h));
  c.update(snapshot);
  c.push(new Float32Array(80000), 1000);
  c.update({ ...snapshot, epoch: "b", positionMs: 90000 });
  c.push(new Float32Array(80000), 1000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].epoch, "a");
  assert.equal(chunks[0].samples, 80000);
  c.update({ ...snapshot, epoch: "c", status: "paused" });
  c.push(new Float32Array(160000), 1000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].epoch, "b");
  assert.equal(chunks[1].samples, 80000);
});
test("a nine-second song and a subsecond segment retain their exact coverage", () => {
  for (const samples of [144000, 8000]) {
    const chunks = [];
    const c = new Chunker((header, pcm) => chunks.push({ header, pcm }));
    c.update({ ...snapshot, positionMs: samples / 16 });
    c.push(new Float32Array(samples), 1000);
    c.update({ ...snapshot, epoch: "end", status: "stopped" });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].header.startMs, 0);
    assert.equal(chunks[0].header.samples, samples);
    assert.equal(chunks[0].pcm.length, samples * 2);
  }
});
test("a 184-second song includes its tail, without reemitting overlap alone", () => {
  const chunks = [];
  const c = new Chunker((header) => chunks.push(header));
  for (let second = 0; second < 184; second++) {
    const observedAtMs = 1000 + second * 1000;
    c.update({ ...snapshot, positionMs: second * 1000, observedAtMs });
    c.push(new Float32Array(16000), observedAtMs + 1000);
  }
  c.update({ ...snapshot, epoch: "end", status: "stopped" });
  const tail = chunks.at(-1);
  assert.equal(tail.startMs + tail.samples / 16, 184000);
  assert.equal(tail.samples, 128000);
  const count = chunks.length;
  c.flush();
  assert.equal(chunks.length, count);

  const exact = new Chunker((header) => chunks.push(header));
  exact.update(snapshot);
  exact.push(new Float32Array(160000), 1000);
  exact.flush();
  assert.equal(chunks.length, count + 1);
});
test("a speed change flushes using the old rate and starts a new timeline", () => {
  const chunks = [];
  const c = new Chunker((header) => chunks.push(header));
  c.update(snapshot);
  c.push(new Float32Array(80000), 1000);
  c.update({ ...snapshot, playbackRate: 2 });
  c.push(new Float32Array(16000), 1000);
  c.flush();
  assert.equal(chunks[0].playbackRate, 1);
  assert.equal(chunks[0].startMs, 55000);
  assert.equal(chunks[1].playbackRate, 2);
  assert.equal(chunks[1].startMs, 58000);
});
test("pairing tokens cannot be blank or arbitrary URLs", () => {
  assert.equal(validToken("a".repeat(64)), true);
  for (const s of ["", "abc", "https://example.com", "g".repeat(64)])
    assert.equal(validToken(s), false);
});
