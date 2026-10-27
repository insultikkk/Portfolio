import { mkdir, writeFile } from "node:fs/promises";
// Generated ICO (32-bit DIB), no external image tool needed.
const size = 64,
  rgba = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const r = (x - 31.5) ** 2 + (y - 31.5) ** 2,
      inside = r < 30 ** 2;
    const wave = [17, 26, 35, 44].some(
      (a) =>
        x >= a &&
        x < a + 4 &&
        Math.abs(y - 32) < (a === 26 || a === 35 ? 17 : 10),
    );
    const color = inside
      ? wave
        ? [23, 16, 10, 255]
        : [255, 122, 26, 255]
      : [0, 0, 0, 0];
    const offset = ((size - 1 - y) * size + x) * 4;
    rgba.set([color[2], color[1], color[0], color[3]], offset);
  }
const mask = Buffer.alloc((size * size) / 8),
  header = Buffer.alloc(40);
header.writeUInt32LE(40, 0);
header.writeInt32LE(size, 4);
header.writeInt32LE(size * 2, 8);
header.writeUInt16LE(1, 12);
header.writeUInt16LE(32, 14);
header.writeUInt32LE(rgba.length + mask.length, 20);
const entry = Buffer.alloc(22);
entry.writeUInt16LE(1, 2);
entry.writeUInt16LE(1, 4);
entry[6] = size;
entry[7] = size;
entry.writeUInt16LE(1, 10);
entry.writeUInt16LE(32, 12);
entry.writeUInt32LE(header.length + rgba.length + mask.length, 14);
entry.writeUInt32LE(22, 18);
await mkdir("src-tauri/icons", { recursive: true });
await writeFile(
  "src-tauri/icons/icon.ico",
  Buffer.concat([entry, header, rgba, mask]),
);
