import { useTabs } from '../stores/tabs'

/**
 * Tài liệu mở trong editor của app: nơi đọc / ghi (SFTP của một tab, S3…) do nơi mở cung cấp.
 * Chỉ trong bộ nhớ — đóng app là hết (không mở lại khi khôi phục workspace).
 */

/**
 * Phiên bản file trên nơi lưu (phát hiện bị sửa nơi khác khi lưu) — do nơi chứa tự định nghĩa:
 * SFTP dùng mtime + size, S3 dùng ETag. Editor chỉ giữ và trả lại.
 */
export type EditorVersion = Readonly<Record<string, unknown>>

export interface EditorDoc {
  /** Duy nhất theo nơi + đường dẫn: mở lại cùng file → về tab đang mở. */
  key: string
  name: string
  path: string
  /** Nơi chứa file, hiện trên thanh editor ("web-01", "S3 · bucket"…). */
  where: string
  read: () => Promise<{ bytes: Uint8Array; version: EditorVersion | null }>
  /** `expect` = phiên bản lúc mở / lưu gần nhất; null = ghi đè không kiểm tra. */
  write: (bytes: Uint8Array, expect: EditorVersion | null) => Promise<EditorVersion | null>
  /** Lỗi từ write là "file đã bị sửa nơi khác". */
  isConflict: (error: unknown) => boolean
}

const docs = new Map<string, EditorDoc>()

/** Mở tài liệu trong tab editor (đã mở → chuyển tới tab đó). */
export function openEditorDoc(doc: EditorDoc): string {
  docs.set(doc.key, doc)
  return useTabs.getState().openEditor(doc.name, doc.key)
}

export function editorDoc(key: string): EditorDoc | undefined {
  return docs.get(key)
}

/** Đuôi file chắc chắn nhị phân — không thử mở bằng editor của app. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|so|dll|exe|bin|iso|img|qcow2|deb|rpm|apk|mp[34]|mkv|mov|avi|wav|flac|ogg|woff2?|ttf|otf|sqlite|db|class|pyc|o|a|parquet)$/i
export function isBinaryName(name: string): boolean {
  return BINARY_EXT.test(name)
}

/** Byte có vẻ là file nhị phân (có NUL trong 8 KB đầu). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

export function fromBase64(data: string): Uint8Array {
  const bin = atob(data)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}
