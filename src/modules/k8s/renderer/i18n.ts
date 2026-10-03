import { t } from '../../registry/renderer-kit'

/**
 * Từ trùng chữ với chỗ khác của app nhưng nghĩa khác trong Kubernetes ("Completions" của Job ≠ gợi
 * ý của editor, "Label" của Kubernetes ≠ tên hiển thị của host): tra khoá có ngữ cảnh `k8s|…` trước
 * (src/shared/i18n/vi/k8s.ts), không có thì dịch như thường. Tiếng Anh: hiện nguyên văn.
 */
export function tk(text: string): string {
  const key = `k8s|${text}`
  const value = t(key)
  return value === key ? t(text) : value
}
