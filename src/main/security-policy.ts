import { pathToFileURL } from 'node:url'

// Hàm thuần, không phụ thuộc Electron — để unit test được.

/** Link ngoài chỉ được mở bằng trình duyệt hệ thống và chỉ với http/https. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Pathname của URL file: đã giải mã %xx; Windows không phân biệt hoa thường. */
function filePathname(url: URL, platform: NodeJS.Platform): string | null {
  try {
    const path = decodeURIComponent(url.pathname)
    return platform === 'win32' ? path.toLowerCase() : path
  } catch {
    return null
  }
}

/**
 * URL mà renderer của app được phép ở lại (và được gọi IPC). Bản dev: đúng origin của dev server.
 * Bản build: ĐÚNG file index.html của renderer (bỏ qua #hash / ?query) — không phải mọi file:
 * (một file HTML bất kỳ trên đĩa mà được nạp vào cửa sổ sẽ có toàn quyền IPC).
 */
export function isAppUrl(
  raw: string,
  devServerUrl: string | undefined,
  appIndexHtml: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  try {
    const url = new URL(raw)
    if (devServerUrl) return url.origin === new URL(devServerUrl).origin
    // host khác rỗng = đường dẫn mạng (file://server/share/...) — không bao giờ là app.
    if (url.protocol !== 'file:' || url.host !== '') return false
    const actual = filePathname(url, platform)
    return actual !== null && actual === filePathname(pathToFileURL(appIndexHtml), platform)
  } catch {
    return false
  }
}
