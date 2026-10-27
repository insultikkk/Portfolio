import { mkdir, cp, readFile } from "node:fs/promises";
const files = [
  "manifest.json",
  "player-main.js",
  "content.js",
  "background.js",
  "audio.js",
  "offscreen.html",
  "offscreen.js",
  "recorder-worklet.js",
  "popup.html",
  "popup.css",
  "popup.js",
];
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
if (
  manifest.manifest_version !== 3 ||
  manifest.minimum_chrome_version !== "116"
)
  throw new Error("Unexpected extension manifest");
await mkdir("dist/extension", { recursive: true });
for (const file of files)
  await cp(`extension/${file}`, `dist/extension/${file}`);
console.log(
  "Расширение готово: dist/extension (Chrome / Edge → Загрузить распакованное расширение)",
);
