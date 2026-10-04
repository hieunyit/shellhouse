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

/**
 * Khoảng đệm (px) chống dao động: đổi mức gọn làm thanh công cụ xuống dòng / hiện thanh cuộn →
 * độ rộng đo lại đổi vài px → mức gọn đổi ngược lại… (vòng lặp vẽ lại liên tục ở sát ngưỡng).
 * Chỉ lên mức rộng hơn khi vượt ngưỡng + HYSTERESIS; xuống mức hẹp hơn ngay khi dưới ngưỡng.
 */
export const HYSTERESIS = 32

const ORDER: readonly ToolbarFit[] = ['narrow', 'compact', 'full']

export function toolbarFitStable(width: number, prev: ToolbarFit | null): ToolbarFit {
  const next = toolbarFit(width)
  if (!prev || width <= 0) return next
  // Hẹp lại: theo ngay. Rộng ra: chỉ khi đủ chỗ cả khoảng đệm.
  if (ORDER.indexOf(next) <= ORDER.indexOf(prev)) return next
  return toolbarFit(width - HYSTERESIS) === next ? next : prev
}

/** panelOverlay có khoảng đệm: đã nổi thì chỉ thôi nổi khi rộng hơn ngưỡng + HYSTERESIS. */
export function panelOverlayStable(width: number, prev: boolean | null): boolean {
  const next = panelOverlay(width)
  if (prev === null || width <= 0 || next === prev) return next
  return prev ? panelOverlay(width - HYSTERESIS) : next
}
