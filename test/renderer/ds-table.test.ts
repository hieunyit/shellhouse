import { describe, expect, it } from 'vitest'
import {
  clampWidth,
  clickRow,
  compareValues,
  EMPTY_SELECTION,
  headerCheckState,
  nextSort,
  parseColumnConfig,
  pruneSelection,
  rangeBetween,
  scrollToReveal,
  sortRows,
  tableKey,
  toggleAll,
  toggleRow,
  visibleRange,
  type KeyState,
  type Selection
} from '../../src/renderer/src/ds/table/logic'

const ORDER = ['a', 'b', 'c', 'd', 'e']
const ids = (s: Selection): string[] => [...s.selected].sort()

describe('DataTable: sắp xếp', () => {
  it('bấm tiêu đề: tăng → giảm → bỏ; đổi cột thì về tăng', () => {
    let s = nextSort(null, 'name')
    expect(s).toEqual({ columnId: 'name', direction: 'asc' })
    s = nextSort(s, 'name')
    expect(s).toEqual({ columnId: 'name', direction: 'desc' })
    expect(nextSort(s, 'name')).toBeNull()
    expect(nextSort(s, 'age')).toEqual({ columnId: 'age', direction: 'asc' })
  })

  it('so sánh tự nhiên (pod-2 < pod-10), số, ngày, rỗng luôn cuối', () => {
    expect(compareValues('pod-2', 'pod-10')).toBeLessThan(0)
    expect(compareValues(3, 20)).toBeLessThan(0)
    expect(compareValues(new Date(1), new Date(2))).toBeLessThan(0)
    expect(compareValues(null, 'a')).toBeGreaterThan(0)
    expect(compareValues('', '')).toBe(0)
  })

  it('ổn định, rỗng ở cuối cả khi giảm dần, không đổi mảng gốc', () => {
    const rows = [
      { id: 'x', v: 2 },
      { id: 'y', v: null },
      { id: 'z', v: 1 },
      { id: 'w', v: 2 }
    ]
    const asc = sortRows(rows, { columnId: 'v', direction: 'asc' }, (r) => r.v)
    expect(asc.map((r) => r.id)).toEqual(['z', 'x', 'w', 'y'])
    const desc = sortRows(rows, { columnId: 'v', direction: 'desc' }, (r) => r.v)
    expect(desc.map((r) => r.id)).toEqual(['x', 'w', 'z', 'y'])
    expect(sortRows(rows, null, (r) => r.v).map((r) => r.id)).toEqual(['x', 'y', 'z', 'w'])
    expect(rows[0]?.id).toBe('x')
  })
})

