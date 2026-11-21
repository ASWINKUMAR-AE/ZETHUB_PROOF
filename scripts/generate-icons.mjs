#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

const NAVY = [11, 18, 32, 255];
const TEAL = [45, 212, 191, 255];
const WHITE = [240, 253, 250, 255];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x >= left + radius && x <= right - radius) return y >= top && y <= bottom;
  if (y >= top + radius && y <= bottom - radius) return x >= left && x <= right;
  const cx = x < left + radius ? left + radius : right - radius;
  const cy = y < top + radius ? top + radius : bottom - radius;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function pixel(size, x, y) {
  const inset = Math.max(2, Math.round(size * 0.06));
  if (!insideRoundedRect(x, y, inset, inset, size - 1 - inset, size - 1 - inset, Math.round(size * 0.2))) {
    return [0, 0, 0, 0];
  }
  const inTeal = insideRoundedRect(
    x,
    y,
    inset + 2,
    inset + 2,
    size - 3 - inset,
    size - 3 - inset,
    Math.round(size * 0.17),
  );
  if (!inTeal) return NAVY;

  // White "Z" mark: top bar, diagonal, bottom bar.
  const left = size * 0.31;
  const right = size * 0.69;
  const top = size * 0.3;
  const bottom = size * 0.7;
  const stroke = Math.max(1.5, size * 0.075);
  const inTop = y >= top && y <= top + stroke && x >= left && x <= right;
  const inBottom = y >= bottom - stroke && y <= bottom && x >= left && x <= right;
  const progress = (y - top) / (bottom - top);
  const diagonalX = right - progress * (right - left);
  const inDiagonal = y >= top && y <= bottom && Math.abs(x - diagonalX) <= stroke * 0.75;
  return inTop || inBottom || inDiagonal ? WHITE : TEAL;
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(size, x, y);
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuffer]);
}

for (const [name, size] of [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
]) {
  fs.writeFileSync(path.join(iconsDir, name), png(size));
}
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), ico(png(256), 256));
console.log(`Generated desktop icons in ${path.relative(root, iconsDir)}`);
