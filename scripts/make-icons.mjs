// 앱 아이콘 PNG 생성 (외부 패키지 없이 node:zlib 로 직접 인코딩). 파랑 배경 + 흰 체크 모양.
// 사용: node scripts/make-icons.mjs  → client/public/icons/
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const BG = [37, 99, 235]; // #2563eb
const FG = [255, 255, 255];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function makePng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const half = 0.06 * size; // 선 굵기의 절반
  const pts = [
    [0.27 * size, 0.52 * size],
    [0.43 * size, 0.68 * size],
    [0.75 * size, 0.33 * size],
  ];
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // 필터 없음
    for (let x = 0; x < size; x++) {
      const d = Math.min(
        distToSegment(x + 0.5, y + 0.5, ...pts[0], ...pts[1]),
        distToSegment(x + 0.5, y + 0.5, ...pts[1], ...pts[2]),
      );
      const a = Math.max(0, Math.min(1, half - d + 0.5)); // 안티앨리어싱
      const i = row + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[i + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('client/public/icons', { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(`client/public/icons/${name}`, makePng(size));
  console.log('wrote', name);
}