describe('DataTable: chọn hàng', () => {
  it('dải theo thứ tự hiển thị, hai chiều', () => {
    expect(rangeBetween(ORDER, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeBetween(ORDER, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeBetween(ORDER, 'zz', 'b')).toEqual(['b'])
  })

  it('ô chọn: bật / tắt; Shift = dải từ mốc, giữ các hàng đã chọn khác', () => {
    let s = toggleRow(EMPTY_SELECTION, 'a', ORDER)
    expect(ids(s)).toEqual(['a'])
    s = toggleRow(s, 'c', ORDER)
    expect(s.anchor).toBe('c')
    s = toggleRow(s, 'e', ORDER, { shift: true })
    expect(ids(s)).toEqual(['a', 'c', 'd', 'e'])
    expect(s.anchor).toBe('c')
    s = toggleRow(s, 'a', ORDER)
    expect(ids(s)).toEqual(['c', 'd', 'e'])
  })

  it('bấm hàng: thường = chỉ hàng đó; Ctrl = thêm / bớt; Shift = thay bằng dải', () => {
    let s = clickRow(EMPTY_SELECTION, 'b', ORDER)
    expect(ids(s)).toEqual(['b'])
    s = clickRow(s, 'd', ORDER, { toggle: true })
    expect(ids(s)).toEqual(['b', 'd'])
    s = clickRow(s, 'a', ORDER, { shift: true })
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('chọn tất cả: indeterminate khi một phần; bấm khi đã đủ thì bỏ hết', () => {
    expect(headerCheckState(new Set(), ORDER)).toBe(false)
    expect(headerCheckState(new Set(['a']), ORDER)).toBe('indeterminate')
    let s = toggleAll({ selected: new Set(['a']), anchor: 'a' }, ORDER)
    expect(headerCheckState(s.selected, ORDER)).toBe(true)
    s = toggleAll(s, ORDER)
    expect(s.selected.size).toBe(0)
    expect(headerCheckState(new Set(), [])).toBe(false)
  })

  it('làm mới dữ liệu: bỏ hàng không còn; không đổi gì thì giữ nguyên object', () => {
    const s: Selection = { selected: new Set(['a', 'x']), anchor: 'x' }
    const pruned = pruneSelection(s, ORDER)
    expect(ids(pruned)).toEqual(['a'])
    expect(pruned.anchor).toBeNull()
    const same: Selection = { selected: new Set(['a']), anchor: 'a' }
    expect(pruneSelection(same, ORDER)).toBe(same)
  })
})

describe('DataTable: bàn phím', () => {
  const start: KeyState = { selected: new Set(), anchor: null, cursor: null }
  const state = (r: ReturnType<typeof tableKey>): KeyState => {
    if (r.kind !== 'state') throw new Error(`expected state, got ${r.kind}`)
    return r.state
  }

  it('j/k và mũi tên di chuyển, dừng ở hai đầu; g/G, Home/End', () => {
    let s = state(tableKey(start, 'j', ORDER))
    expect(s.cursor).toBe('a')
    s = state(tableKey(s, 'ArrowDown', ORDER))
    expect(s.cursor).toBe('b')
    s = state(tableKey(s, 'k', ORDER))
    s = state(tableKey(s, 'k', ORDER))
    expect(s.cursor).toBe('a')
    expect(state(tableKey(s, 'End', ORDER)).cursor).toBe('e')
    expect(state(tableKey(s, 'G', ORDER)).cursor).toBe('e')
    expect(state(tableKey({ ...s, cursor: 'd' }, 'Home', ORDER)).cursor).toBe('a')
    expect(state(tableKey({ ...s, cursor: 'b' }, 'PageDown', ORDER, { page: 2 })).cursor).toBe('d')
  })

  it('x / Space bật tắt hàng đang trỏ; Shift+j mở rộng dải', () => {
    let s = state(tableKey({ ...start, cursor: 'b' }, 'x', ORDER))
    expect(ids(s)).toEqual(['b'])
    s = state(tableKey(s, 'j', ORDER, { shift: true }))
    s = state(tableKey(s, 'J', ORDER, { shift: true }))
    expect(ids(s)).toEqual(['b', 'c', 'd'])
    expect(s.cursor).toBe('d')
    s = state(tableKey(s, ' ', ORDER))
    expect(ids(s)).toEqual(['b', 'c'])
  })

  it('Enter mở hàng đang trỏ; Esc bỏ chọn, không có gì để bỏ thì nhường Esc', () => {
    expect(tableKey({ ...start, cursor: 'c' }, 'Enter', ORDER)).toEqual({ kind: 'open', id: 'c' })
    expect(tableKey(start, 'Enter', ORDER)).toEqual({ kind: 'none' })
    const cleared = state(
      tableKey({ selected: new Set(['a']), anchor: 'a', cursor: 'a' }, 'Escape', ORDER)
    )
    expect(cleared.selected.size).toBe(0)
    expect(tableKey(start, 'Escape', ORDER)).toEqual({ kind: 'none' })
  })

  it('Ctrl+A chọn tất cả; "a" đơn không làm gì; bảng rỗng bỏ qua mọi phím', () => {
    expect(ids(state(tableKey(start, 'a', ORDER, { ctrl: true })))).toEqual(ORDER)
    expect(tableKey(start, 'a', ORDER)).toEqual({ kind: 'none' })
    expect(tableKey(start, 'j', [])).toEqual({ kind: 'none' })
  })
})

describe('DataTable: cấu hình cột lưu theo máy', () => {
  const cols = [
    { id: 'name', hideable: false, sortable: true },
    { id: 'ns', sortable: true },
    { id: 'age', minWidth: 60, sortable: false }
  ]
  const fallback = { widths: {}, hidden: ['age'], sort: null }

  it('đọc cấu hình hợp lệ, kẹp độ rộng, bỏ cột lạ / không ẩn được / không sắp xếp được', () => {
    const raw = JSON.stringify({
      widths: { name: 10, ns: 5000, ghost: 100, age: 'x' },
      hidden: ['name', 'ns', 'ghost', 'ns'],
      sort: { columnId: 'ns', direction: 'desc' }
    })
    expect(parseColumnConfig(raw, cols, fallback)).toEqual({
      widths: { name: 48, ns: 1200 },
      hidden: ['ns'],
      sort: { columnId: 'ns', direction: 'desc' }
    })
    const unsortable = JSON.stringify({ sort: { columnId: 'age', direction: 'asc' } })
    expect(parseColumnConfig(unsortable, cols, fallback).sort).toBeNull()
    expect(parseColumnConfig(JSON.stringify({ sort: null }), cols, fallback).sort).toBeNull()
  })

  it('JSON hỏng / sai kiểu → mặc định', () => {
    expect(parseColumnConfig('{oops', cols, fallback)).toBe(fallback)
    expect(parseColumnConfig('[1,2]', cols, fallback)).toBe(fallback)
    expect(parseColumnConfig(null, cols, fallback)).toBe(fallback)
    expect(clampWidth(Number.NaN)).toBe(48)
    expect(clampWidth(30, 60)).toBe(60)
  })
})

describe('DataTable: ảo hoá', () => {
  it('chỉ vẽ hàng đang thấy + overscan', () => {
    expect(visibleRange(0, 320, 32, 2000, 2)).toEqual({ start: 0, end: 13 })
    expect(visibleRange(3200, 320, 32, 2000, 2)).toEqual({ start: 98, end: 113 })
    expect(visibleRange(64000, 320, 32, 2000, 2)).toEqual({ start: 1998, end: 2000 })
    expect(visibleRange(0, 320, 32, 0)).toEqual({ start: 0, end: 0 })
  })

  it('cuộn để hàng lọt vào vùng nhìn thấy', () => {
    expect(scrollToReveal(5, 0, 320, 32)).toBeNull()
    expect(scrollToReveal(20, 0, 320, 32)).toBe(21 * 32 - 320)
    expect(scrollToReveal(2, 200, 320, 32)).toBe(64)
  })
})
