#!/usr/bin/env node
'use strict';
/**
 * Draws the home-screen icons (the favicon's three bars) as PNGs, with no
 * dependencies: node scripts/make-icons.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [0x1a, 0x1a, 0x19];
const BLUE = [0x39, 0x87, 0xe5];
const ORANGE = [0xeb, 0x68, 0x34];
// The favicon's bars, in its 16-unit box: x, y, w, h, color.
const BARS = [
  [1, 8, 3, 7, BLUE],
  [6.5, 4, 3, 11, BLUE],
  [12, 1, 3, 14, ORANGE],
];

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** @param {number} size  @param {boolean} maskable  full-bleed background, bars inside the safe zone */
function draw(size, maskable) {
  const box = size * (maskable ? 0.46 : 0.56);
  const ox = (size - box) / 2;
  const oy = (size - box) / 2;
  const unit = box / 16;
  const corner = maskable ? 0 : size * 0.22;
  const SS = 4; // 4x4 samples per pixel for smooth edges
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!inRoundRect(fx, fy, 0, 0, size, size, corner)) continue;
          let c = BG;
          for (const [bx, by, bw, bh, color] of BARS) {
            if (inRoundRect(fx, fy, ox + bx * unit, oy + by * unit, bw * unit, bh * unit, unit)) c = color;
          }
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (y * size + x) * 4;
      const n = SS * SS;
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A Windows .ico holding PNG images at the usual sizes. */
function ico(sizes) {
  const pngs = sizes.map((s) => draw(s, false));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

const args = process.argv.slice(2);
if (args[0] === '--ico') {
  // node scripts/make-icons.js --ico desktop/icon.ico
  fs.writeFileSync(args[1], ico([16, 24, 32, 48, 64, 256]));
  console.log(`wrote ${args[1]}`);
  process.exit(0);
}
if (args[0] === '--iconset') {
  // node scripts/make-icons.js --iconset build/AppIcon.iconset  (then: iconutil -c icns build/AppIcon.iconset)
  fs.mkdirSync(args[1], { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(args[1], `icon_${s}x${s}.png`), draw(s, false));
    fs.writeFileSync(path.join(args[1], `icon_${s}x${s}@2x.png`), draw(s * 2, false));
  }
  console.log(`wrote ${args[1]}`);
  process.exit(0);
}

const out = path.join(__dirname, '..', 'public');
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
  fs.writeFileSync(path.join(out, name), draw(size, maskable));
  console.log(`wrote public/${name}`);
}
