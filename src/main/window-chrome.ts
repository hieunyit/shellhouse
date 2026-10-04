import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  TitleBarOverlayOptions
} from 'electron'

/**
 * Cửa sổ không có thanh tiêu đề của hệ điều hành (kiểu Linear): thanh trên cùng của app (thanh
 * công cụ + đầu thanh bên, cao 44 px) là vùng kéo cửa sổ (`-webkit-app-region: drag` trong
 * styles.css).
 * - macOS: `hiddenInset` — ba nút đèn giao thông nằm trong thanh trên cùng, căn giữa theo chiều dọc.
 * - Windows / Linux: `hidden` + `titleBarOverlay` — nút thu nhỏ / phóng to / đóng do Electron vẽ ở góc
 *   phải, màu theo theme của app (renderer chừa chỗ bằng env(titlebar-area-*)).
 * Nhấp đúp vào vùng kéo để phóng to là hành vi gốc của hệ điều hành (theo cài đặt của người dùng).
 */

/** Chiều cao thanh trên cùng của app (TabBar h-11). */
export const TOP_BAR_HEIGHT = 44

/** Nút điều khiển cửa sổ (Windows / Linux) cao hơn 1 px thì đè lên viền dưới của thanh trên cùng. */
const OVERLAY_HEIGHT = TOP_BAR_HEIGHT - 1

/** Nền / màu biểu tượng của thanh trên cùng — trùng --sh-surface / --sh-muted trong styles.css. */
const TOP_BAR_COLORS = {
  dark: { color: '#14171b', symbolColor: '#a3abb5' },
  light: { color: '#ffffff', symbolColor: '#4b5360' }
} as const

/** Nền cửa sổ trước khi renderer vẽ — trùng --sh-canvas. */
export function windowBackground(dark: boolean): string {
  return dark ? '#0d0f12' : '#f4f5f7'
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
    // Đèn giao thông (~14 px) căn giữa trong thanh 44 px; x khớp lề trái của đầu thanh bên.
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } }
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
