import { test } from "node:test";
import assert from "node:assert/strict";
import { deferred, globals, snapshot, until } from "./harness.js";

let instance = 0;
async function background(t, options = {}) {
  const listeners = {},
    sockets = [],
    sent = [],
    offscreen = [],
    ticks = [];
  let documentOpen = false,
    closed = 0;
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const page = { id, url: `chrome-extension://${id}/popup.html` };
  const chrome = {
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    storage: {
      local: {
        get: async () => ({ token: "a".repeat(64) }),
        set: async () => {},
      },
    },
    runtime: {
      id,
      getURL: (path) => `chrome-extension://${id}/${path}`,
      onMessage: { addListener: (fn) => (listeners.message = fn) },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      sendMessage: async (message) => {
        offscreen.push(message);
        if (message.type === "start") await options.start?.promise;
        if (message.type === "snapshot")
          await options.onSnapshot?.(message, dispatch);
        return { ok: true };
      },
    },
    tabs: {
      query: async () => {
        sent.push({ type: "query-tab" });
        await options.query?.promise;
        return [{ id: 1, url: "https://soundcloud.com/artist/song" }];
      },
      onRemoved: { addListener: (fn) => (listeners.removed = fn) },
      onUpdated: { addListener: (fn) => (listeners.updated = fn) },
    },
    tabCapture: {
      getMediaStreamId: async () => {
        sent.push({ type: "get-stream-id" });
        await options.stream?.promise;
        return "stream";
      },
    },
    offscreen: {
      hasDocument: async () => documentOpen,
      createDocument: async () => {
        sent.push({ type: "create-document" });
        await options.creation?.promise;
        documentOpen = true;
      },
      closeDocument: async () => {
        documentOpen = false;
        closed++;
      },
    },
  };
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    bufferedAmount = 0;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen();
      });
    }
    receive(message) {
      return this.onmessage({ data: JSON.stringify(message) });
    }
    send(data) {
      if (typeof data !== "string") {
        sent.push({ type: "binary", data });
        return;
      }
      const message = JSON.parse(data);
      sent.push(message);
      if (message.type === "auth")
        queueMicrotask(() => this.receive({ type: "ready" }));
      if (message.type === "capture-start" && !options.manualApproval)
        queueMicrotask(() =>
          this.receive({ type: "capture-ready", captureId: message.captureId }),
        );
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  globals(t, {
    chrome,
    WebSocket: Socket,
    setInterval: (fn) => {
      ticks.push(fn);
      return 1;
    },
  });
  function dispatch(message, sender = page) {
    return new Promise((resolve) =>
      listeners.message(message, sender, resolve),
    );
  }
  await import(`../background.js?test=${++instance}`);
  await until(() => sent.some((m) => m.type === "auth"));
  assert.equal((await dispatch({ type: "status" })).ready, true);
  const media = (s = snapshot(), tabId = 1) =>
    dispatch(
      { type: "media-snapshot", snapshot: s },
      {
        id,
        tab: { id: tabId },
        url: "https://soundcloud.com/artist/song",
      },
    );
  await media();
  return {
    dispatch,
    media,
    sent,
    offscreen,
    ticks,
    listeners,
    socket: sockets[0],
    get documentOpen() {
      return documentOpen;
    },
    get closed() {
      return closed;
    },
    captureId: () =>
      sent.filter((m) => m.type === "capture-start").at(-1)?.captureId,
  };
}

