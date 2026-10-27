import { test } from "node:test";
import assert from "node:assert/strict";
import { deferred, globals, snapshot, until } from "./harness.js";

let instance = 0;
async function offscreen(t, options = {}) {
  let listener,
    requests = 0;
  const streams = [],
    contexts = [],
    recorders = [],
    messages = [];
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => (listener = fn) },
      sendMessage: async (message) => {
        messages.push(message);
        await options.audio?.promise;
        return { ok: true };
      },
    },
  };
  const navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        const index = requests++;
        await options.media?.(index);
        const track = {
          stopped: false,
          stop() {
            this.stopped = true;
          },
        };
        const stream = {
          getTracks: () => [track],
          getAudioTracks: () => [track],
          track,
        };
        streams.push(stream);
        return stream;
      },
    },
  };
  class Context {
    destination = {};
    closed = false;
    audibleConnections = 0;
    constructor() {
      contexts.push(this);
      this.audioWorklet = {
        addModule: async () => {
          await options.module?.promise;
        },
      };
    }
    createMediaStreamSource() {
      return {
        connect: (target) => {
          if (target === this.destination) this.audibleConnections++;
        },
      };
    }
    createGain() {
      return {
        gain: {},
        connect() {
          return this;
        },
      };
    }
    async resume() {
      this.resuming = true;
      await options.resume?.promise;
    }
    async close() {
      this.closed = true;
    }
  }
  class Recorder {
    port = {};
    constructor() {
      recorders.push(this);
    }
    connect(node) {
      return node;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  globals(t, {
    chrome,
    navigator,
    AudioContext: Context,
    AudioWorkletNode: Recorder,
  });
  await import(`../offscreen.js?test=${++instance}`);
  const dispatch = (message) =>
    new Promise((resolve) =>
      listener({ target: "offscreen", ...message }, {}, resolve),
    );
  return {
    dispatch,
    streams,
    contexts,
    recorders,
    messages,
    get requests() {
      return requests;
    },
  };
}
for (const stage of ["media", "module", "resume"]) {
  test(`offscreen Stop cleans resources even when ${stage} resolves late`, async (t) => {
    const gate = deferred();
    const options =
      stage === "media" ? { media: () => gate.promise } : { [stage]: gate };
    const o = await offscreen(t, options);
    const started = o.dispatch({
      type: "start",
      captureId: "old",
      streamId: "stream",
      snapshot: snapshot(),
    });
    await until(() =>
      stage === "media"
        ? o.requests > 0
        : stage === "module"
          ? o.contexts.length > 0
          : o.contexts[0]?.resuming,
    );
    await o.dispatch({ type: "stop", captureId: "old" });
    gate.resolve();
    assert.equal((await started).ok, false);
    assert.ok(o.streams.every((s) => s.track.stopped));
    assert.ok(o.contexts.every((c) => c.closed));
    assert.ok(
      o.recorders.every((r) => r.disconnected && r.port.onmessage === null),
    );
    assert.equal(o.messages.length, 0);
  });
}
test("a late old start cannot stop a newer session", async (t) => {
  const gate = deferred();
  const o = await offscreen(t, {
    media: (index) => (index === 0 ? gate.promise : Promise.resolve()),
  });
  const old = o.dispatch({
    type: "start",
    captureId: "old",
    streamId: "old",
    snapshot: snapshot(),
  });
  await until(() => o.requests === 1);
  await o.dispatch({ type: "stop", captureId: "old" });
  assert.equal(
    (
      await o.dispatch({
        type: "start",
        captureId: "new",
        streamId: "new",
        snapshot: snapshot(),
      })
    ).ok,
    true,
  );
  gate.resolve();
  assert.equal((await old).ok, false);
  assert.equal(o.streams[0].track.stopped, false);
  assert.equal(o.streams[1].track.stopped, true);
  await o.dispatch({ type: "stop", captureId: "old" });
  assert.equal(o.contexts[0].closed, false);
  await o.dispatch({ type: "stop", captureId: "new" });
  assert.equal(o.streams[0].track.stopped, true);
});
test("snapshot reply waits for the final old-epoch audio, without muting playback", async (t) => {
  const gate = deferred();
  const o = await offscreen(t, { audio: gate });
  assert.equal(
    (
      await o.dispatch({
        type: "start",
        captureId: "capture",
        streamId: "stream",
        snapshot: snapshot(),
      })
    ).ok,
    true,
  );
  assert.equal(o.contexts[0].audibleConnections, 1);
  o.recorders[0].port.onmessage({ data: new Float32Array(144000) });
  let replied = false;
  const update = o
    .dispatch({
      type: "snapshot",
      captureId: "capture",
      snapshot: snapshot({ epoch: "paused", status: "paused" }),
    })
    .then((response) => {
      replied = true;
      return response;
    });
  await until(() => o.messages.length === 1);
  assert.equal(replied, false);
  assert.equal(o.messages[0].header.epoch, "playing");
  assert.equal(o.messages[0].header.samples, 144000);
  assert.equal(o.messages[0].captureId, "capture");
  gate.resolve();
  assert.equal((await update).ok, true);
  assert.equal(replied, true);
  await o.dispatch({ type: "stop", captureId: "capture" });
});
