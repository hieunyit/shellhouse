/**
 * Mức rủi ro của hộp thoại xác nhận (README thiết kế mục 7.2, quyết định của người dùng 04/10/2026):
 * - normal: hành động thường, có thể hoàn tác → nút primary.
 * - danger: phá huỷ nhưng KHÔNG phải production (kể cả staging / dev) → nút đỏ, Huỷ được focus sẵn.
 * - production: phá huỷ trên PRODUCTION → nút đỏ + gõ đúng tên để xác nhận (phân biệt hoa thường,
 *   chặn dán / kéo thả chữ vào ô).
 */
export type ConfirmRisk = 'normal' | 'danger' | 'production'

export function requiresTyping(risk: ConfirmRisk): boolean {
  return risk === 'production'
}

/** Khớp tuyệt đối (phân biệt hoa thường), chỉ bỏ khoảng trắng hai đầu do gõ nhầm. */
export function confirmMatches(typed: string, expected: string): boolean {
  return expected.length > 0 && typed.trim() === expected
}

/** Nút xác nhận bấm được chưa. */
export function canConfirm(
  risk: ConfirmRisk,
  typed: string,
  expected: string | undefined
): boolean {
  if (!requiresTyping(risk)) return true
  return expected !== undefined && confirmMatches(typed, expected)
}

/**
 * Chữ người dùng gõ có đang "đi đúng hướng" không — để chỉ báo lỗi khi đã gõ sai (không đỏ ngay khi
 * mới gõ được vài ký tự đúng).
 */
export function typedIsPrefix(typed: string, expected: string): boolean {
  return expected.startsWith(typed.trimStart())
}
