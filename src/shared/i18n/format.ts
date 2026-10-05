import { locale, t } from './index'

/**
 * Định dạng theo locale đang dùng (đặt bởi `setLanguage`). Formatter Intl tạo lười và nhớ theo
 * locale — tạo Intl.* tốn hơn dùng lại nhiều lần.
 */

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>()

function dateFormatter(kind: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d:${kind}:${locale()}`
  let f = cache.get(key) as Intl.DateTimeFormat | undefined
  if (!f) {
    f = new Intl.DateTimeFormat(locale(), options)
    cache.set(key, f)
  }
  return f
}

function numberFormatter(kind: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n:${kind}:${locale()}`
  let f = cache.get(key) as Intl.NumberFormat | undefined
  if (!f) {
    f = new Intl.NumberFormat(locale(), options)
    cache.set(key, f)
  }
  return f
}

type DateInput = number | string | Date

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value)
}

/** Ngày + giờ dạng số: 17/08/2026, 22:44 (vi) · 08/17/2026, 10:44 PM (en-US). */
export function formatDateTime(value: DateInput): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return '—'
  return dateFormatter('datetime', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(d)
}

/** Ngày + giờ có giây (log, sự kiện). */
export function formatDateTimeSeconds(value: DateInput): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return '—'
  return dateFormatter('datetime-s', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(d)
}

/** Chỉ ngày, tháng viết tắt: 17 thg 8, 2026 (vi) · Aug 17, 2026 (en). */
export function formatDate(value: DateInput): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return '—'
  return dateFormatter('date', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

/** Thứ, ngày tháng (lời chào Home): Thứ Hai, 5 tháng 10 (vi) · Monday, October 5 (en). */
export function formatLongDay(value: DateInput): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return '—'
  return dateFormatter('longDay', { weekday: 'long', day: 'numeric', month: 'long' }).format(d)
}

/** Chỉ giờ: 22:44:05 (vi) · 10:44:05 PM (en-US). */
export function formatTime(value: DateInput, seconds = true): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return '—'
  return dateFormatter(seconds ? 'time-s' : 'time', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {})
  }).format(d)
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", rồi ngày cụ thể. */
export function formatRelative(value: DateInput, now = Date.now()): string {
  const ms = toDate(value).getTime()
  if (Number.isNaN(ms)) return '—'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return t('just now')
  const m = Math.round(s / 60)
  if (m < 60) return t('{n} min ago', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('{n} h ago', { n: h })
  const d = Math.round(h / 24)
  if (d === 1) return t('yesterday')
  if (d < 7) return t('{n} days ago', { n: d })
  return formatDate(ms)
}

/** Số nguyên / thập phân theo locale: 12,345 (en) · 12.345 (vi). */
export function formatNumber(value: number, maximumFractionDigits = 2): string {
  return numberFormatter(`num${String(maximumFractionDigits)}`, { maximumFractionDigits }).format(
    value
  )
}

/** Phần trăm: 0.42 → 42% ; `digits` chữ số thập phân. */
export function formatPercent(ratio: number, digits = 0): string {
  return numberFormatter(`pct${String(digits)}`, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(ratio)
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Dung lượng dễ đọc (cơ số 1024): 1.0 KB, 12.3 MB, 1.25 GB — dấu thập phân theo locale. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  const sign = bytes < 0 ? '-' : ''
  let n = Math.abs(bytes)
  // Đổi đơn vị từ 1000 (không đợi 1024): tránh "1000 B" / "1010 KB" — hiện "1.0 KB" / "1.0 MB".
  if (n < 1000) return `${sign}${formatNumber(n, 0)} B`
  let unit = 0
  while (n >= 1000 && unit < UNITS.length - 1) {
    n /= 1024
    unit++
  }
  const digits = unit >= 3 ? 2 : 1
  const text = numberFormatter(`bytes${String(digits)}`, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(n)
  return `${sign}${text} ${UNITS[unit] ?? 'B'}`
}

/** Tốc độ: 1.2 MB/s. */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Khoảng thời gian ngắn gọn: 45s, 3m 12s, 2h 05m, 3d 4h. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${String(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${String(m)}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${String(h)}h ${String(m % 60).padStart(2, '0')}m`
  const d = Math.floor(h / 24)
  return `${String(d)}d ${String(h % 24)}h`
}

/** So sánh tên tự nhiên theo locale (file2 < file10, không phân biệt hoa thường). */
export function nameCollator(): Intl.Collator {
  const key = `c:${locale()}`
  let c = cache.get(key) as unknown as Intl.Collator | undefined
  if (!c) {
    c = new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' })
    cache.set(key, c as unknown as Intl.NumberFormat)
  }
  return c
}
