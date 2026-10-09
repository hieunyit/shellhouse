import { describe, expect, it } from 'vitest'
import { TmuxSlots } from '../../src/main/tmux-slots'

describe('phiên tmux theo tab', () => {
  it('số nhỏ nhất còn trống, riêng từng host; kết nối lại lấy lại đúng số', () => {
    const slots = new TmuxSlots()
    expect(slots.take('a', 'web')).toBe('shellhouse-1')
    expect(slots.take('b', 'web')).toBe('shellhouse-2')
    expect(slots.take('c', 'db')).toBe('shellhouse-1')
    // Tab a kết nối lại: phiên cũ đóng trước, phiên mới lấy lại số 1.
    slots.release('a')
    expect(slots.take('a2', 'web')).toBe('shellhouse-1')
    expect(slots.take('d', 'web')).toBe('shellhouse-3')
  })

  it('renderer tải lại: trả hết số — tab mở lại về shellhouse-1 như sau khi mở lại app', () => {
    const slots = new TmuxSlots()
    expect(slots.take('a', 'h1')).toBe('shellhouse-1')
    expect(slots.take('b', 'h1')).toBe('shellhouse-2')
    slots.releaseAll()
    expect(slots.take('c', 'h1')).toBe('shellhouse-1')
  })
})
