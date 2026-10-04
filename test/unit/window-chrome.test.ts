import { describe, expect, it, vi } from 'vitest'
import {
  applyWindowTheme,
  titleBarOverlay,
  TOP_BAR_HEIGHT,
  windowBackground,
  windowChromeOptions
} from '../../src/main/window-chrome'
import { DEFAULT_SETTINGS, parseSettings } from '../../src/shared/settings'

describe('cửa sổ không có thanh tiêu đề', () => {
  it('macOS: hiddenInset, đèn giao thông căn giữa thanh trên cùng; không dùng overlay', () => {
    const o = windowChromeOptions('darwin', true)
    expect(o.titleBarStyle).toBe('hiddenInset')
    expect(o.titleBarOverlay).toBeUndefined()
    const y = o.trafficLightPosition?.y ?? 0
    // Nút ~14 px nằm giữa thanh 44 px (±2 px).
    expect(Math.abs(y + 7 - TOP_BAR_HEIGHT / 2)).toBeLessThanOrEqual(2)
  })

  it('Windows / Linux: hidden + overlay theo theme, thấp hơn thanh 1 px (giữ viền dưới)', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const dark = windowChromeOptions(platform, true)
      expect(dark.titleBarStyle).toBe('hidden')
      expect(dark.titleBarOverlay).toEqual(titleBarOverlay(true))
    }
    expect(titleBarOverlay(true).height).toBe(TOP_BAR_HEIGHT - 1)
    expect(titleBarOverlay(true).color).not.toBe(titleBarOverlay(false).color)
    expect(windowBackground(true)).not.toBe(windowBackground(false))
  })

  it('đổi theme: cập nhật nền + nút cửa sổ; macOS không gọi overlay; lỗi overlay bị nuốt', () => {
    const win = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn() }
    applyWindowTheme(win, 'linux', false)
    expect(win.setBackgroundColor).toHaveBeenCalledWith(windowBackground(false))
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith(titleBarOverlay(false))
    const mac = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn() }
    applyWindowTheme(mac, 'darwin', true)
    expect(mac.setTitleBarOverlay).not.toHaveBeenCalled()
    const broken = {
      setBackgroundColor: vi.fn(),
      setTitleBarOverlay: vi.fn(() => {
        throw new Error('unsupported')
      })
    }
    expect(() => {
      applyWindowTheme(broken, 'linux', true)
    }).not.toThrow()
  })
})

describe('cài đặt giao diện mới', () => {
  it('mặc định tắt, mật độ comfortable; giá trị hỏng rơi về mặc định', () => {
    expect(DEFAULT_SETTINGS.appearance.newUi).toBe(false)
    expect(DEFAULT_SETTINGS.appearance.density).toBe('comfortable')
    const s = parseSettings({ appearance: { newUi: 'yes', density: 'tiny', theme: 'dark' } })
    expect(s.appearance.newUi).toBe(false)
    expect(s.appearance.density).toBe('comfortable')
    expect(s.appearance.theme).toBe('dark')
    expect(
      parseSettings({ appearance: { newUi: true, density: 'compact' } }).appearance
    ).toMatchObject({ newUi: true, density: 'compact' })
  })
})
