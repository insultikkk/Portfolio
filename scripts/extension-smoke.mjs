import { chromium } from "@playwright/test";
import { WebSocketServer } from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const server = new WebSocketServer({ host: "127.0.0.1", port: 18765 });
const seen = [];
const errors = [];
server.on("connection", (ws, request) => {
  assert.match(request.headers.origin, /^chrome-extension:\/\/[a-p]{32}$/);
  let authenticated = false;
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "auth") {
      assert.equal(message.token, "a".repeat(64));
      authenticated = true;
      ws.send(JSON.stringify({ type: "ready", protocol: 1 }));
    } else {
      assert.ok(authenticated);
      if (message.type === "snapshot") seen.push(message.snapshot);
      if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    }
  });
});
const profile = await mkdtemp(path.join(tmpdir(), "still-extension-test-"));
let context;
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
async function until(predicate, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
const audio = Buffer.alloc(44 + 16000 * 12 * 2);
audio.write("RIFF");
audio.writeUInt32LE(audio.length - 8, 4);
audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(16000, 24);
audio.writeUInt32LE(32000, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write("data", 36);
audio.writeUInt32LE(audio.length - 44, 40);
for (let i = 0; i < 16000 * 12; i++)
  audio.writeInt16LE(
    Math.round(Math.sin((i * 2 * Math.PI * 440) / 16000) * 3000),
    44 + i * 2,
  );
try {
  const extensionPath = path.resolve("extension");
  context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--no-sandbox", "--enable-unsafe-extension-debugging"],
  });
  // Current Chromium exposes supported unpacked-extension loading through CDP.
  // It is enabled only in this disposable profile, never in the user's browser.
  const cdp = await context.browser().newBrowserCDPSession();
  const loaded = await cdp.send("Extensions.loadUnpacked", {
    path: extensionPath,
  });
  let worker = context
    .serviceWorkers()
    .find((w) => w.url().includes(loaded.id));
  if (!worker)
    worker = await context.waitForEvent("serviceworker", {
      timeout: 10000,
      predicate: (w) => w.url().includes(loaded.id),
    });
  worker.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await worker.evaluate(() =>
    chrome.storage.local.set({ token: "a".repeat(64) }),
  );
  await context.route("https://soundcloud.com/**", async (route) => {
    if (route.request().url().endsWith(".wav"))
      return route.fulfill({ contentType: "audio/wav", body: audio });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body><a class="playbackSoundBadge__titleLink" title="Artist - Song" href="https://soundcloud.com/artist/song">Artist - Song</a><a class="playbackSoundBadge__lightLink">UploadAccount</a><audio id="audio" src="https://soundcloud.com/fixture.wav"></audio><button onclick="document.getElementById('audio').play()">Play fixture</button><script>navigator.mediaSession.metadata=new MediaMetadata({title:'Artist - Song',artist:'UploadAccount'});</script></body></html>`,
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("https://soundcloud.com/artist/song");
  await page.getByRole("button", { name: "Play fixture" }).click();
  await until(
    () => seen.some((s) => s.status === "playing"),
    "live playing snapshot",
  );
  const first = seen.find((s) => s.status === "playing");
  assert.equal(first.track.title, "Song");
  assert.equal(first.track.artist, "Artist");
  assert.equal(first.track.id, "https://soundcloud.com/artist/song");
  assert.equal(first.track.durationMs, 12000);
  await page.evaluate(() => document.getElementById("audio").pause());
  await until(() => seen.at(-1)?.status === "paused", "pause snapshot");
  const pauseEpoch = seen.at(-1).epoch;
  const pausedPosition = seen.at(-1).positionMs;
  await page.evaluate(() => {
    const audio = document.getElementById("audio");
    audio.currentTime = 6;
    return audio.play();
  });
  await until(
    () => seen.at(-1)?.status === "playing" && seen.at(-1)?.positionMs >= 6000,
    "seek snapshot",
  );
  assert.notEqual(seen.at(-1).epoch, pauseEpoch);
  assert.ok(pausedPosition < 6000);
  await page.evaluate(() => {
    const a = document.querySelector(".playbackSoundBadge__titleLink");
    a.title = "Unknown song";
    a.href = "https://soundcloud.com/uploader/unknown";
    a.textContent = "Unknown song";
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Unknown song",
      artist: "UploadAccount",
    });
  });
  await until(
    () => seen.at(-1)?.track.title === "Unknown song",
    "SPA track change",
  );
  assert.equal(seen.at(-1).track.artist, "");
  assert.deepEqual(errors, []);
  console.log(
    "Extension smoke passed in Chromium: MV3 loading, authenticated WebSocket, real audio clock, pause, seek, SPA changes, uploader isolation. Uses a local SoundCloud-shaped fixture, not the live service.",
  );
} finally {
  await context?.close();
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
