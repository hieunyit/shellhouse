import type { ModuleManifest } from './types'

/**
 * Tìm module trên máy theo manifest (ADR-014 mục 3.12.2) — không gọi mạng. Dùng ở trang Modules và
 * bảng lệnh.
 */

/** Chữ thường, bỏ dấu (tiếng Việt: đ → d). */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
}

function words(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** Khác nhau đúng ≤ 1 thao tác (thêm / xoá / thay một ký tự). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  const [s, t] = a.length <= b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let edits = 0
  while (i < s.length && j < t.length) {
    if (s[i] === t[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (s.length === t.length) i++
    j++
  }
  return edits + (t.length - j) <= 1
}

/**
 * Điểm của một module cho câu tìm (0 = không khớp):
 * khớp đầu tên (100) > một từ trong tên (80) > từ khoá (60) > summary (40) > description (20) >
 * gần đúng (10). Module đang bật +5.
 */
export function scoreModule(manifest: ModuleManifest, query: string, enabled: boolean): number {
  const q = normalize(query)
  if (!q) return 1 + (enabled ? 5 : 0)
  const name = normalize(manifest.name)
  let score = 0
  if (name.startsWith(q)) score = 100
  else if (words(manifest.name).some((w) => w.startsWith(q))) score = 80
  else if (manifest.keywords.some((k) => normalize(k).startsWith(q) || normalize(k) === q))
    score = 60
  else if (normalize(manifest.summary).includes(q)) score = 40
  else if (normalize(manifest.description).includes(q)) score = 20
  else if (q.length >= 5) {
    const candidates = [...words(manifest.name), ...manifest.keywords.flatMap((k) => words(k))]
    if (candidates.some((w) => w.length >= 5 && withinOneEdit(w, q))) score = 10
  }
  if (score === 0) return 0
  return score + (enabled ? 5 : 0)
}

/** Lọc + sắp giảm theo điểm, cùng điểm theo tên. */
export function searchModules<T extends { manifest: ModuleManifest; enabled: boolean }>(
  items: readonly T[],
  query: string
): T[] {
  return items
    .map((item) => ({ item, score: scoreModule(item.manifest, query, item.enabled) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.item.manifest.name.localeCompare(b.item.manifest.name))
    .map((r) => r.item)
}
