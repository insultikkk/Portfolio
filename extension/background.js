import { validToken } from "./audio.js";
let socket = null,
  ready = false,
  reconnectTimer = null,
  retry = 1000;
let latest = null,
  activeTab = null,
  captureTab = null,
  error = "",
  recording = false;
let captureWaiter = null;
let captureId = null,
  captureGeneration = 0,
  offscreenCreation = null,
  cleanup = Promise.resolve(),
  playbackQueue = Promise.resolve(),
  playerRevision = 0;
const tabs = new Map();
function send(message) {
  if (ready && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}
function setError(message) {
  error = message;
  chrome.action.setBadgeText({
    text: message ? "!" : recording ? "AI" : ready ? "•" : "",
  });
  chrome.action.setBadgeBackgroundColor({
    color: message ? "#b84b39" : "#ff7a1a",
  });
}
async function connect() {
  clearTimeout(reconnectTimer);
  if (
    socket &&
    [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)
  )
    return;
  const { token } = await chrome.storage.local.get("token");
  if (!validToken(token)) return;
  const ws = new WebSocket("ws://127.0.0.1:18765/");
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
  ws.onmessage = async (event) => {
    if (socket !== ws) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "ready") {
      ready = true;
      retry = 1000;
      setError("");
      if (latest && Date.now() - latest.observedAtMs < 2000)
        send({ type: "snapshot", snapshot: latest });
    }
    if (message.type === "error" || message.type === "audio-rejected")
      setError(message.message);
    if (
      message.type === "capture-error" &&
      message.captureId === captureWaiter?.id
    )
      captureWaiter?.reject(new Error(message.message));
    if (
      message.type === "capture-ready" &&
      message.captureId === captureWaiter?.id
    )
      captureWaiter?.resolve();
    if (
      message.type === "stop-capture" &&
      (!message.captureId || message.captureId === captureId)
    )
      // Acknowledge even a stop received before native capture-start finishes.
      // The native side does not echo client stops, so this cannot loop.
      await stopCapture();
  };
  ws.onerror = () =>
    setError(
      "Приложение Still недоступно или подключение отклонено. Проверьте токен.",
    );
  ws.onclose = () => {
    if (socket !== ws) return;
    ready = false;
    socket = null;
    stopCapture(false).catch(() => {});
    reconnectTimer = setTimeout(connect, retry);
    retry = Math.min(30000, retry * 2);
  };
}
async function ensureOffscreen() {
  if (!offscreenCreation) {
    offscreenCreation = (async () => {
      if (!(await chrome.offscreen.hasDocument()))
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA"],
          justification:
            "Распознавание выбранной вкладки по запросу пользователя с сохранением её звучания.",
        });
    })();
  }
  try {
    await offscreenCreation;
  } finally {
    offscreenCreation = null;
  }
}
function forwardSnapshot(snapshot) {
  const revision = playerRevision;
  const task = playbackQueue.then(async () => {
    if (revision !== playerRevision) return;
    const id = captureId;
    if (recording && id) {
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "snapshot",
        captureId: id,
        snapshot,
      });
      if (!result?.ok && id === captureId) {
        setError(result?.error || "Захват уже остановлен.");
        await stopCapture();
      }
    }
    if (revision === playerRevision) send({ type: "snapshot", snapshot });
  });
  playbackQueue = task.catch(() => {});
  return task;
}
async function startCapture() {
  if (!ready) throw new Error("Сначала подключите приложение Still.");
  if (captureId) throw new Error("Захват уже запускается или работает.");
  const id = crypto.randomUUID(),
    generation = ++captureGeneration;
  captureId = id;
  const check = () => {
    if (generation !== captureGeneration || captureId !== id || !ready)
      throw new Error("Захват отменён.");
  };
  try {
    await cleanup;
    check();
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    check();
    if (!tab?.id || !tab.url?.startsWith("https://soundcloud.com/"))
      throw new Error("Откройте вкладку SoundCloud и включите песню.");
    const snapshot = tabs.get(tab.id);
    if (
      !snapshot ||
      Date.now() - snapshot.observedAtMs > 2000 ||
      snapshot.status !== "playing"
    )
      throw new Error(
        "Включите песню и обновите вкладку SoundCloud после установки расширения.",
      );
    if (activeTab !== tab.id) playerRevision++;
    activeTab = captureTab = tab.id;
    latest = snapshot;
    await forwardSnapshot(snapshot);
    check();
    const approval = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        captureWaiter = null;
        reject(new Error("Still не ответил."));
      }, 5000);
      captureWaiter = {
        id,
        resolve: () => {
          clearTimeout(timer);
          captureWaiter = null;
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          captureWaiter = null;
          reject(e);
        },
      };
    });
    send({ type: "capture-start", captureId: id });
    await approval;
    check();
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });
    check();
    await ensureOffscreen();
    check();
    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "start",
      captureId: id,
      streamId,
      snapshot: latest,
    });
    check();
    if (!result?.ok)
      throw new Error(result?.error || "Не удалось получить звук вкладки.");
    recording = true;
    await forwardSnapshot(latest);
    check();
    setError("");
  } catch (e) {
    if (captureId === id) await stopCapture();
    throw e;
  }
}
async function stopCapture(notify = true) {
  const id = captureId;
  captureGeneration++;
  captureId = null;
  recording = false;
  captureTab = null;
  captureWaiter?.reject(new Error("Захват отменён."));
  if (notify) send({ type: "capture-stop", captureId: id });
  setError(error);
  const close = async () => {
    // A pending createDocument may finish after Stop; close that document too.
    await offscreenCreation?.catch(() => {});
    if (await chrome.offscreen.hasDocument()) {
      try {
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "stop",
          captureId: id,
        });
      } catch {}
      await chrome.offscreen.closeDocument();
    }
  };
  cleanup = cleanup.then(close, close);
  await cleanup;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === "offscreen") return;
  const handle = async () => {
    if (message.type === "media-snapshot") {
      if (!sender.tab?.id || !sender.url?.startsWith("https://soundcloud.com/"))
        return { ok: false };
      const s = message.snapshot;
      tabs.set(sender.tab.id, s);
      if (captureTab !== null && captureTab !== sender.tab.id)
        return { ok: true };
      if (
        activeTab !== sender.tab.id &&
        latest?.status === "playing" &&
        Date.now() - latest.observedAtMs < 2500
      )
        return { ok: true };
      if (activeTab !== sender.tab.id) playerRevision++;
      activeTab = sender.tab.id;
      latest = s;
      await forwardSnapshot(s);
      return { ok: true };
    }
    // Extension pages only: a website cannot configure pairing or start audio capture.
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      !sender.url?.startsWith(chrome.runtime.getURL(""))
    )
      return { ok: false };
    if (message.type === "status")
      return { ready, error, recording, track: latest?.track || null };
    if (message.type === "configure") {
      if (!validToken(message.token))
        throw new Error("Токен должен содержать 64 шестнадцатеричных символа.");
      await stopCapture();
      const oldSocket = socket;
      socket = null;
      ready = false;
      oldSocket?.close();
      await chrome.storage.local.set({
        token: message.token.trim().toLowerCase(),
      });
      await connect();
      return { ok: true };
    }
    if (message.type === "capture-start") {
      await startCapture();
      return { ok: true };
    }
    if (message.type === "capture-stop") {
      await stopCapture();
      return { ok: true };
    }
    if (message.type === "audio-chunk") {
      if (
        !recording ||
        !ready ||
        message.captureId !== captureId ||
        socket.bufferedAmount > 1000000
      )
        return { ok: false };
      const text = atob(message.pcm);
      const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
      send({ type: "audio-start", header: message.header });
      socket.send(bytes);
      return { ok: true };
    }
    if (message.type === "capture-error") {
      if (message.captureId !== captureId) return { ok: false };
      setError(message.error);
      await stopCapture();
      return { ok: true };
    }
    return { ok: false };
  };
  handle()
    .then(respond)
    .catch((e) => respond({ ok: false, error: e.message }));
  return true;
});
function removePlayer(id) {
  tabs.delete(id);
  if (id === activeTab) {
    playerRevision++;
    activeTab = null;
    latest = null;
    // Heartbeats keep the connection alive, so explicitly clear the player.
    send({ type: "player-stopped" });
    stopCapture().catch(() => {});
  } else if (id === captureTab) {
    stopCapture().catch(() => {});
  }
}
chrome.tabs.onRemoved.addListener(removePlayer);
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url && !change.url.startsWith("https://soundcloud.com/"))
    removePlayer(id);
});
setInterval(() => {
  if (!send({ type: "ping" })) connect();
}, 3000);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
