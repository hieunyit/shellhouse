import { join } from 'node:path'
import { replaceUnsafeFileChars } from '@shared/file-names'
import type { AppSettings } from '@shared/settings'

export interface SessionLogConfig {
  path: string
  stripAnsi: boolean
  header: string
}

/** Tên dùng làm thư mục / file: bỏ ký tự Windows không cho phép, giữ ngắn. */
export function safeFileName(name: string): string {
  const cleaned = replaceUnsafeFileChars(name)
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
  return cleaned || 'session'
}

function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_` +
    `${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  )
}

/**
 * Đường dẫn log cho một phiên theo cài đặt, hoặc null nếu không ghi.
 * `<thư mục>/<tên phiên>/<ngày_giờ>.log` — mỗi host một thư mục, dễ tìm lại.
 */
export function sessionLogFor(
  settings: AppSettings['logging'],
  session: { kind: 'local' | 'ssh'; label: string },
  defaultDirectory: string,
  now = new Date()
): SessionLogConfig | null {
  if (settings.mode === 'off') return null
  if (settings.mode === 'ssh' && session.kind === 'local') return null
  const directory = settings.directory.trim() || defaultDirectory
  const folder = safeFileName(session.label)
  return {
    path: join(directory, folder, `${stamp(now)}.log`),
    stripAnsi: settings.stripAnsi,
    header: `=== Shellhouse session log: ${session.label} — started ${now.toISOString()} ===`
  }
}
