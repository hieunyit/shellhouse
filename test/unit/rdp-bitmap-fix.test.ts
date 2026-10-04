import { describe, expect, it } from 'vitest'
import { BitmapFixer, fixBitmapUpdate } from '../../src/session-host/rdp/bitmap-fix'

/** TS_UPDATE_BITMAP_DATA: mỗi rect [left, top, right, bottom, width, height], dữ liệu `n` byte. */
function bitmapUpdate(rects: number[][], n = 6): Buffer {
  const parts = [Buffer.from([1, 0, rects.length, 0])]
  for (const [l = 0, t = 0, r = 0, b = 0, w = 0, h = 0] of rects) {
    const head = Buffer.alloc(18)
    ;[l, t, r, b, w, h, 16, 0x0401, n].forEach((v, i) => head.writeUInt16LE(v, i * 2))
    parts.push(head, Buffer.alloc(n, 0xcc))
  }
  return Buffer.concat(parts)
}

function fastpath(update: Buffer, fragmentation = 0): Buffer {
  const body = Buffer.concat([Buffer.from([0x01 | (fragmentation << 4), 0, 0]), update])
  body.writeUInt16LE(update.length, 1)
  const length = body.length + 3
  return Buffer.concat([Buffer.from([0x00, 0x80 | (length >> 8), length & 0xff]), body])
}

function slowpath(update: Buffer): Buffer {
  const shareData = Buffer.from([1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0])
  const shareControl = Buffer.from([0, 0, 0x17, 0, 0xea, 0x03])
  const data = Buffer.concat([shareControl, shareData, update])
  const mcs = Buffer.from([
    0x68,
    0,
    1,
    3,
    0xeb,
    0x70,
    0x80 | (data.length >> 8),
    data.length & 0xff
  ])
  const body = Buffer.concat([Buffer.from([2, 0xf0, 0x80]), mcs, data])
  const tpkt = Buffer.from([3, 0, 0, 0])
  tpkt.writeUInt16BE(body.length + 4, 2)
  return Buffer.concat([tpkt, body])
}

const rectOf = (buf: Buffer, at: number): number[] =>
  [0, 1, 2, 3].map((i) => buf.readUInt16LE(at + i * 2))

describe('sửa khung đích bitmap (IronRDP)', () => {
  it('bitmap rộng / cao hơn khung → nới khung; khớp rồi thì giữ nguyên', () => {
    const u = bitmapUpdate([
      [10, 20, 14, 29, 8, 10],
      [0, 0, 63, 63, 64, 64],
      [100, 50, 101, 50, 4, 2]
    ])
    expect(fixBitmapUpdate(u, 0, u.length)).toBe(3)
    expect(rectOf(u, 4)).toEqual([10, 20, 17, 29])
    expect(rectOf(u, 4 + 24)).toEqual([0, 0, 63, 63])
    expect(rectOf(u, 4 + 48)).toEqual([100, 50, 103, 51])
  })

  it('luồng: chờ TPKT đầu tiên, PDU bị cắt được giữ tới khi đủ, không mất / thừa byte', () => {
    const credssp = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x06])
    const a = slowpath(bitmapUpdate([[0, 0, 4, 0, 8, 1]]))
    const b = fastpath(bitmapUpdate([[8, 8, 9, 9, 4, 2]]))
    const frag = fastpath(bitmapUpdate([[8, 8, 9, 9, 4, 2]]), 1)
    const stream = Buffer.concat([a, b, frag])
    const f = new BitmapFixer()
    const out: Buffer[] = [f.push(Buffer.from(credssp))]
    // Cắt giữa header của PDU thứ hai và giữa thân PDU cuối.
    const cuts = [0, a.length + 2, stream.length - 5, stream.length]
    for (let i = 0; i + 1 < cuts.length; i++)
      out.push(f.push(Buffer.from(stream.subarray(cuts[i], cuts[i + 1]))))
    const all = Buffer.concat(out)
    expect(all.length).toBe(credssp.length + stream.length)
    expect(all.subarray(0, 5).equals(credssp)).toBe(true)
    const s = all.subarray(5)
    // Slow-path: rect bắt đầu sau TPKT(4)+X.224(3)+MCS(8)+ShareControl(6)+ShareData(12)+4.
    expect(rectOf(s, 4 + 3 + 8 + 6 + 12 + 4)).toEqual([0, 0, 7, 0])
    // Fast-path: header PDU 3 + header update 3 + 4.
    expect(rectOf(s, a.length + 3 + 3 + 4)).toEqual([8, 8, 11, 9])
    // Mảnh (fragment) để nguyên.
    expect(rectOf(s, a.length + b.length + 3 + 3 + 4)).toEqual([8, 8, 9, 9])
    expect(f.fixed).toBe(2)
    expect(f.flush()).toBeNull()
  })

  it('byte lạ → thôi sửa, chuyển nguyên vẹn (kể cả phần đang giữ)', () => {
    const f = new BitmapFixer()
    const a = slowpath(bitmapUpdate([[0, 0, 4, 0, 8, 1]]))
    const head = f.push(Buffer.from(a.subarray(0, 10)))
    expect(head.length).toBe(0)
    const rest = f.push(Buffer.concat([a.subarray(10), Buffer.from([0xff, 0xff, 0xff])]))
    expect(f.active).toBe(false)
    expect(Buffer.concat([head, rest]).length).toBe(a.length + 3)
    const later = Buffer.from([1, 2, 3])
    expect(f.push(later)).toBe(later)
  })
})
