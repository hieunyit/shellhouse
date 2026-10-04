/**
 * Logic thuần của DataTable (không React, không DOM) — để test riêng: sắp xếp, chọn nhiều hàng
 * (Shift = dải, Ctrl/⌘ = bật / tắt một hàng), bàn phím j/k/x/Enter, cấu hình cột lưu theo máy,
 * vùng hàng cần vẽ khi ảo hoá.
 */

export type SortDirection = 'asc' | 'desc'
export interface SortState {
  columnId: string
  direction: SortDirection
}

/** Bấm tiêu đề cột: tăng dần → giảm dần → bỏ sắp xếp. */
export function nextSort(current: SortState | null, columnId: string): SortState | null {
  if (!current || current.columnId !== columnId) return { columnId, direction: 'asc' }
  if (current.direction === 'asc') return { columnId, direction: 'desc' }
  return null
}

export type SortValue = string | number | boolean | Date | null | undefined

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** So sánh hai giá trị sắp xếp; rỗng (null / undefined / '') luôn xếp cuối. */
export function compareValues(a: SortValue, b: SortValue): number {
  const emptyA = a === null || a === undefined || a === ''
  const emptyB = b === null || b === undefined || b === ''
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? -1 : 1
  return collator.compare(String(a), String(b))
}

/**
 * Sắp xếp ổn định (hàng bằng nhau giữ thứ tự gốc). Giá trị rỗng luôn ở cuối, kể cả khi giảm dần.
 */
export function sortRows<Row>(
  rows: readonly Row[],
  sort: SortState | null,
  valueOf: (row: Row, columnId: string) => SortValue
): Row[] {
  if (!sort) return [...rows]
  const sign = sort.direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row, sort.columnId) }))
    .sort((x, y) => {
      const emptyX = x.value === null || x.value === undefined || x.value === ''
      const emptyY = y.value === null || y.value === undefined || y.value === ''
      if (emptyX !== emptyY) return emptyX ? 1 : -1
      return sign * compareValues(x.value, y.value) || x.index - y.index
    })
    .map((r) => r.row)
}

// ---------- Chọn hàng ----------

export interface Selection {
  selected: ReadonlySet<string>
  /** Hàng mốc cho Shift+click / Shift+j/k. */
  anchor: string | null
}

export const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null }

/** Các id từ a tới b (gồm cả hai đầu) theo thứ tự hiển thị. */
export function rangeBetween(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a)
  const j = order.indexOf(b)
  if (i < 0 || j < 0) return j >= 0 ? [b] : []
  const [from, to] = i <= j ? [i, j] : [j, i]
  return order.slice(from, to + 1)
}

/**
 * Bấm vào ô chọn của một hàng.
 * - thường / Ctrl/⌘: bật / tắt hàng đó, hàng thành mốc.
 * - Shift: chọn cả dải từ mốc tới hàng này (giữ các hàng đã chọn khác), mốc giữ nguyên.
 */
