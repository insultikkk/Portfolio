import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { installFixture, exerciseMedia } from "./browser-fixture.mjs";

const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const errors = [];
try {
  const context = await browser.newContext();
  // Tests the real page bridge, not extension installation or tabCapture.
  // The runtime transport is an explicit fixture because managed Chromium can
  // prohibit unpacked extensions; the real WebSocket is tested in Rust.
  await context.addInitScript(() => {
    window.__stillSnapshots = [];
    window.chrome = window.chrome || {};
    window.chrome.runtime = {
      sendMessage: (message) => {
        window.__stillSnapshots.push(message.snapshot);
        return Promise.resolve();
      },
    };
  });
  await context.addInitScript({
    content: await readFile("extension/player-main.js", "utf8"),
  });
  await context.addInitScript({
    content: await readFile("extension/content.js", "utf8"),
  });
  await installFixture(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await exerciseMedia(page, () => page.evaluate(() => window.__stillSnapshots));
  assert.deepEqual(errors, []);
  console.log(
    "Media bridge smoke passed: real HTML audio, ≤300ms clock error, pause, seek, SPA track change and uploader isolation. Transport is a fixture; live SoundCloud/tabCapture are not claimed.",
  );
} finally {
  await browser.close();
}
