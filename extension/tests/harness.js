import assert from "node:assert/strict";

export function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
export async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected asynchronous operation did not occur");
}
export function globals(t, values) {
  const originals = new Map();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}
export const snapshot = (overrides = {}) => ({
  track: {
    source: "soundcloud",
    id: "https://soundcloud.com/artist/song",
    title: "Song",
    artist: "Artist",
    durationMs: 184000,
  },
  epoch: "playing",
  sequence: 1,
  positionMs: 9000,
  playbackRate: 1,
  observedAtMs: Date.now(),
  status: "playing",
  ...overrides,
});
