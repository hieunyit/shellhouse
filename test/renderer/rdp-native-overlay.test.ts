// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  collectOverlayRects,
  HOLE_MARGIN,
  intersect,
  planOverlay,
  sameOverlay
} from '../../src/renderer/src/rdp-native/overlay'

const view = { x: 100, y: 50, width: 1000, height: 600 }

describe('rdp-native: lớp phủ đè lên vùng RDP', () => {
  it('giao hai hình chữ nhật', () => {
    expect(
      intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })
    ).toEqual({ x: 5, y: 5, width: 5, height: 5 })
    expect(
      intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })
    ).toBeNull()
  })

  it('không đè → none; menu / toast nhỏ → khoét lỗ (tương đối vùng RDP, nới mép)', () => {
    expect(planOverlay(view, [])).toEqual({ mode: 'none' })
    // Thanh bên bên trái, không chạm vùng RDP (kể cả phần nới mép).
    expect(planOverlay(view, [{ x: 0, y: 0, width: 80, height: 800 }])).toEqual({ mode: 'none' })
    const toast = { x: 800, y: 560, width: 280, height: 60 }
    expect(planOverlay(view, [toast])).toEqual({
      mode: 'holes',
      holes: [
        {
          x: 700 - HOLE_MARGIN,
          y: 510 - HOLE_MARGIN,
          width: 280 + 2 * HOLE_MARGIN,
          height: 60 + 2 * HOLE_MARGIN
        }
      ]
    })
  })

  it('hộp thoại có nền mờ toàn cửa sổ / quá nhiều lỗ → ẩn hẳn', () => {
    expect(planOverlay(view, [{ x: 0, y: 0, width: 1400, height: 900 }])).toEqual({ mode: 'hide' })
    const many = Array.from({ length: 9 }, (_, i) => ({
      x: 120 + i * 100,
      y: 60,
      width: 20,
      height: 20
    }))
    expect(planOverlay(view, many)).toEqual({ mode: 'hide' })
    expect(planOverlay({ x: 0, y: 0, width: 0, height: 0 }, many)).toEqual({ mode: 'none' })
  })

  it('so kế hoạch', () => {
    expect(sameOverlay({ mode: 'none' }, { mode: 'none' })).toBe(true)
    expect(sameOverlay({ mode: 'none' }, { mode: 'hide' })).toBe(false)
  })

  it('DOM: lấy khung fixed ngoài cùng của lớp phủ, bỏ qua chính tab RDP và nội dung thường', () => {
    document.body.innerHTML = `
      <div id="rdp"><div role="status" style="position: fixed">mine</div></div>
      <div id="sidebar"><ul role="listbox"><li>host</li></ul></div>
      <div id="backdrop" style="position: fixed"><div role="dialog">Settings</div></div>
      <div id="toasts" style="position: fixed"><div role="status">a</div><div role="alert">b</div></div>
      <div id="menu" role="menu" style="position: fixed"></div>
      <div id="peek" data-peek="open" style="position: absolute"></div>
      <div id="peek-closed" data-peek="closed" style="position: absolute"></div>
    `
    const rects: Record<string, DOMRect> = {
      backdrop: new DOMRect(0, 0, 1400, 900),
      toasts: new DOMRect(800, 560, 280, 120),
      menu: new DOMRect(0, 0, 0, 0),
      peek: new DOMRect(0, 44, 280, 700),
      'peek-closed': new DOMRect(0, 44, 280, 700)
    }
    for (const [id, rect] of Object.entries(rects)) {
      const el = document.getElementById(id)
      if (el) el.getBoundingClientRect = () => rect
    }
    const out = collectOverlayRects(document, document.getElementById('rdp'))
    // Toast hai cái chung một khung; menu đang ẩn (0×0) bị bỏ; listbox của thanh bên không phải lớp phủ.
    // Thanh bên dạng gọn đang mở tạm (absolute) cũng là lớp phủ; đã đóng thì không.
    expect(out).toEqual([
      { x: 0, y: 44, width: 280, height: 700 },
      { x: 0, y: 0, width: 1400, height: 900 },
      { x: 800, y: 560, width: 280, height: 120 }
    ])
  })
})
