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

/** URL mà renderer của app được phép ở lại. */
export function isAppUrl(raw: string, devServerUrl: string | undefined): boolean {
  try {
    const url = new URL(raw)
    if (devServerUrl) return url.origin === new URL(devServerUrl).origin
    return url.protocol === 'file:'
  } catch {
    return false
  }
}
