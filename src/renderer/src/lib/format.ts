/** Dung lượng dễ đọc: 1000 B, 12.3 KB, 4.5 MB, 1.25 GB… */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n < 1000 * 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  return `${(n / 1024 ** 4).toFixed(2)} TB`
}

/** Bỏ tiền tố "Error invoking remote method '…': Error: " của Electron. */
export function cleanError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
}

/** Ngày giờ dạng số theo thói quen máy người dùng (không có chữ → giao diện vẫn thuần tiếng Anh). */
export const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

/** Thứ tự tên tự nhiên: file2 < file10, không phân biệt hoa thường. */
export const nameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** "vừa xong", "5 min ago", "3 h ago", "2 days ago", rồi ngày cụ thể. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${String(m)} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${String(h)} h ago`
  const d = Math.round(h / 24)
  if (d < 7) return d === 1 ? 'yesterday' : `${String(d)} days ago`
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}
