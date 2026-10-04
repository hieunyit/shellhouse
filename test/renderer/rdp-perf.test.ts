import { describe, expect, it, vi } from 'vitest'
import { imageRendering, sessionResolution } from '../../src/renderer/src/rdp/controller'
import { InputCoalescer, type FrameScheduler } from '../../src/renderer/src/rdp/input'
import { RdpStreamSniffer, codecLabel } from '../../src/renderer/src/rdp/perf'

// controller.ts kéo theo module renderer đọc `window` lúc nạp.
vi.hoisted(() => {
  Reflect.set(globalThis, 'window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    devicePixelRatio: 1
  })
})

/** Hiệu năng tab Remote Desktop: chọn độ phân giải, gom input, đọc loại mã hoá trên luồng. */

describe('độ phân giải phiên', () => {
  it('mặc định theo pixel CSS kể cả màn hình HiDPI', () => {
    expect(sessionResolution(1003, 701, 1.5, false)).toEqual({
      width: 1000,
      height: 700,
      scale: null
    })
    expect(sessionResolution(1280, 720, 2, false)).toEqual({
      width: 1280,
      height: 720,
      scale: null
    })
  })

  it('HiDPI: pixel vật lý + hệ số scale cho server', () => {
    expect(sessionResolution(1000, 700, 1.5, true)).toEqual({
      width: 1500,
      height: 1050,
      scale: 150
    })
    expect(sessionResolution(1000, 700, 1.25, true)).toEqual({
      width: 1248,
      height: 874,
      scale: 125
    })
    // DPR 1: không gửi scale; DPR quá lớn bị chặn ở 4.
    expect(sessionResolution(1000, 700, 1, true).scale).toBeNull()
    expect(sessionResolution(1000, 700, 6, true)).toMatchObject({ width: 4000, scale: 400 })
    // Giới hạn của RDP vẫn áp dụng.
    expect(sessionResolution(3000, 3000, 4, true)).toMatchObject({ width: 8192, height: 8192 })
  })

  it('phóng canvas: bội số nguyên giữ pixel sắc, tỉ lệ lẻ nội suy', () => {
    const desktop = { width: 1000, height: 700 }
    expect(imageRendering({ desktop }, { width: 1000 }, 2)).toBe('pixelated')
    expect(imageRendering({ desktop }, { width: 1000 }, 1.5)).toBe('auto')
    expect(imageRendering({ desktop }, { width: 1000 }, 1)).toBe('auto')
    expect(imageRendering({ desktop: null }, { width: 1000 }, 2)).toBe('auto')
  })
})

/** Bộ lập lịch khung hình giả: chạy tay. */
function frames(): FrameScheduler & { run(): void; queued: number } {
  let next = 1
  const pending = new Map<number, () => void>()
  return {
    request: (cb) => {
      pending.set(next, cb)
      return next++
    },
    cancel: (h) => {
      pending.delete(h)
    },
    run: () => {
      const all = [...pending.values()]
      pending.clear()
      for (const cb of all) cb()
    },
    get queued() {
      return pending.size
    }
  }
}

describe('gom input chuột', () => {
  it('nhiều lần di chuột trong một khung hình → gửi một vị trí (cuối cùng)', () => {
    const sent: string[] = []
    const f = frames()
    const c = new InputCoalescer(
      {
        move: (x, y) => sent.push(`move ${x},${y}`),
        wheel: (v, a, u) => sent.push(`wheel ${v ? 'v' : 'h'} ${a} ${u}`)
      },
      f
    )
    for (let i = 0; i < 10; i++) c.pointer(i, i * 2)
    expect(sent).toEqual([])
    expect(f.queued).toBe(1)
    f.run()
    expect(sent).toEqual(['move 9,18'])
    f.run()
    expect(sent).toEqual(['move 9,18'])
  })

  it('cuộn cộng dồn theo trục; đổi đơn vị thì gửi phần cũ trước', () => {
    const sent: string[] = []
    const f = frames()
    const c = new InputCoalescer(
      {
        move: (x, y) => sent.push(`move ${x},${y}`),
        wheel: (v, a, u) => sent.push(`wheel ${v ? 'v' : 'h'} ${a} ${u}`)
      },
      f
    )
    c.wheel(0, 40, 0)
    c.wheel(0, 60, 0)
    c.wheel(5, 0, 0)
    c.wheel(0, 3, 1)
    expect(sent).toEqual(['wheel v 100 0', 'wheel h 5 0'])
    f.run()
    expect(sent).toEqual(['wheel v 100 0', 'wheel h 5 0', 'wheel v 3 1'])
  })

  it('flush gửi ngay vị trí đang chờ (trước nút chuột / phím); reset bỏ đi', () => {
    const sent: string[] = []
    const f = frames()
    const c = new InputCoalescer(
      { move: (x, y) => sent.push(`move ${x},${y}`), wheel: () => {} },
      f
    )
    c.pointer(3, 4)
    c.flush()
    expect(sent).toEqual(['move 3,4'])
    expect(f.queued).toBe(0)
    c.pointer(5, 6)
    c.reset()
    f.run()
    expect(sent).toEqual(['move 3,4'])
    expect(c.pending).toBe(false)
  })
})

