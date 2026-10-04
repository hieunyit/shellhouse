import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  TitleBarOverlayOptions
} from 'electron'

/**
 * Cửa sổ không có thanh tiêu đề của hệ điều hành (kiểu Linear): title bar tự vẽ của app (cao 38 px,
 * nền khung — shell/TitleBar) là vùng kéo cửa sổ (`-webkit-app-region: drag` trong styles.css).
 * - macOS: `hiddenInset` — ba nút đèn giao thông nằm trong thanh trên cùng, căn giữa theo chiều dọc.
 * - Windows / Linux: `hidden` + `titleBarOverlay` — nút thu nhỏ / phóng to / đóng do Electron vẽ ở góc
 *   phải, màu theo theme của app (renderer chừa chỗ bằng env(titlebar-area-*)).
 * Nhấp đúp vào vùng kéo để phóng to là hành vi gốc của hệ điều hành (theo cài đặt của người dùng).
 */

/** Chiều cao title bar của app (--ds-titlebar-h). */
export const TOP_BAR_HEIGHT = 38

/** Title bar không có viền dưới (cùng nền khung) → nút cửa sổ cao bằng cả thanh. */
const OVERLAY_HEIGHT = TOP_BAR_HEIGHT

/** Nền / màu biểu tượng của title bar — trùng --ds-bg / --ds-fg-2 trong ds/tokens.css. */
const TOP_BAR_COLORS = {
  dark: { color: '#08090a', symbolColor: '#a1a4ab' },
  light: { color: '#eceef1', symbolColor: '#50545b' }
} as const

/** Nền cửa sổ trước khi renderer vẽ — trùng --ds-bg. */
export function windowBackground(dark: boolean): string {
  return dark ? '#08090a' : '#eceef1'
}

export function titleBarOverlay(dark: boolean): TitleBarOverlayOptions {
  return { ...TOP_BAR_COLORS[dark ? 'dark' : 'light'], height: OVERLAY_HEIGHT }
}

/** Tuỳ chọn khung cửa sổ theo nền tảng (gộp vào BrowserWindowConstructorOptions). */
export function windowChromeOptions(
  platform: NodeJS.Platform,
  dark: boolean
): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay'
> {
  if (platform === 'darwin') {
    // Đèn giao thông (~14 px) căn giữa trong title bar 38 px.
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } }
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(dark) }
}

/** Đổi theme: cập nhật nền cửa sổ và màu nút điều khiển (Windows / Linux). */
export function applyWindowTheme(
  window: Pick<BrowserWindow, 'setBackgroundColor' | 'setTitleBarOverlay'>,
  platform: NodeJS.Platform,
  dark: boolean
): void {
  window.setBackgroundColor(windowBackground(dark))
  if (platform === 'darwin') return
  try {
    window.setTitleBarOverlay(titleBarOverlay(dark))
  } catch {
    // Trình quản lý cửa sổ không hỗ trợ overlay → nút vẫn giữ màu cũ, không phải lỗi nghiêm trọng.
  }
}
