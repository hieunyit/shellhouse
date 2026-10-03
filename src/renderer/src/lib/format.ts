import { formatBytes, formatDateTime, formatRelative, nameCollator } from '@shared/i18n/format'

/** Dung lượng dễ đọc: 1000 B, 12.3 KB, 4.5 MB, 1.25 GB… (dấu thập phân theo locale). */
export function formatSize(n: number): string {
  return formatBytes(n)
}

/** Bỏ tiền tố "Error invoking remote method '…': Error: " của Electron. */
export function cleanError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
}

/** Ngày giờ dạng số theo locale giao diện (17/08/2026, 22:44 · 08/17/2026, 10:44 PM). */
export const dateFormat = {
  format: (value: number | Date): string => formatDateTime(value)
}

/** Thứ tự tên tự nhiên theo locale giao diện: file2 < file10, không phân biệt hoa thường. */
export const nameOrder = {
  compare: (a: string, b: string): number => nameCollator().compare(a, b)
}

/** "just now", "5 min ago", "3 h ago", "yesterday", rồi ngày cụ thể — theo ngôn ngữ giao diện. */
export function ago(ms: number, now = Date.now()): string {
  return formatRelative(ms, now)
}
