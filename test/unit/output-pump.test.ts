import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputPump, type PumpLimits } from '../../src/session-host/stream/output-pump'

const limits: PumpLimits = {
  maxBatchBytes: 10,
  flushIntervalMs: 8,
  highWatermarkBytes: 30,
  lowWatermarkBytes: 10
}

function setup() {
  const sent: Uint8Array[] = []
  const source = { pause: vi.fn(), resume: vi.fn() }
  const pump = new OutputPump((chunk) => sent.push(chunk), source, limits)
  return { sent, source, pump }
}

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('OutputPump', () => {
  it('gom nhiều mẩu nhỏ thành một frame sau flushInterval', () => {
    const { sent, pump } = setup()
    pump.push(bytes(2, 1))
    pump.push(bytes(3, 2))
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(8)
    expect(sent).toHaveLength(1)
    expect([...(sent[0] ?? [])]).toEqual([1, 1, 2, 2, 2])
  })

  it('không kéo dài hạn gửi khi dữ liệu tiếp tục đến', () => {
    const { sent, pump } = setup()
    pump.push(bytes(1))
    vi.advanceTimersByTime(5)
    pump.push(bytes(1))
    vi.advanceTimersByTime(3)
    expect(sent).toHaveLength(1)
  })

  it('gửi ngay khi đủ maxBatchBytes và chia frame lớn', () => {
    const { sent, pump } = setup()
    pump.push(bytes(25))
    expect(sent.map((c) => c.byteLength)).toEqual([10, 10, 5])
  })

  it('bỏ qua mẩu rỗng', () => {
    const { sent, pump } = setup()
    pump.push(new Uint8Array(0))
    vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(0)
  })

  it('tạm dừng nguồn khi vượt high watermark và chạy lại dưới low watermark', () => {
    const { source, pump } = setup()
    pump.push(bytes(20))
    expect(source.pause).not.toHaveBeenCalled()
    pump.push(bytes(10))
    expect(source.pause).toHaveBeenCalledTimes(1)
    expect(pump.isPaused).toBe(true)

    pump.ack(15) // còn 15 ≥ low
    expect(source.resume).not.toHaveBeenCalled()
    pump.ack(10) // còn 5 < low
    expect(source.resume).toHaveBeenCalledTimes(1)
    expect(pump.isPaused).toBe(false)
  })

  it('chỉ pause một lần dù tiếp tục nhận dữ liệu', () => {
    const { source, pump } = setup()
    pump.push(bytes(40))
    pump.push(bytes(40))
    expect(source.pause).toHaveBeenCalledTimes(1)
  })

  it('ack thừa không làm số byte chưa ack âm', () => {
    const { pump } = setup()
    pump.push(bytes(10))
    pump.ack(1_000)
    expect(pump.unackedBytes).toBe(0)
  })

  it('dispose huỷ timer và bỏ dữ liệu đang gom', () => {
    const { sent, pump } = setup()
    pump.push(bytes(3))
    pump.dispose()
    vi.advanceTimersByTime(100)
    pump.push(bytes(30))
    expect(sent).toHaveLength(0)
  })

  it('mọi frame gửi đi sở hữu ArrayBuffer riêng đúng kích thước', () => {
    const { sent, pump } = setup()
    const slab = new Uint8Array(100).fill(9)
    pump.push(slab.subarray(10, 13)) // view lệch offset, như Buffer của Node
    pump.flush()
    pump.push(bytes(25)) // bị chia thành nhiều frame
    for (const frame of sent) {
      expect(frame.byteOffset).toBe(0)
      expect(frame.buffer.byteLength).toBe(frame.byteLength)
    }
    expect([...(sent[0] ?? [])]).toEqual([9, 9, 9])
  })

  it('flush chủ động gửi phần còn lại (dùng khi tiến trình thoát)', () => {
    const { sent, pump } = setup()
    pump.push(bytes(3))
    pump.flush()
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(1)
  })
})
