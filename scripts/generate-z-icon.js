// Generates icon/Template.png and icon/Template@2x.png containing a
// Dragon Ball Z "Z" glyph. Monochrome black-on-transparent so macOS treats
// it as a menu-bar template image (auto light/dark).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 28x28 pixel grid. 1 = filled, 0 = transparent.
// Premium DBZ-logo-style Z: italic lean, pointed ends on the bars, thick
// diagonal. Hand-tuned to read well at 16–22px in the menu bar.
const Z = [
  '............................',
  '............................',
  '...1111111111111111111......',
  '...1111111111111111111......',
  '...1111111111111111111......',
  '....111111111111111110......',
  '.............111111100......',
  '............1111110.........',
  '............111110..........',
  '...........111110...........',
  '..........1111100...........',
  '..........111100............',
  '.........1111000............',
  '.........111000.............',
  '........1111000.............',
  '........11100...............',
  '.......11110................',
  '.......1110.................',
  '......11100.................',
  '......1100..................',
  '.....1111...................',
  '.....01111111111111111111...',
  '.....11111111111111111111...',
  '....111111111111111111110...',
  '....111111111111111111100...',
  '............................',
  '............................',
  '............................',
];

function renderPng(scale) {
  const W = Z[0].length * scale;
  const H = Z.length * scale;
  // RGBA scanlines with filter byte 0
  const row = W * 4 + 1;
  const raw = Buffer.alloc(row * H);
  for (let y = 0; y < H; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const sy = Math.floor(y / scale);
      const sx = Math.floor(x / scale);
      const on = Z[sy][sx] === '1';
      const off = y * row + 1 + x * 4;
      raw[off]     = 0;           // R
      raw[off + 1] = 0;           // G
      raw[off + 2] = 0;           // B
      raw[off + 3] = on ? 255 : 0; // A
    }
  }
  const deflated = zlib.deflateSync(raw);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typ = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typ, data])), 0);
    return Buffer.concat([len, typ, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// CRC32 (PNG spec)
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const outDir = path.join(__dirname, '..', 'icon');
fs.writeFileSync(path.join(outDir, 'Template.png'),    renderPng(1));
fs.writeFileSync(path.join(outDir, 'Template@2x.png'), renderPng(2));
console.log('wrote Template.png (22x22) and Template@2x.png (44x44)');
