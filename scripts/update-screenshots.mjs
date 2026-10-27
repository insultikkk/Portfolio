import { copyFile, mkdir, readFile } from "node:fs/promises";

const files = ["overview.png", "overlay.png", "popup.png"];
await mkdir("docs/images", { recursive: true });
for (const file of files) {
  const source = `test-results/${file}`;
  const bytes = await readFile(source);
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error(`Not a PNG screenshot: ${source}`);
  await copyFile(source, `docs/images/${file}`);
}
console.log("README screenshots updated from the tested demo UI: docs/images.");
