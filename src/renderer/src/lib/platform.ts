import type { AppInfo } from '@shared/ipc'

/** Thông tin nền tảng, nạp một lần lúc khởi động (main.tsx) trước khi vẽ terminal. */
let info: AppInfo | null = null

export function setAppInfo(value: AppInfo): void {
  info = value
}

/** Tuỳ chọn ConPTY cho xterm.js — chỉ cho terminal local trên Windows. */
export function windowsPty(): { backend: 'conpty'; buildNumber?: number } | undefined {
  if (info?.platform !== 'win32') return undefined
  return info.windowsBuild
    ? { backend: 'conpty', buildNumber: info.windowsBuild }
    : { backend: 'conpty' }
}
