import { bestScore } from '@shared/fuzzy'

/** Mục chọn được trong Combobox / SearchList (logic thuần — test được không cần DOM). */
export interface Pickable {
  value: string
  label: string
  /** Chữ phụ bên phải (mờ) — cũng được tìm. */
  hint?: string
  /** Từ khoá tìm thêm (tag, địa chỉ…) — không hiện. */
  keywords?: readonly string[]
  /**
   * Nhóm (tiêu đề nhỏ trong danh sách). Nhóm giữ thứ tự xuất hiện đầu tiên trong `options` — kể cả
   * khi đang tìm: mục của nhóm đầu (vd. "Jump hosts") luôn đứng trước, trong nhóm xếp theo điểm.
   */
  group?: string
  disabled?: boolean
}

/**
 * Lọc + xếp + cắt: không tìm → giữ thứ tự của người gọi (theo nhóm); có tìm → tìm mờ trên nhãn,
 * chữ phụ, từ khoá (không tìm theo `value` — thường là id). `more` = số mục khớp bị ẩn do `limit`
 * (danh sách dài vài trăm host chỉ hiện một ít, gõ để thu hẹp).
 */
export function pickResults<T extends Pickable>(
  options: readonly T[],
  query: string,
  limit = Number.POSITIVE_INFINITY
): { shown: T[]; more: number } {
  const groups = new Map<string | undefined, number>()
  for (const o of options) if (!groups.has(o.group)) groups.set(o.group, groups.size)
  const rank = (o: T): number => groups.get(o.group) ?? 0
  const q = query.trim()
  const list = (
    q
      ? options
          .map((o, i) => ({
            o,
            i,
            score: bestScore(q, [o.label, o.hint ?? '', ...(o.keywords ?? [])])
          }))
          .filter((r): r is { o: T; i: number; score: number } => r.score !== null)
      : options.map((o, i) => ({ o, i, score: 0 }))
  )
    .sort((a, b) => rank(a.o) - rank(b.o) || b.score - a.score || a.i - b.i)
    .map((r) => r.o)
  return { shown: list.slice(0, limit), more: Math.max(0, list.length - limit) }
}
