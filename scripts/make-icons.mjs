// 앱 아이콘 PNG 생성 (외부 패키지 없이 node:zlib 로 직접 인코딩).
// 사용: node scripts/make-icons.mjs [d|b]  → client/public/icons/
//   d (기본): 차콜 바탕 + 주황 원 + 어두운 체크 (앱의 완료 버튼 모양)
//   b (예비): 차콜 바탕 + 주황 체크
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const VARIANTS = {
  d: {
    bg: [20, 20, 20], // #141414
    disc: { color: [255, 122, 26], r: 0.305 }, // #ff7a1a, 512 기준 반지름 156
    check: { color: [30, 12, 0], half: 0.041, pts: [[0.371, 0.512], [0.469, 0.609], [0.645, 0.402]] }, // #1e0c00
  },
  b: {
    bg: [31, 31, 31], // #1f1f1f
    disc: null,
    check: { color: [255, 122, 26], half: 0.0625, pts: [[0.27, 0.523], [0.43, 0.68], [0.75, 0.332]] },
  },
};
const variant = VARIANTS[process.argv[2] ?? 'd'];
if (!variant) throw new Error(`알 수 없는 아이콘 종류: ${process.argv[2]} (d 또는 b)`);

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
  const { bg, disc, check } = variant;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const half = check.half * size; // 선 굵기의 절반
  const pts = check.pts.map(([x, y]) => [x * size, y * size]);
  const mix = (base, color, a) => base.map((v, c) => v * (1 - a) + color[c] * a);
  const cover = (d, edge) => Math.max(0, Math.min(1, edge - d + 0.5)); // 안티앨리어싱
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // 필터 없음
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let rgb = bg;
      if (disc) rgb = mix(rgb, disc.color, cover(Math.hypot(px - size / 2, py - size / 2), disc.r * size));
      const d = Math.min(distToSegment(px, py, ...pts[0], ...pts[1]), distToSegment(px, py, ...pts[1], ...pts[2]));
      rgb = mix(rgb, check.color, cover(d, half));
      const i = row + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[i + c] = Math.round(rgb[c]);
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
