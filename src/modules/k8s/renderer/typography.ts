/**
 * Thang chữ của bảng chi tiết (docs/k8s-design-guide.md §2). Mỗi vai trò một kiểu — không tự đặt
 * cỡ chữ / độ đậm / font riêng trong từng mục:
 *
 * - Heading mục: `Heading` (11 px, chữ hoa, `tracking-wider`) — chỉ heading mới viết hoa.
 * - Nhãn (tên trường, ô số liệu, đầu cột): 11–12 px `text-faint`, chữ thường.
 * - Giá trị: 12 px `text-fg`; số luôn `tabular-nums`.
 * - Định danh (tên tài nguyên, image, IP, selector, hash, lệnh): `font-mono` 11 px — mono 11 px
 *   cao ngang chữ thường 12 px nên một dòng trộn hai loại vẫn đều.
 */
export const TY = {
  /** Nhãn trường / dòng phụ. */
  label: 'text-xs text-faint',
  /** Đầu cột bảng, nhãn ô số liệu. */
  caption: 'text-[11px] font-medium text-faint',
  /** Giá trị thường. */
  value: 'text-xs text-fg',
  /** Định danh (tên tài nguyên, image, IP, selector…). */
  id: 'font-mono text-[11px]',
  /** Số trong ô số liệu. */
  stat: 'text-sm leading-5 font-semibold tabular-nums'
} as const
