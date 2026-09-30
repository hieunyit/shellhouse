// Sinh build/icon.png (1024×1024) cho electron-builder — không cần thư viện ảnh.
// Vẽ bằng signed distance field + khử răng cưa: nền vuông bo góc tối, mái nhà + dấu nhắc ">_"
// ("Shell" + "house") màu xanh ngọc của thương hiệu — cùng hình với Logo trong app (components/Logo.tsx).
// Chạy: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const SIZE = 1024
const px = new Uint8Array(SIZE * SIZE * 4)

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const BG_TOP = hex('#1d2531')
const BG_BOTTOM = hex('#0c0f14')
// Nét vẽ chuyển màu chéo từ trên-trái xuống dưới-phải.
const MARK_FROM = hex('#5eead4')
const MARK_TO = hex('#14b8a6')
const BORDER = hex('#2b3544')

// Khoảng cách có dấu tới hình vuông bo góc tâm (c,c), nửa cạnh h, bán kính r.
function sdRoundRect(x, y, c, h, r) {
  const qx = Math.abs(x - c) - h + r
  const qy = Math.abs(y - c) - h + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
// Khoảng cách tới đoạn thẳng AB có độ dày (capsule).
function sdSegment(x, y, ax, ay, bx, by, w) {
  const pax = x - ax
  const pay = y - ay
  const bax = bx - ax
  const bay = by - ay
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
  return Math.hypot(pax - bax * t, pay - bay * t) - w
}
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d)) // d tính bằng pixel
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

const C = SIZE / 2
const HALF = SIZE * 0.43 // chừa lề như icon macOS
const RADIUS = SIZE * 0.2
const STROKE = SIZE * 0.037

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px0 = x + 0.5
    const py0 = y + 0.5
    const dBox = sdRoundRect(px0, py0, C, HALF, RADIUS)
    const alpha = cover(dBox)
    if (alpha === 0) continue
    const t = (py0 - (C - HALF)) / (2 * HALF)
    let color = mix(BG_TOP, BG_BOTTOM, Math.max(0, Math.min(1, t)))
    // Viền mảnh bên trong.
    color = mix(color, BORDER, cover(Math.abs(dBox + SIZE * 0.006) - SIZE * 0.004))
    // Mái nhà, ">" và "_"
    const roof = Math.min(
      sdSegment(px0, py0, 250, 452, 512, 262, STROKE),
      sdSegment(px0, py0, 512, 262, 774, 452, STROKE)
    )
    const chevron = Math.min(
      sdSegment(px0, py0, 318, 548, 448, 646, STROKE),
      sdSegment(px0, py0, 448, 646, 318, 744, STROKE)
    )
    const underscore = sdSegment(px0, py0, 528, 744, 706, 744, STROKE)
    const g = Math.max(0, Math.min(1, (px0 + py0 - 500) / 1100))
    color = mix(color, mix(MARK_FROM, MARK_TO, g), cover(Math.min(roof, chevron, underscore)))
    const i = (y * SIZE + x) * 4
    px[i] = Math.round(color[0])
    px[i + 1] = Math.round(color[1])
    px[i + 2] = Math.round(color[2])
    px[i + 3] = Math.round(alpha * 255)
  }
}

// ---- PNG encoder tối giản (RGBA 8-bit, filter 0) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log(`build/icon.png ${png.length} bytes`)