export function toggleRow(
  state: Selection,
  id: string,
  order: readonly string[],
  opts: { shift?: boolean } = {}
): Selection {
  if (opts.shift && state.anchor !== null && order.includes(state.anchor)) {
    const next = new Set(state.selected)
    for (const r of rangeBetween(order, state.anchor, id)) next.add(r)
    return { selected: next, anchor: state.anchor }
  }
  const next = new Set(state.selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return { selected: next, anchor: id }
}

/** Bấm vào thân hàng (không phải ô chọn): chỉ chọn hàng đó; Ctrl/⌘ = bật / tắt; Shift = dải. */
export function clickRow(
  state: Selection,
  id: string,
  order: readonly string[],
  opts: { shift?: boolean; toggle?: boolean } = {}
): Selection {
  if (opts.shift && state.anchor !== null && order.includes(state.anchor))
    return { selected: new Set(rangeBetween(order, state.anchor, id)), anchor: state.anchor }
  if (opts.toggle) return toggleRow(state, id, order)
  return { selected: new Set([id]), anchor: id }
}

export type HeaderCheck = boolean | 'indeterminate'

/** Ô "chọn tất cả": tất cả hàng đang hiện đã chọn → true; một phần → indeterminate. */
export function headerCheckState(
  selected: ReadonlySet<string>,
  order: readonly string[]
): HeaderCheck {
  if (order.length === 0) return false
  let n = 0
  for (const id of order) if (selected.has(id)) n++
  if (n === 0) return false
  return n === order.length ? true : 'indeterminate'
}

/** Bấm "chọn tất cả": đã chọn hết → bỏ hết; còn lại → chọn hết các hàng đang hiện. */
export function toggleAll(state: Selection, order: readonly string[]): Selection {
  if (headerCheckState(state.selected, order) === true) {
    const next = new Set(state.selected)
    for (const id of order) next.delete(id)
    return { selected: next, anchor: null }
  }
  return { selected: new Set([...state.selected, ...order]), anchor: state.anchor }
}

/** Bỏ khỏi lựa chọn các hàng không còn tồn tại (dữ liệu làm mới / bộ lọc đổi). */
export function pruneSelection(state: Selection, existing: readonly string[]): Selection {
  const alive = new Set(existing)
  let changed = false
  const next = new Set<string>()
  for (const id of state.selected) {
    if (alive.has(id)) next.add(id)
    else changed = true
  }
  const anchor = state.anchor !== null && alive.has(state.anchor) ? state.anchor : null
  if (!changed && anchor === state.anchor) return state
  return { selected: next, anchor }
}

// ---------- Bàn phím ----------

export interface KeyState extends Selection {
  /** Hàng đang có con trỏ bàn phím (null = chưa có). */
  cursor: string | null
}

export type KeyResult =
  { kind: 'state'; state: KeyState } | { kind: 'open'; id: string } | { kind: 'none' }

/**
 * Phím trong bảng (focus ở bảng, không ở ô nhập):
 * - j / ↓, k / ↑: hàng kế / trước; Shift: mở rộng lựa chọn theo dải.
 * - Home / End (g / G): đầu / cuối. PageDown / PageUp: nhảy `page` hàng.
 * - x / Space: chọn / bỏ chọn hàng đang trỏ. Ctrl/⌘+A: chọn tất cả.
 * - Enter: mở hàng (Inspector). Esc: bỏ chọn (nếu đang có), không thì để Esc lan ra ngoài.
 */
export function tableKey(
  state: KeyState,
  key: string,
  order: readonly string[],
  mods: { shift?: boolean; ctrl?: boolean; page?: number } = {}
): KeyResult {
  if (order.length === 0) return { kind: 'none' }
  const index = state.cursor === null ? -1 : order.indexOf(state.cursor)
  const last = order.length - 1
  const page = Math.max(1, mods.page ?? 10)
  const move = (to: number): KeyResult => {
    const target = order[Math.max(0, Math.min(last, to))]
    if (target === undefined) return { kind: 'none' }
    if (mods.shift) {
      const anchor = state.anchor ?? state.cursor ?? target
      const selected = new Set(state.selected)
      for (const id of rangeBetween(order, anchor, target)) selected.add(id)
      return { kind: 'state', state: { selected, anchor, cursor: target } }
    }
    return { kind: 'state', state: { ...state, cursor: target } }
  }
  switch (key) {
    case 'j':
    case 'J':
    case 'ArrowDown':
      return move(index < 0 ? 0 : index + 1)
    case 'k':
    case 'K':
    case 'ArrowUp':
      return move(index < 0 ? 0 : index - 1)
    case 'Home':
    case 'g':
      return move(0)
    case 'End':
    case 'G':
      return move(last)
    case 'PageDown':
      return move(index < 0 ? 0 : index + page)
    case 'PageUp':
      return move(index < 0 ? 0 : index - page)
    case 'x':
    case ' ': {
      const id = state.cursor ?? order[0]
      if (id === undefined) return { kind: 'none' }
      const next = toggleRow(state, id, order)
      return { kind: 'state', state: { ...next, cursor: id } }
    }
    case 'a':
    case 'A':
      if (!mods.ctrl) return { kind: 'none' }
      return {
        kind: 'state',
        state: { selected: new Set(order), anchor: state.anchor, cursor: state.cursor }
      }
    case 'Enter':
      return state.cursor !== null && index >= 0
        ? { kind: 'open', id: state.cursor }
        : { kind: 'none' }
    case 'Escape':
      if (state.selected.size === 0) return { kind: 'none' }
      return { kind: 'state', state: { selected: new Set(), anchor: null, cursor: state.cursor } }
    default:
      return { kind: 'none' }
  }
}

// ---------- Cấu hình cột (lưu theo máy) ----------

export interface ColumnConfig {
  /** Độ rộng (px) người dùng đã kéo. */
  widths: Record<string, number>
  /** Cột đã ẩn. */
  hidden: string[]
  sort: SortState | null
}

export const COLUMN_MIN_WIDTH = 48
export const COLUMN_MAX_WIDTH = 1200

export function clampWidth(width: number, min = COLUMN_MIN_WIDTH): number {
  if (!Number.isFinite(width)) return min
  return Math.round(Math.min(COLUMN_MAX_WIDTH, Math.max(min, width)))
}

/**
 * Đọc cấu hình đã lưu, bỏ mọi thứ không hợp lệ (JSON hỏng, cột không còn tồn tại, độ rộng lạ).
 * `columns`: id các cột hiện có; cột không ẩn được (hideable=false) không bao giờ bị ẩn.
 */
export function parseColumnConfig(
  raw: string | null,
  columns: readonly { id: string; hideable?: boolean; sortable?: boolean; minWidth?: number }[],
  fallback: ColumnConfig
): ColumnConfig {
  if (!raw) return fallback
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fallback
  const d = data as Record<string, unknown>
  const byId = new Map(columns.map((c) => [c.id, c]))
  const widths: Record<string, number> = {}
  if (typeof d['widths'] === 'object' && d['widths'] !== null && !Array.isArray(d['widths'])) {
    for (const [id, w] of Object.entries(d['widths'] as Record<string, unknown>)) {
      const col = byId.get(id)
      if (col && typeof w === 'number' && Number.isFinite(w))
        widths[id] = clampWidth(w, col.minWidth)
    }
  }
  const hidden = Array.isArray(d['hidden'])
    ? (d['hidden'] as unknown[]).filter(
        (id): id is string =>
          typeof id === 'string' && byId.get(id)?.hideable !== false && byId.has(id)
      )
    : fallback.hidden
  let sort: SortState | null = fallback.sort
  const s = d['sort']
  if (s === null) sort = null
  else if (typeof s === 'object' && !Array.isArray(s)) {
    const so = s as Record<string, unknown>
    const col = typeof so['columnId'] === 'string' ? byId.get(so['columnId']) : undefined
    if (col && col.sortable !== false && (so['direction'] === 'asc' || so['direction'] === 'desc'))
      sort = { columnId: col.id, direction: so['direction'] }
  }
  return { widths, hidden: [...new Set(hidden)], sort }
}

// ---------- Ảo hoá ----------

/** Khoảng hàng [start, end) cần vẽ (kèm `overscan` hàng mỗi phía). */
export function visibleRange(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan = 6
): { start: number; end: number } {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1
  const start = Math.max(0, first - overscan)
  const end = Math.min(count, first + visible + overscan)
  return { start, end }
}

/** scrollTop mới để hàng `index` lọt vào vùng nhìn thấy (null = đã thấy, không cần cuộn). */
export function scrollToReveal(
  index: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number
): number | null {
  const top = index * rowHeight
  const bottom = top + rowHeight
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewport) return bottom - viewport
  return null
}
