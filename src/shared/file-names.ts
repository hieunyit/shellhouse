/** Thay ký tự Windows không cho phép trong tên file (và ký tự điều khiển) bằng "_". */
export function replaceUnsafeFileChars(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\p{Cc}/gu, '_')
}