/** Fast-path PDU với một update. */
function fastpath(code: number, body: number[]): number[] {
  const update = [code & 0x0f, body.length & 0xff, body.length >> 8, ...body]
  const length = update.length + 3
  return [0x00, 0x80 | (length >> 8), length & 0xff, ...update]
}

/** TS_UPDATE_BITMAP_DATA với một rectangle. */
function bitmap(bpp: number, compressed: boolean, payload = 20): number[] {
  const rect = [0, 0, 0, 0, 63, 0, 63, 0, 64, 0, 64, 0, bpp, 0, compressed ? 1 : 0, 0, payload, 0]
  return [1, 0, 1, 0, ...rect, ...Array<number>(payload).fill(0xaa)]
}

/** Surface bits với codec `id`. */
function surface(id: number): number[] {
  return [1, 0, 0, 0, 0, 0, 64, 0, 64, 0, 32, 0, 0, id, 64, 0, 64, 0, 4, 0, 0, 0, 1, 2, 3, 4]
}

describe('đọc loại mã hoá trên luồng server → client', () => {
  it('phân loại bitmap / RemoteFX / con trỏ, PDU bị cắt giữa các message', () => {
    const s = new RdpStreamSniffer()
    const a = fastpath(1, bitmap(16, true))
    const b = fastpath(4, surface(3))
    const p = fastpath(0x5, [])
    const stream = Uint8Array.from([...a, ...b, ...p, ...fastpath(1, bitmap(32, true))])
    // Cắt ở giữa header (sau 1 byte của PDU thứ hai) và giữa thân PDU cuối.
    const cut1 = a.length + 1
    const cut2 = stream.length - 10
    s.push(stream.subarray(0, cut1))
    s.push(stream.subarray(cut1, cut2))
    s.push(stream.subarray(cut2))
    expect(s.bytes.get('bitmap:16:1')).toBe(a.length)
    expect(s.bytes.get('surface:3')).toBe(b.length)
    expect(s.bytes.get('pointer')).toBe(p.length)
    expect(s.bytes.get('bitmap:32:1')).toBe(fastpath(1, bitmap(32, true)).length)
    const total = [...s.bytes.values()].reduce((n, v) => n + v, 0)
    expect(total).toBe(stream.length)
  })

  it('bắt đầu giữa PDU → bỏ tới message bắt đầu bằng header hợp lệ', () => {
    const s = new RdpStreamSniffer()
    s.push(Uint8Array.from([0xff, 0xfe, 0x01]))
    expect(s.bytes.size).toBe(0)
    const tpkt = [3, 0, 0, 8, 2, 0xf0, 0x80, 0]
    s.push(Uint8Array.from([...tpkt, ...fastpath(1, bitmap(16, false))]))
    expect(s.bytes.get('slowpath')).toBe(8)
    expect(s.bytes.get('bitmap:16:0')).toBeGreaterThan(0)
  })

  it('slow-path: bitmap / con trỏ / PDU điều khiển', () => {
    const slow = (pduType2: number, payload: number[]): number[] => {
      const shareData = [1, 0, 0, 0, 0, 1, 0, 0, pduType2, 0, 0, 0]
      const shareControl = [0, 0, 0x17, 0x00, 0xea, 0x03]
      const data = [...shareControl, ...shareData, ...payload]
      const mcs = [0x68, 0, 1, 3, 0xeb, 0x70, 0x80 | (data.length >> 8), data.length & 0xff]
      const pdu = [2, 0xf0, 0x80, ...mcs, ...data]
      const length = pdu.length + 4
      return [3, 0, length >> 8, length & 0xff, ...pdu]
    }
    const s = new RdpStreamSniffer()
    const bmp = slow(2, bitmap(24, true))
    const ptr = slow(0x1b, [1, 0, 0, 0])
    const ctl = slow(0x14, [1, 0, 0, 0])
    s.push(Uint8Array.from([...bmp, ...ptr, ...ctl]))
    expect(s.bytes.get('bitmap:24:1')).toBe(bmp.length)
    expect(s.bytes.get('pointer')).toBe(ptr.length)
    expect(s.bytes.get('slowpath')).toBe(ctl.length)
  })

  it('tên giao thức', () => {
    expect(codecLabel('bitmap:16:1')).toBe('Bitmap 16-bit RLE')
    expect(codecLabel('bitmap:32:1')).toBe('Bitmap 32-bit planar')
    expect(codecLabel('bitmap:24:0')).toBe('Bitmap 24-bit raw')
    expect(codecLabel('surface:3')).toBe('RemoteFX')
    expect(codecLabel('surface:0')).toBe('Surface raw')
  })
})
