import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { createServer } from "vite";
let devServer;
let baseUrl = process.env.STILL_TEST_URL;
if (!baseUrl) {
  devServer = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await devServer.listen();
  baseUrl = `http://127.0.0.1:${devServer.httpServer.address().port}/`;
}
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: 1365, height: 1100 },
  deviceScaleFactor: 1,
});
const failures = [];
page.on("pageerror", (e) => failures.push(e.message));
async function checkPalette(target) {
  const palette = await target.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      ["background", "text", "text-muted", "accent", "on-accent"].map((key) => [
        key,
        style.getPropertyValue(`--${key}`).trim(),
      ]),
    );
  });
  assert.deepEqual(palette, {
    background: "#080808",
    text: "#f5f5f5",
    "text-muted": "#9a9a9a",
    accent: "#ff7a1a",
    "on-accent": "#17100a",
  });
  const luminance = (hex) => {
    const rgb = hex
      .slice(1)
      .match(/../g)
      .map((part) => parseInt(part, 16) / 255);
    const linear = rgb.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  for (const [foreground, background] of [
    ["text", "background"],
    ["text-muted", "background"],
    ["accent", "background"],
    ["on-accent", "accent"],
  ]) {
    const a = luminance(palette[foreground]),
      b = luminance(palette[background]);
    assert.ok(
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5,
      `${foreground}/${background} must remain readable`,
    );
  }
}
async function checkActiveCentered(target) {
  await target.waitForFunction(() => {
    const line = document.querySelector(".lyric-line.active");
    const viewport = document.querySelector(".lyrics-viewport");
    if (!line || !viewport) return false;
    const a = line.getBoundingClientRect(),
      b = viewport.getBoundingClientRect();
    return (
      Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) < 3 &&
      a.top >= b.top - 1 &&
      a.bottom <= b.bottom + 1
    );
  });
  assert.equal(
    await target
      .locator(".lyrics-viewport")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
  );
}
async function checkFontSize(target, expected) {
  assert.equal(
    await target
      .locator(".lyric-line.active")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    expected,
  );
  await checkActiveCentered(target);
}
await mkdir("test-results", { recursive: true });
try {
  await page.goto(baseUrl, {
    waitUntil: "networkidle",
  });
  await page.getByText("Занимайтесь своим.").waitFor();
  await checkPalette(page);
  await checkFontSize(page, 28);
  assert.equal(
    await page
      .locator(".lyric-line:not(.active)")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    22,
  );
  assert.ok(
    (await page
      .locator(".setting-row")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) >= 12,
  );
  assert.equal(
    await page.locator("h1").evaluate((el) => getComputedStyle(el).color),
    "rgb(245, 245, 245)",
  );
  assert.equal(
    await page
      .locator(".lyric-line.active")
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(255, 122, 26)",
  );
  assert.match(
    await page
      .locator(".lyric-word")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundImage),
    /rgb\(255, 122, 26\)/,
  );
  assert.equal(await page.locator(".lyric-line.active").count(), 1);
  assert.match(
    await page.locator(".preview-notice").innerText(),
    /Демонстрация/,
  );
  // Keep the design screenshot at the default opacity/locked state, before
  // exercising edits below.
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
  const clickThrough = page.getByRole("switch", { name: "Пропускать клики" });
  assert.equal(await clickThrough.getAttribute("aria-checked"), "true");
  await clickThrough.click();
  assert.equal(await clickThrough.getAttribute("aria-checked"), "false");
  await page.getByLabel("Непрозрачность", { exact: true }).fill("60");
  assert.match(await page.locator(".range-label").first().innerText(), /60%/);
  await page.getByRole("button", { name: "Оверлей", exact: true }).click();
  await page.getByLabel(/Размер текста/).fill("125");
  await checkFontSize(page, 35);
  await page.getByLabel(/Размер текста/).fill("150");
  await checkFontSize(page, 42);
  await page.getByLabel(/Размер текста/).fill("100");
  await checkFontSize(page, 28);
  await page.getByRole("button", { name: "+", exact: true }).click();
  assert.equal(await page.locator("output").innerText(), "+100 мс");
  await page.getByRole("button", { name: "Подключение", exact: true }).click();
  await page
    .getByRole("button", { name: "Копировать токен", exact: true })
    .click();
  assert.match(await page.getByRole("alert").innerText(), /Windows-приложении/);
  await page.getByRole("button", { name: /Локальный ИИ/ }).click();
  assert.equal(
    await page
      .locator(".primary-button")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 122, 26)",
  );
  await page
    .getByRole("button", { name: "Подготовить локальную модель", exact: true })
    .click();
  assert.match(await page.getByRole("alert").innerText(), /Windows-приложении/);
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  for (const width of [720, 1000]) {
    await page.setViewportSize({ width, height: 844 });
    await checkActiveCentered(page);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await checkActiveCentered(page);
  assert.equal(
    await page.locator(".scene-card").evaluate((el) => {
      const card = el.getBoundingClientRect(),
        scene = el.closest(".workspace-scene").getBoundingClientRect();
      return card.left >= scene.left && card.right <= scene.right;
    }),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page.setViewportSize({ width: 340, height: 300 });
  await page.goto(new URL("?window=overlay", baseUrl).href, {
    waitUntil: "networkidle",
  });
  await page.locator(".lyric-line.active").waitFor();
  await checkPalette(page);
  await checkFontSize(page, 28);
  assert.equal(await page.locator(".sidebar").count(), 0);
  assert.equal(await page.locator(".lyrics-card").count(), 1);
  await page.screenshot({ path: "test-results/overlay.png" });
  // Render the actual popup document; only its Chrome transport is mocked.
  const popup = await browser.newPage({
    viewport: { width: 340, height: 640 },
  });
  popup.on("pageerror", (e) => failures.push(e.message));
  await popup.addInitScript(() => {
    const state = { ready: false, error: "", recording: false, track: null };
    globalThis.chrome = {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "status") return { ...state };
          if (message.type === "configure") {
            state.ready = true;
            state.track = { title: "Тихий свет", artist: "Still Sessions" };
          }
          if (message.type === "capture-start") state.recording = true;
          if (message.type === "capture-stop") state.recording = false;
          return { ok: true };
        },
      },
    };
  });
  await popup.goto(new URL("extension/popup.html", baseUrl).href, {
    waitUntil: "networkidle",
  });
  await checkPalette(popup);
  assert.equal(
    await popup
      .locator("#status")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    14,
  );
  assert.equal(
    await popup.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.equal(
    await popup
      .locator("#connect")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 122, 26)",
  );
  assert.equal(await popup.locator("#dot.online").count(), 0);
  await popup.getByLabel("Токен из настроек Still").fill("a".repeat(64));
  await popup.getByRole("button", { name: "Подключить приложение" }).click();
  await popup.locator("#dot.online").waitFor();
  assert.equal(
    await popup
      .locator("#dot")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 122, 26)",
  );
  await popup.getByRole("button", { name: "Распознавать эту вкладку" }).click();
  await popup
    .getByRole("button", { name: "Остановить распознавание" })
    .waitFor();
  await popup.getByRole("button", { name: "Остановить распознавание" }).click();
  await popup
    .getByRole("button", { name: "Распознавать эту вкладку" })
    .waitFor();
  await popup.getByLabel("Токен из настроек Still").fill("");
  await popup.mouse.move(0, 0);
  await popup.screenshot({ path: "test-results/popup.png", fullPage: true });
  await popup.close();
  assert.deepEqual(failures, []);
  console.log(
    "UI smoke passed: larger text at 100/125/150%, active-line centering without clipping, black/orange/white palette and contrast, settings, navigation, demo boundaries, responsive layout, standalone overlay, popup UI with mocked Chrome transport.",
  );
} finally {
  await browser.close();
  await devServer?.close();
}
