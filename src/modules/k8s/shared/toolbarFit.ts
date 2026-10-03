/**
 * Mức gọn của thanh công cụ bản đồ theo độ rộng thật (ResizeObserver) — cửa sổ hẹp, sidebar host
 * mở rộng, danh sách tài nguyên đều ăn chỗ:
 * - `full`: đủ chữ trên mọi nút.
 * - `compact`: Traffic / View chỉ còn icon, chip lỗi chỉ còn số (chữ đầy đủ ở tooltip).
 * - `narrow`: chọn chế độ xem thành menu thả, lọc nhãn vào menu View.
 */
export type ToolbarFit = 'full' | 'compact' | 'narrow'

export const FULL_TOOLBAR = 1040
export const COMPACT_TOOLBAR = 720

/** 0 = chưa đo (lần vẽ đầu) → coi như đủ chỗ, tránh nháy sang dạng gọn. */
export function toolbarFit(width: number): ToolbarFit {
  if (width <= 0 || width >= FULL_TOOLBAR) return 'full'
  return width >= COMPACT_TOOLBAR ? 'compact' : 'narrow'
}

/**
 * Bảng chi tiết của bản đồ chiếm tối đa 40% — khung hẹp tới mức 40% không đủ cho bảng (< 300 px)
 * thì bảng nổi đè lên canvas thay vì ép cả hai.
 */
export function panelOverlay(width: number): boolean {
  return width > 0 && width * 0.4 < 300
}
