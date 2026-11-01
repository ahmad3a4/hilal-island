// Draws the Hilal icon (an indigo squircle with a black "island" pill showing a gold
// crescent) and writes assets/icons/icon.png and icon.ico. Pure Node, no dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const mix = (a, b, t) => a + (b - a) * t;

function draw(size) {
  const out = Buffer.alloc(size * size * 4);
  const S = size;
  const aa = S <= 32 ? 0.8 : 1.2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // squircle background with a diagonal indigo -> violet gradient
      const dBg = sdRoundRect(px, py, S / 2, S / 2, S / 2 - S * 0.02, S / 2 - S * 0.02, S * 0.24);
      const aBg = Math.min(1, Math.max(0, 0.5 - dBg / aa));
      const t = (px + py) / (2 * S);
      let r = mix(132, 92, t);
      let g = mix(140, 86, t);
      let b = mix(255, 240, t);
      // soft top highlight
      const hl = Math.max(0, 1 - py / (S * 0.55)) * 0.18;
      r = mix(r, 255, hl); g = mix(g, 255, hl); b = mix(b, 255, hl);
      // the black island pill
      const dPill = sdRoundRect(px, py, S / 2, S / 2, S * 0.29, S * 0.105, S * 0.105);
      const aPill = Math.min(1, Math.max(0, 0.5 - dPill / aa));
      r = mix(r, 10, aPill); g = mix(g, 10, aPill); b = mix(b, 14, aPill);
      // a gold crescent (hilal) inside the pill: a circle minus a shifted circle
      const small = S <= 24;
      const cr = S * (small ? 0.075 : 0.062);
      const ccx = S / 2 - S * (small ? 0.12 : 0.165);
      const ccy = S / 2;
      const clamp01 = (v) => Math.min(1, Math.max(0, v));
      const aOuter = clamp01(0.5 - (Math.hypot(px - ccx, py - ccy) - cr) / aa);
      const aInner = clamp01(0.5 - (Math.hypot(px - (ccx + 0.46 * cr), py - (ccy - 0.3 * cr)) - 0.8 * cr) / aa);
      const aMoon = aOuter * (1 - aInner);
      r = mix(r, 243, aMoon); g = mix(g, 195, aMoon); b = mix(b, 107, aMoon);
      // a short grey "text" line next to it, like the island showing the next prayer
      if (!small) {
        const aBar = clamp01(0.5 - sdRoundRect(px, py, S / 2 + S * 0.055, S / 2, S * 0.115, S * 0.022, S * 0.022) / aa) * 0.85;
        r = mix(r, 150, aBar); g = mix(g, 150, aBar); b = mix(b, 160, aBar);
      }
      const i = (y * S + x) * 4;
      out[i] = Math.round(r);
      out[i + 1] = Math.round(g);
      out[i + 2] = Math.round(b);
      out[i + 3] = Math.round(aBg * 255);
    }
  }
  return png(S, out);
}

const dir = path.resolve(__dirname, '..', 'assets', 'icons');
fs.mkdirSync(dir, { recursive: true });
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = sizes.map((s) => ({ size: s, data: draw(s) }));
fs.writeFileSync(path.join(dir, 'icon.png'), draw(512));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;
  e[1] = size >= 256 ? 0 : size;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log('Wrote assets/icons/icon.png and icon.ico');
