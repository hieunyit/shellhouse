/**
 * Tìm kiếm mờ kiểu fzf: các ký tự của truy vấn phải xuất hiện theo thứ tự.
 * Điểm cao hơn khi khớp liền nhau, khớp đầu từ, và khớp ở đầu chuỗi. null = không khớp.
 */
/** Chữ thường, bỏ dấu (tiếng Việt: "chào" → "chao", "đ" → "d"). */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
}

/**
 * Khoảng cách tối đa (ký tự) giữa hai ký tự khớp liên tiếp. Không giới hạn thì truy vấn ngắn khớp
 * "rải" khắp một chuỗi dài ("theme" khớp "Import hosts (ssh config, MobaXterm…)") — toàn kết quả rác.
 */
const MAX_GAP = 10

export function fuzzyScore(query: string, text: string): number | null {
  const q = foldText(query).replace(/\s+/g, '')
  if (!q) return 0
  const t = foldText(text)
  let score = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    if (ti > 0 && found - ti > MAX_GAP) return null
    const boundary = found === 0 || /[\s._@:/-]/.test(t[found - 1] ?? '')
    streak = found === ti && ti > 0 ? streak + 1 : 0
    score += 1 + streak * 5 + (boundary ? 4 : 0) - Math.min(found - ti, 5) * 0.5
    ti = found + 1
  }
  if (t.startsWith(q)) score += 10
  if (t === q) score += 20
  return score
}

/** Lấy điểm tốt nhất trên nhiều trường (label, hostname, user, tag...). */
export function bestScore(query: string, fields: readonly string[]): number | null {
  let best: number | null = null
  for (const field of fields) {
    const s = fuzzyScore(query, field)
    if (s !== null && (best === null || s > best)) best = s
  }
  return best
}
