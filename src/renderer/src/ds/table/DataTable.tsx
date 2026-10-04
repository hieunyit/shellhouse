import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { ArrowDown, ArrowUp, Columns3, X } from 'lucide-react'
import { t, tn } from '@shared/i18n'
import { IconButton } from '../Button'
import { Checkbox } from '../Checkbox'
import { SkeletonRows } from '../Feedback'
import { Menu, type MenuEntry } from '../Menu'
import { useDensity } from '../provider'
import { cx, focusRing, transition } from '../utils'
import {
  clampWidth,
  EMPTY_SELECTION,
  headerCheckState,
  nextSort,
  parseColumnConfig,
  pruneSelection,
  scrollToReveal,
  sortRows,
  tableKey,
  toggleAll,
  toggleRow,
  clickRow,
  visibleRange,
  type ColumnConfig,
  type KeyState,
  type Selection,
  type SortState,
  type SortValue
} from './logic'

export interface Column<Row> {
  id: string
  header: string
  cell: (row: Row) => ReactNode
  /** Có = sắp xếp được theo giá trị này. */
  sortValue?: (row: Row) => SortValue
  /** Độ rộng mặc định (px); không có = co giãn chiếm phần còn lại. */
  width?: number
  minWidth?: number
  align?: 'start' | 'end'
  /** false = luôn hiện (cột tên). Mặc định true. */
  hideable?: boolean
  defaultHidden?: boolean
}

const CHECK_COL = 36
const STORAGE_PREFIX = 'shellhouse.table.'

function storageKey(persistKey: string): string {
  return STORAGE_PREFIX + persistKey
}

function defaultConfig<Row>(columns: readonly Column<Row>[], sort: SortState | null): ColumnConfig {
  return { widths: {}, hidden: columns.filter((c) => c.defaultHidden).map((c) => c.id), sort }
}

function loadConfig<Row>(
  persistKey: string | undefined,
  columns: readonly Column<Row>[],
  initialSort: SortState | null
): ColumnConfig {
  const fallback = defaultConfig(columns, initialSort)
  if (!persistKey) return fallback
  let raw: string | null = null
  try {
    raw = localStorage.getItem(storageKey(persistKey))
  } catch {
    // localStorage không dùng được → cấu hình mặc định.
  }
  return parseColumnConfig(
    raw,
    columns.map((c) => ({
      id: c.id,
      hideable: c.hideable !== false,
      sortable: c.sortValue !== undefined,
      ...(c.minWidth !== undefined ? { minWidth: c.minWidth } : {})
    })),
    fallback
  )
}

