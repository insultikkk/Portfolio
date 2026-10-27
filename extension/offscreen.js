import { Chunker } from "./audio.js";

let active = null;

async function dispose(session) {
  if (!session) return;
  if (session.recorder) {
    session.recorder.port.onmessage = null;
    session.recorder.disconnect();
    session.recorder = null;
  }
  if (session.stream) {
    session.stream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    session.stream = null;
  }
  const context = session.context;
  session.context = null;
  if (context) await context.close();
}

async function stop(captureId) {
  if (!active || (captureId && captureId !== active.id)) return;
  const session = active;
  active = null; // Invalidate before any asynchronous cleanup.
  await dispose(session);
}

async function start(message) {
  const previous = active;
  const session = {
    id: message.captureId,
    pending: new Set(),
    updating: false,
  };
  active = session;
  const check = () => {
    if (active !== session) throw new Error("Захват отменён.");
  };
  try {
    await dispose(previous);
    check();
    session.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      },
      video: false,
    });
    check();
    const context = new AudioContext();
    session.context = context;
    await context.audioWorklet.addModule("recorder-worklet.js");
    check();
    const source = context.createMediaStreamSource(session.stream);
    // Capturing normally mutes the tab; restore sound exactly once.
    source.connect(context.destination);
    const recorder = new AudioWorkletNode(context, "still-recorder");
    session.recorder = recorder;
    source.connect(recorder);
    const muted = context.createGain();
    muted.gain.value = 0;
    recorder.connect(muted).connect(context.destination);
    session.chunker = new Chunker((header, pcm) => {
      let text = "";
      for (let i = 0; i < pcm.length; i += 8192)
        text += String.fromCharCode(...pcm.subarray(i, i + 8192));
      const task = chrome.runtime.sendMessage({
        type: "audio-chunk",
        captureId: session.id,
        header,
        pcm: btoa(text),
      });
      session.pending.add(task);
      const done = () => session.pending.delete(task);
      task.then(done, done);
    });
    session.chunker.update(message.snapshot);
    recorder.port.onmessage = (event) => {
      if (active === session && !session.updating)
        session.chunker.push(event.data, Date.now());
    };
    session.stream.getAudioTracks()[0].onended = () => {
      if (active !== session) return;
      chrome.runtime
        .sendMessage({
          type: "capture-error",
          captureId: session.id,
          error: "Захват вкладки завершён.",
        })
        .catch(() => {});
      stop(session.id).catch(() => {});
    };
    await context.resume();
    check();
  } catch (error) {
    if (active === session) active = null;
    // getUserMedia may resolve after Stop. Dispose its late stream as well.
    await dispose(session);
    throw error;
  }
}

async function update(message) {
  const session = active;
  if (!session || session.id !== message.captureId || !session.chunker)
    throw new Error("Захват уже остановлен.");
  session.updating = true;
  try {
    session.chunker.update(message.snapshot);
    // The final old-epoch chunk must reach the background before its reply
    // permits the background to forward the new playback state.
    while (session.pending.size) await Promise.allSettled([...session.pending]);
  } finally {
    session.updating = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.target !== "offscreen") return;
  const task =
    message.type === "start"
      ? start(message)
      : message.type === "stop"
        ? stop(message.captureId)
        : update(message);
  task
    .then(() => respond({ ok: true }))
    .catch((error) => respond({ ok: false, error: error.message }));
  return true;
});