for (const stage of ["query", "stream", "creation", "start"]) {
  test(`native Stop cancels capture while awaiting ${stage}`, async (t) => {
    const gate = deferred();
    const b = await background(t, { [stage]: gate });
    const started = b.dispatch({ type: "capture-start" });
    await until(() =>
      stage === "query"
        ? b.sent.some((m) => m.type === "query-tab")
        : stage === "stream"
          ? b.sent.some((m) => m.type === "get-stream-id")
          : stage === "creation"
            ? b.sent.some((m) => m.type === "create-document")
            : b.offscreen.some((m) => m.type === "start"),
    );
    const stopped = b.socket.receive({ type: "stop-capture" });
    gate.resolve();
    await stopped;
    assert.equal((await started).ok, false);
    assert.equal((await b.dispatch({ type: "status" })).recording, false);
    assert.equal(b.documentOpen, false);
    assert.ok(b.sent.some((m) => m.type === "capture-stop"));
    if (stage === "creation")
      assert.equal(
        b.offscreen.some((m) => m.type === "start"),
        false,
      );
  });
}
test("Stop rejects pending approval; late approval/control cannot affect a new capture", async (t) => {
  const b = await background(t, { manualApproval: true });
  const first = b.dispatch({ type: "capture-start" });
  await until(() => b.captureId());
  const old = b.captureId();
  assert.equal((await b.dispatch({ type: "capture-start" })).ok, false);
  await b.dispatch({ type: "capture-stop" });
  assert.equal((await first).ok, false);
  const second = b.dispatch({ type: "capture-start" });
  await until(() => b.captureId() !== old);
  const current = b.captureId();
  await b.socket.receive({ type: "capture-ready", captureId: old });
  await b.socket.receive({ type: "stop-capture", captureId: old });
  assert.equal(
    b.offscreen.some((m) => m.type === "start"),
    false,
  );
  await b.socket.receive({ type: "capture-ready", captureId: current });
  assert.equal((await second).ok, true);
  assert.equal((await b.dispatch({ type: "status" })).recording, true);
  assert.equal(
    (
      await b.dispatch({
        type: "audio-chunk",
        captureId: old,
        pcm: "",
        header: {},
      })
    ).ok,
    false,
  );
  await b.dispatch({ type: "capture-stop" });
});
test("final audio is forwarded before the paused snapshot", async (t) => {
  const b = await background(t, {
    onSnapshot: async (message, dispatch) => {
      if (message.snapshot.status !== "paused") return;
      await dispatch({
        type: "audio-chunk",
        captureId: message.captureId,
        header: { epoch: "playing", samples: 144000 },
        pcm: btoa("pcm"),
      });
    },
  });
  assert.equal((await b.dispatch({ type: "capture-start" })).ok, true);
  await b.media(snapshot({ epoch: "paused", sequence: 2, status: "paused" }));
  const audio = b.sent.findIndex((m) => m.type === "audio-start");
  const pause = b.sent.findIndex(
    (m) => m.type === "snapshot" && m.snapshot.status === "paused",
  );
  assert.ok(audio >= 0 && pause > audio);
  assert.equal(b.sent[audio + 1].type, "binary");
  await b.dispatch({ type: "capture-stop" });
});
for (const event of ["removed", "updated"]) {
  test(`${event} selected tab clears the native player despite heartbeats`, async (t) => {
    const b = await background(t);
    if (event === "removed") b.listeners.removed(1);
    else b.listeners.updated(1, { url: "https://example.com" });
    b.ticks[0]();
    assert.equal((await b.dispatch({ type: "status" })).track, null);
    assert.ok(b.sent.some((m) => m.type === "player-stopped"));
    assert.equal(b.sent.at(-1).type, "ping");
    await b.dispatch({ type: "capture-stop" });
  });
}
test("closing a tab cannot resurrect an in-flight playback snapshot", async (t) => {
  const gate = deferred();
  const b = await background(t, {
    onSnapshot: async (m) => {
      if (m.snapshot.sequence === 2) await gate.promise;
    },
  });
  await b.dispatch({ type: "capture-start" });
  const pending = b.media(snapshot({ sequence: 2 }));
  await until(() =>
    b.offscreen.some((m) => m.type === "snapshot" && m.snapshot.sequence === 2),
  );
  b.listeners.removed(1);
  gate.resolve();
  await pending;
  assert.equal(
    b.sent.some((m) => m.type === "snapshot" && m.snapshot.sequence === 2),
    false,
  );
  await b.dispatch({ type: "capture-stop" });
});
