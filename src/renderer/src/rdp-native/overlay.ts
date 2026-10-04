import type { RdpNativeOverlay, RdpNativeRect } from '@shared/rdp-native'

/**
 * Cửa sổ của control RDP gốc là cửa sổ Win32 nằm TRÊN nội dung web — hộp thoại, menu, toast của app
 * vẽ bên dưới nó. Tìm các lớp phủ đè lên vùng RDP và quyết định: khoét lỗ đúng chỗ lớp phủ (phần còn
 * lại vẫn chạy trực tiếp) hay ẩn hẳn cửa sổ native (lớp phủ che gần hết — hộp thoại có nền mờ toàn
 * màn hình) và hiện ảnh chụp thay vào.
 */

/** Phần tử được coi là lớp phủ (cộng thêm thuộc tính `data-sh-overlay` cho chỗ tự vẽ khác). */
export const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[role="alert"]',
  '[role="status"]',
  '[data-radix-popper-content-wrapper]'
].join(', ')

/**
 * Phần tử tự là lớp phủ dù không `position: fixed` (lấy đúng khung của nó): thanh bên dạng gọn đang
 * mở tạm (absolute, đè lên nội dung) và chỗ tự vẽ khác đánh dấu `data-sh-overlay`.
 */
export const SELF_OVERLAY_SELECTOR = '[data-peek="open"], [data-sh-overlay]'

/** Thuộc tính đổi thì quét lại lớp phủ (MutationObserver). */
export const OVERLAY_ATTRIBUTES = ['data-state', 'open', 'hidden', 'data-peek']

/** Nới mỗi lỗ chừng này CSS px (bóng đổ, viền bo của menu / toast). */
export const HOLE_MARGIN = 8
/** Tối đa số lỗ — nhiều hơn thì ẩn hẳn. */
export const MAX_HOLES = 8
/** Lớp phủ che quá tỉ lệ này của vùng RDP → ẩn hẳn (đỡ khoét lỗ vô ích). */
export const HIDE_COVERAGE = 0.5

export function intersect(a: RdpNativeRect, b: RdpNativeRect): RdpNativeRect | null {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null
}

const area = (r: RdpNativeRect): number => r.width * r.height

/**
 * Kế hoạch cho vùng RDP `view` (CSS px trong cửa sổ) với các lớp phủ `overlays` (CSS px). Lỗ trả về
 * tương đối với góc vùng RDP.
 */
export function planOverlay(
  view: RdpNativeRect,
  overlays: readonly RdpNativeRect[]
): RdpNativeOverlay {
  if (area(view) <= 0) return { mode: 'none' }
  const hits: RdpNativeRect[] = []
  for (const o of overlays) {
    const grown = {
      x: o.x - HOLE_MARGIN,
      y: o.y - HOLE_MARGIN,
      width: o.width + 2 * HOLE_MARGIN,
      height: o.height + 2 * HOLE_MARGIN
    }
    const hit = intersect(view, grown)
    if (hit) hits.push(hit)
  }
  if (hits.length === 0) return { mode: 'none' }
  // Tổng diện tích (có thể đếm chồng — chỉ để quyết định ẩn hẳn, không cần chính xác).
  const covered = hits.reduce((sum, r) => sum + area(r), 0)
  if (hits.length > MAX_HOLES || covered >= HIDE_COVERAGE * area(view)) return { mode: 'hide' }
  return {
    mode: 'holes',
    holes: hits.map((r) => ({
      x: Math.floor(r.x - view.x),
      y: Math.floor(r.y - view.y),
      width: Math.ceil(r.width),
      height: Math.ceil(r.height)
    }))
  }
}

/** Hai kế hoạch giống nhau (khỏi gửi lại main). */
export function sameOverlay(a: RdpNativeOverlay, b: RdpNativeOverlay): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Hình chữ nhật của các lớp phủ đang hiện trong trang (ngoài `exclude` — chính tab RDP). Lấy khung
 * `position: fixed` ngoài cùng chứa phần tử (nền mờ của hộp thoại, khung toast…); phần tử không nằm
 * trong khung fixed nào là nội dung thường của trang, không phải lớp phủ.
 */
export function collectOverlayRects(root: ParentNode, exclude: Element | null): RdpNativeRect[] {
  const seen = new Set<Element>()
  const out: RdpNativeRect[] = []
  const push = (frame: Element): void => {
    if (seen.has(frame)) return
    seen.add(frame)
    const r = frame.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    out.push({ x: r.left, y: r.top, width: r.width, height: r.height })
  }
  for (const el of root.querySelectorAll(SELF_OVERLAY_SELECTOR))
    if (!exclude?.contains(el)) push(el)
  for (const el of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (exclude?.contains(el)) continue
    let frame: Element | null = null
    for (let node: Element | null = el; node && node !== document.body; node = node.parentElement)
      if (getComputedStyle(node).position === 'fixed') frame = node
    if (frame) push(frame)
  }
  return out
}