/** Đọc một biến CSS dạng px (ví dụ --ds-row-h) tại phần tử. */
function cssPx(el: HTMLElement | null, name: string, fallback: number): number {
  if (!el) return fallback
  const value = parseFloat(getComputedStyle(el).getPropertyValue(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Bảng dữ liệu ảo hoá (chỉ vẽ hàng đang thấy): sắp xếp theo cột, đổi độ rộng / ẩn cột (lưu theo
 * máy qua `persistKey`), chọn nhiều hàng (ô chọn, Shift = dải, Ctrl/⌘ = bật / tắt), bàn phím
 * j/k/x/Enter/Esc, thanh hành động hàng loạt thay thanh công cụ (không xô bố cục), header dính,
 * chiều cao hàng theo density.
 *
 * ARIA: role=grid, một điểm dừng Tab (aria-activedescendant trỏ hàng đang chọn bằng bàn phím),
 * aria-sort, aria-selected, aria-multiselectable, aria-rowcount / aria-rowindex (hàng ảo hoá).
 */
export function DataTable<Row>({
  rows,
  columns,
  getRowId,
  label,
  persistKey,
  initialSort = null,
  selectable = false,
  onSelectionChange,
  activeId = null,
  onOpen,
  toolbar,
  bulkActions,
  empty,
  loading,
  className,
  'data-testid': testId
}: {
  rows: readonly Row[]
  columns: readonly Column<Row>[]
  getRowId: (row: Row) => string
  /** Tên bảng cho trình đọc màn hình. */
  label: string
  /** Lưu độ rộng / cột ẩn / sắp xếp theo máy (localStorage). */
  persistKey?: string
  initialSort?: SortState | null
  selectable?: boolean
  onSelectionChange?: (ids: string[]) => void
  /** Hàng đang mở trong Inspector (vạch accent bên trái). */
  activeId?: string | null
  /** Bấm hàng / Enter: mở (Inspector). */
  onOpen?: (row: Row) => void
  /** Thanh công cụ phía trên (lọc, đếm…); có lựa chọn thì bị thay bằng thanh hàng loạt. */
  toolbar?: ReactNode
  bulkActions?: (ids: string[]) => ReactNode
  empty?: ReactNode
  loading?: boolean
  className?: string
  'data-testid'?: string
}): React.JSX.Element {
  const domId = useId()
  const density = useDensity()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [config, setConfig] = useState(() => loadConfig(persistKey, columns, initialSort))
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({})
  const [rawSelection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  const [rawCursor, setCursor] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [rowHeight, setRowHeight] = useState(32)

  // Lưu cấu hình cột mỗi khi đổi.
  useEffect(() => {
    if (!persistKey) return
    try {
      localStorage.setItem(storageKey(persistKey), JSON.stringify(config))
    } catch {
      // Đầy / bị chặn: bỏ qua, cấu hình vẫn dùng được trong phiên.
    }
  }, [config, persistKey])

  // Chiều cao hàng lấy từ token theo density (comfortable 32 / compact 28).
  useLayoutEffect(() => {
    setRowHeight(cssPx(scrollerRef.current, '--ds-row-h', 32))
  }, [density])

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setViewport(el.clientHeight)
    })
    observer.observe(el)
    setViewport(el.clientHeight)
    return () => {
      observer.disconnect()
    }
  }, [])

  const visibleColumns = useMemo(
    () => columns.filter((c) => c.hideable === false || !config.hidden.includes(c.id)),
    [columns, config.hidden]
  )

  const sorted = useMemo(() => {
    const byId = new Map(columns.map((c) => [c.id, c]))
    return sortRows(rows, config.sort, (row, id) => byId.get(id)?.sortValue?.(row))
  }, [rows, columns, config.sort])
  const order = useMemo(() => sorted.map(getRowId), [sorted, getRowId])
  const indexOf = useMemo(() => new Map(order.map((id, i) => [id, i])), [order])

  // Dữ liệu đổi (làm mới / lọc): hàng không còn tồn tại thì không còn được chọn / trỏ.
  const selection = useMemo(() => pruneSelection(rawSelection, order), [rawSelection, order])
  const cursor = rawCursor !== null && indexOf.has(rawCursor) ? rawCursor : null

  const latestOnSelection = useRef(onSelectionChange)
  useEffect(() => {
    latestOnSelection.current = onSelectionChange
  })
  const selectedIds = useMemo(
    () => order.filter((id) => selection.selected.has(id)),
    [order, selection.selected]
  )
  useEffect(() => {
    latestOnSelection.current?.(selectedIds)
  }, [selectedIds])

  const widthOf = (c: Column<Row>): number | undefined =>
    liveWidths[c.id] ?? config.widths[c.id] ?? c.width
  const template = [
    ...(selectable ? [`${String(CHECK_COL)}px`] : []),
    ...visibleColumns.map((c) => {
      const w = widthOf(c)
      return w !== undefined ? `${String(w)}px` : `minmax(${String(c.minWidth ?? 120)}px, 1fr)`
    })
  ].join(' ')
  const minRowWidth =
    (selectable ? CHECK_COL : 0) +
    visibleColumns.reduce((sum, c) => sum + (widthOf(c) ?? c.minWidth ?? 120), 0)

  const headerHeight = rowHeight
  const range = visibleRange(scrollTop, viewport - headerHeight, rowHeight, sorted.length)

  const reveal = useCallback(
    (id: string) => {
      const el = scrollerRef.current
      const index = indexOf.get(id)
      if (!el || index === undefined) return
      const top = scrollToReveal(index, el.scrollTop, el.clientHeight - headerHeight, rowHeight)
      if (top !== null) el.scrollTop = top
    },
    [indexOf, headerHeight, rowHeight]
  )

  const setSort = (columnId: string): void => {
    setConfig((c) => ({ ...c, sort: nextSort(c.sort, columnId) }))
  }

  const toggleColumn = (id: string, visible: boolean): void => {
    setConfig((c) => ({
      ...c,
      hidden: visible ? c.hidden.filter((h) => h !== id) : [...c.hidden.filter((h) => h !== id), id]
    }))
  }

  const commitWidth = (id: string, width: number, min?: number): void => {
    setLiveWidths((w) => Object.fromEntries(Object.entries(w).filter(([k]) => k !== id)))
    setConfig((c) => ({ ...c, widths: { ...c.widths, [id]: clampWidth(width, min) } }))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    if (e.altKey || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() !== 'a')) return
    const result = tableKey({ ...selection, cursor }, e.key, order, {
      shift: e.shiftKey,
      ctrl: e.metaKey || e.ctrlKey,
      page: Math.max(1, Math.floor((viewport - headerHeight) / rowHeight) - 1)
    })
    if (result.kind === 'none') return
    e.preventDefault()
    if (result.kind === 'open') {
      const row = sorted[indexOf.get(result.id) ?? -1]
      if (row !== undefined) onOpen?.(row)
      return
    }
    const next: KeyState = result.state
    if (selectable) setSelection({ selected: next.selected, anchor: next.anchor })
    if (next.cursor !== cursor) {
      setCursor(next.cursor)
      if (next.cursor !== null) reveal(next.cursor)
    }
  }

  const columnEntries: MenuEntry[] = [
    { kind: 'label', id: 'cols-label', label: t('Columns') },
    ...columns.map((c): MenuEntry => ({
      kind: 'checkbox',
      id: `col-${c.id}`,
      label: c.header,
      checked: c.hideable === false || !config.hidden.includes(c.id),
      disabled: c.hideable === false,
      onCheckedChange: (v) => {
        toggleColumn(c.id, v)
      }
    })),
    { kind: 'separator', id: 'cols-sep' },
    {
      id: 'cols-reset',
      label: t('Reset columns'),
      onSelect: () => {
        setConfig(defaultConfig(columns, initialSort))
      }
    }
  ]

  const bulk = selectable && selectedIds.length > 0
  const rowDomId = (id: string): string => `${domId}-row-${String(indexOf.get(id) ?? 0)}`
  const head = headerCheckState(selection.selected, order)

  return (
    <div
      className={cx('flex min-h-0 flex-col bg-ds-surface-0 text-ds-table text-ds-fg', className)}
      data-testid={testId}
    >
      {/* Thanh công cụ ⇄ thanh hàng loạt: cùng chiều cao, không xô bố cục. */}
      <div
        role={bulk ? 'toolbar' : undefined}
        aria-label={bulk ? t('Bulk actions') : undefined}
        className="flex h-ds-toolbar shrink-0 items-center gap-2 border-b border-ds-border-subtle px-3"
      >
        {bulk ? (
          <>
            <span className="inline-flex items-center gap-1 text-ds-base font-medium">
              {tn(selectedIds.length, '{n} selected', '{n} selected')}
              <IconButton
                label={t('Clear selection')}
                shortcut="Esc"
                size="sm"
                data-testid="table-clear-selection"
                onClick={() => {
                  setSelection(EMPTY_SELECTION)
                }}
              >
                <X size={14} strokeWidth={1.5} aria-hidden />
              </IconButton>
            </span>
            <span aria-hidden className="h-4 w-px bg-ds-border" />
            {bulkActions?.(selectedIds)}
          </>
        ) : (
          <>
            {toolbar}
            <span className="flex-1" />
            <Menu
              label={t('Columns')}
              align="end"
              entries={columnEntries}
              trigger={
                <IconButton label={t('Columns')} size="sm" data-testid="table-columns">
                  <Columns3 size={14} strokeWidth={1.5} aria-hidden />
                </IconButton>
              }
            />
          </>
        )}
      </div>
      <div
        ref={scrollerRef}
        role="grid"
        aria-label={label}
        aria-rowcount={sorted.length + 1}
        aria-colcount={visibleColumns.length + (selectable ? 1 : 0)}
        aria-multiselectable={selectable || undefined}
        aria-activedescendant={
          cursor !== null && indexOf.has(cursor) ? rowDomId(cursor) : undefined
        }
        aria-busy={loading || undefined}
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto outline-none"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop)
        }}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return
          setFocused(true)
          if (cursor === null && order[0] !== undefined) setCursor(order[0])
        }}
        onBlur={() => {
          setFocused(false)
        }}
        onKeyDown={onKeyDown}
      >
        <div role="rowgroup" className="sticky top-0 z-(--ds-z-sticky)">
          <div
            role="row"
            aria-rowindex={1}
            className="grid h-ds-row border-b border-ds-border bg-ds-surface-0 text-ds-sm font-medium text-ds-fg-3"
            style={{ gridTemplateColumns: template, minWidth: minRowWidth }}
          >
            {selectable && (
              <div role="columnheader" className="flex items-center justify-center">
                <Checkbox
                  checked={head}
                  tabIndex={-1}
                  aria-label={t('Select all')}
                  data-testid="table-select-all"
                  onCheckedChange={() => {
                    setSelection(toggleAll(selection, order))
                  }}
                />
              </div>
            )}
            {visibleColumns.map((c, ci) => {
              const sortDir = config.sort?.columnId === c.id ? config.sort.direction : null
              return (
                <div
                  key={c.id}
                  role="columnheader"
                  aria-sort={
                    sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : undefined
                  }
                  data-column={c.id}
                  className={cx(
                    'relative flex min-w-0 items-center px-ds-cell',
                    c.align === 'end' && 'justify-end'
                  )}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      data-testid={`table-sort-${c.id}`}
                      className={cx(
                        'inline-flex min-w-0 items-center gap-1 rounded-ds-xs hover:text-ds-fg',
                        focusRing,
                        sortDir && 'text-ds-fg-2',
                        transition
                      )}
                      onClick={() => {
                        setSort(c.id)
                      }}
                    >
                      <span className="truncate">{c.header}</span>
                      {sortDir === 'asc' && <ArrowUp size={12} strokeWidth={1.5} aria-hidden />}
                      {sortDir === 'desc' && <ArrowDown size={12} strokeWidth={1.5} aria-hidden />}
                    </button>
                  ) : (
                    <span className="truncate">{c.header}</span>
                  )}
                  <ResizeHandle
                    column={c.header}
                    last={ci === visibleColumns.length - 1}
                    min={c.minWidth}
                    onStart={(el) =>
                      el.parentElement?.getBoundingClientRect().width ?? widthOf(c) ?? 120
                    }
                    onLive={(w) => {
                      setLiveWidths((x) => ({ ...x, [c.id]: clampWidth(w, c.minWidth) }))
                    }}
                    onCommit={(w) => {
                      commitWidth(c.id, w, c.minWidth)
                    }}
                    current={() => widthOf(c) ?? 120}
                  />
                </div>
              )
            })}
          </div>
        </div>
        {loading ? (
          <SkeletonRows rows={6} />
        ) : sorted.length === 0 ? (
          <div role="row" aria-rowindex={2}>
            <div role="gridcell">{empty}</div>
          </div>
        ) : (
          <div
            role="rowgroup"
            className="relative"
            style={{ height: sorted.length * rowHeight, minWidth: minRowWidth }}
          >
            {sorted.slice(range.start, range.end).map((row, i) => {
              const index = range.start + i
              const id = order[index] ?? getRowId(row)
              const isSelected = selection.selected.has(id)
              const isCursor = cursor === id
              const isActive = activeId === id
              return (
                <div
                  key={id}
                  id={rowDomId(id)}
                  role="row"
                  aria-rowindex={index + 2}
                  aria-selected={selectable ? isSelected : undefined}
                  data-row-id={id}
                  data-cursor={isCursor || undefined}
                  className={cx(
                    'group absolute inset-x-0 grid h-ds-row items-center border-b border-ds-border-subtle',
                    isSelected ? 'bg-ds-accent-soft' : 'hover:bg-ds-hover',
                    isActive &&
                      'bg-ds-active before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-ds-accent',
                    isCursor && focused && 'shadow-[inset_0_0_0_1px_var(--ds-accent-ring)]'
                  )}
                  style={{
                    top: index * rowHeight,
                    gridTemplateColumns: template,
                    minWidth: minRowWidth
                  }}
                  onMouseDown={(e) => {
                    // Shift+click: không bôi đen chữ.
                    if (e.shiftKey) e.preventDefault()
                  }}
                  onClick={(e) => {
                    setCursor(id)
                    const toggle = e.metaKey || e.ctrlKey
                    if (selectable && (e.shiftKey || toggle)) {
                      setSelection(clickRow(selection, id, order, { shift: e.shiftKey, toggle }))
                      return
                    }
                    onOpen?.(row)
                  }}
                >
                  {selectable && (
                    <div
                      role="gridcell"
                      className="flex items-center justify-center"
                      onClick={(e) => {
                        e.stopPropagation()
                        setCursor(id)
                        setSelection(toggleRow(selection, id, order, { shift: e.shiftKey }))
                      }}
                    >
                      <Checkbox
                        checked={isSelected}
                        tabIndex={-1}
                        aria-label={t('Select row')}
                        className={cx(
                          !isSelected &&
                            selection.selected.size === 0 &&
                            'opacity-0 group-hover:opacity-100'
                        )}
                        // Xử lý ở ô cha (biết Shift).
                        onCheckedChange={() => undefined}
                      />
                    </div>
                  )}
                  {visibleColumns.map((c) => (
                    <div
                      key={c.id}
                      role="gridcell"
                      className={cx(
                        'flex min-w-0 items-center px-ds-cell',
                        c.align === 'end' && 'justify-end tabular-nums'
                      )}
                    >
                      <span className="min-w-0 truncate">{c.cell(row)}</span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** Tay nắm đổi độ rộng cột: kéo chuột, hoặc focus rồi ←/→ (Shift = 64 px). */
function ResizeHandle({
  column,
  last,
  min,
  onStart,
  onLive,
  onCommit,
  current
}: {
  column: string
  /** Cột cuối: tay nắm nằm trong cột (không tràn ra làm bảng cuộn ngang). */
  last: boolean
  min: number | undefined
  onStart: (el: HTMLElement) => number
  onLive: (width: number) => void
  onCommit: (width: number) => void
  current: () => number
}): React.JSX.Element {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize column {name}', { name: column })}
      tabIndex={-1}
      className={cx(
        'absolute inset-y-0 z-(--ds-z-resizer) w-2 cursor-col-resize',
        'after:absolute after:inset-y-2 after:left-[3px] after:w-px after:bg-transparent hover:after:bg-ds-border-strong focus-visible:outline-none focus-visible:after:bg-ds-accent',
        last ? 'right-0' : '-right-1'
      )}
      onClick={(e) => {
        e.stopPropagation()
      }}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        const width = onStart(e.currentTarget)
        drag.current = { x: e.clientX, width, last: width }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        d.last = Math.max(min ?? 48, d.width + e.clientX - d.x)
        onLive(d.last)
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        if (d) onCommit(d.last)
      }}
      onPointerCancel={() => {
        const d = drag.current
        drag.current = null
        if (d) onCommit(d.width)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        e.stopPropagation()
        const step = (e.shiftKey ? 64 : 16) * (e.key === 'ArrowLeft' ? -1 : 1)
        onCommit(current() + step)
      }}
    />
  )
}
