import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { t } from '@shared/i18n'
import { cx } from '../ui'
import { defaultDir, type SortOption, type SortState } from '../SortMenu'

/** Từ chừng này dòng trở lên chỉ vẽ phần đang thấy (+ đệm) — bảng 3000 pod vẫn mượt. */
const VIRTUAL_MIN = 150
/** Dòng vẽ thêm trên / dưới vùng thấy (cuộn nhanh không thấy trống). */
const OVERSCAN = 15

/** Chiều cao một dòng (h-8 = 2rem) theo cỡ chữ gốc hiện tại. */
function rowHeight(): number {
  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return (Number.isFinite(root) && root > 0 ? root : 16) * 2
}

/** Một cột phụ (sau cột tên). `className` ẩn/hiện cột theo độ rộng khung (container query). */
export interface FileColumn<T, K extends string> {
  id: string
  label: string
  /** Cột sắp xếp được. */
  sort?: SortOption<K>
  align?: 'right'
  className?: string
  render: (item: T) => ReactNode
}

/**
 * Bảng file dùng chung cho các trình duyệt file (SFTP remote, máy local): cột tên + các cột phụ,
 * bấm tiêu đề để sắp xếp, chọn như trình quản lý file (bấm / Ctrl / Shift, phím mũi tên, Ctrl+A),
 * Enter mở, Backspace lên thư mục cha, F2 đổi tên, Del xoá, chuột phải mở menu.
 */
export function FileTable<T, K extends string>({
  items,
  getKey,
  getLabel,
  icon,
  badge,
  columns,
  gridClass,
  gridStyle,
  nameSort,
  sort,
  onSort,
  selected,
  onSelect,
  onOpen,
  onUp,
  onRename,
  onDelete,
  onPreview,
  onCopy,
  onMove,
  onContextMenu,
  rowProps,
  ariaLabel,
  rowTestId,
  children
}: {
  items: readonly T[]
  getKey: (item: T) => string
  /** Tên hiển thị nếu khác khoá (vd. khoá "ns/tên", hiện "tên"). */
  getLabel?: (item: T) => string
  icon: (item: T) => ReactNode
  /** Nội dung nhỏ sau tên (đang mở, đã ghim…). */
  badge?: (item: T) => ReactNode
  columns: readonly FileColumn<T, K>[]
  /** Lớp grid-cols (tĩnh, để Tailwind thấy) — cột đầu là tên. */
  gridClass: string
  /** Mẫu cột tính lúc chạy (vd. bỏ bớt cột theo độ rộng) — dùng thay / cùng `gridClass`. */
  gridStyle?: React.CSSProperties
  nameSort: SortOption<K>
  sort: SortState<K>
  onSort: (sort: SortState<K>) => void
  selected: ReadonlySet<string>
  onSelect: (keys: ReadonlySet<string>) => void
  onOpen: (item: T) => void
  onUp?: () => void
  onRename?: (item: T) => void
  onDelete?: (items: T[]) => void
  /** Space: xem nhanh mục đang chọn (như Quick Look). */
  onPreview?: (item: T) => void
  /** F5 / F6 (trình quản lý file hai cột, như Total Commander): copy / chuyển sang khung kia. */
  onCopy?: (items: T[]) => void
  onMove?: (items: T[]) => void
  onContextMenu?: (event: React.MouseEvent, items: T[]) => void
  rowProps?: (item: T) => React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }
  ariaLabel: string
  rowTestId: string
  /** Trạng thái trống / đang tải / ghi chú cuối danh sách. */
  children?: ReactNode
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  /** Mục "con trỏ" cho phím mũi tên và Shift+bấm. */
  const anchor = useRef<string | null>(null)
  // Ảo hoá: vị trí cuộn + chiều cao khung (cập nhật theo khung hình, không theo từng sự kiện cuộn).
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  const frame = useRef<number | null>(null)
  const virtual = items.length >= VIRTUAL_MIN
  useEffect(() => {
    const el = listRef.current
    if (!el || !virtual) return
    const measure = (): void => {
      setViewport({ top: el.scrollTop, height: el.clientHeight })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [virtual])
  const onScroll = (): void => {
    if (!virtual || frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const el = listRef.current
      if (el) setViewport({ top: el.scrollTop, height: el.clientHeight })
    })
  }
  const row = virtual ? rowHeight() : 32
  // Hàng tiêu đề (sticky) cao bằng một dòng.
  const first = virtual ? Math.max(0, Math.floor((viewport.top - row) / row) - OVERSCAN) : 0
  const last = virtual
    ? Math.min(items.length, Math.ceil((viewport.top + viewport.height) / row) + OVERSCAN)
    : items.length
  const chosen = items.filter((i) => selected.has(getKey(i)))
  const one = chosen.length === 1 ? chosen[0] : undefined

  const select = (item: T, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void => {
    const key = getKey(item)
    if (e.shiftKey && anchor.current !== null) {
      const a = items.findIndex((x) => getKey(x) === anchor.current)
      const b = items.findIndex((x) => getKey(x) === key)
      if (a !== -1 && b !== -1) {
        const [from, to] = a < b ? [a, b] : [b, a]
        onSelect(new Set(items.slice(from, to + 1).map(getKey)))
        return
      }
    }
    anchor.current = key
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      onSelect(next)
    } else onSelect(new Set([key]))
  }

  const moveCursor = (delta: number): void => {
    if (items.length === 0) return
    const current = items.findIndex((x) => getKey(x) === anchor.current)
    const next =
      current === -1
        ? delta > 0
          ? 0
          : items.length - 1
        : Math.max(0, Math.min(items.length - 1, current + delta))
    const item = items[next]
    if (item === undefined) return
    const key = getKey(item)
    anchor.current = key
    onSelect(new Set([key]))
    // Theo chỉ số (dòng có thể chưa được vẽ khi ảo hoá): giữ dòng trong vùng thấy, dưới tiêu đề.
    const el = listRef.current
    if (!el) return
    const h = rowHeight()
    const top = (next + 1) * h
    if (top < el.scrollTop + h) el.scrollTop = top - h
    else if (top + h > el.scrollTop + el.clientHeight) el.scrollTop = top + h - el.clientHeight
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const handled = (): void => {
      e.preventDefault()
    }
    if (e.key === 'ArrowDown') {
      handled()
      moveCursor(1)
    } else if (e.key === 'ArrowUp') {
      handled()
      moveCursor(-1)
    } else if (e.key === 'Enter' && one !== undefined) {
      handled()
      onOpen(one)
    } else if (e.key === 'Backspace' && onUp) {
      handled()
      onUp()
    } else if (e.key === ' ' && one !== undefined && onPreview) {
      handled()
      onPreview(one)
    } else if (e.key === 'F2' && one !== undefined && onRename) {
      handled()
      onRename(one)
    } else if (e.key === 'Delete' && chosen.length > 0 && onDelete) {
      handled()
      onDelete(chosen)
    } else if (e.key === 'F5' && chosen.length > 0 && onCopy) {
      handled()
      onCopy(chosen)
    } else if (e.key === 'F6' && chosen.length > 0 && onMove) {
      handled()
      onMove(chosen)
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      handled()
      onSelect(new Set(items.map(getKey)))
    }
  }

  const header = (option: SortOption<K>, label: string, className?: string, right?: boolean) => {
    const active = sort.key === option.key
    const Arrow = sort.dir === 'asc' ? ChevronUp : ChevronDown
    return (
      <button
        type="button"
        role="columnheader"
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cx(
          'min-w-0 rounded hover:text-fg',
          right ? 'text-right' : 'text-left',
          active && 'text-muted',
          className
        )}
        onClick={() => {
          onSort(
            active
              ? { key: option.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key: option.key, dir: defaultDir(option.kind) }
          )
        }}
      >
        {/* inline-flex: nút có thể bị ẩn/hiện bằng `hidden @md:block` mà không đè lên bố cục bên trong. */}
        <span className="inline-flex max-w-full items-center gap-0.5 align-middle">
          <span className="truncate">{label}</span>
          {active && <Arrow size={12} className="shrink-0" />}
        </span>
      </button>
    )
  }

  return (
    <div
      ref={listRef}
      className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
      role="grid"
      aria-label={ariaLabel}
      aria-multiselectable
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
    >
      <div
        role="row"
        className={cx(
          'sticky top-0 z-10 grid h-8 items-center gap-3 border-b border-line bg-surface px-3 text-xs font-medium text-faint',
          gridClass
        )}
        style={gridStyle}
      >
        {header(nameSort, t('Name'))}
        {columns.map((c) =>
          c.sort ? (
            <Fragment key={c.id}>
              {header(c.sort, c.label, c.className, c.align === 'right')}
            </Fragment>
          ) : (
            <span
              key={c.id}
              role="columnheader"
              className={cx('truncate', c.align === 'right' && 'text-right', c.className)}
            >
              {c.label}
            </span>
          )
        )}
      </div>
      {virtual && first > 0 && <div aria-hidden style={{ height: first * row }} />}
      {(virtual ? items.slice(first, last) : items).map((item) => {
        const key = getKey(item)
        const isSelected = selected.has(key)
        const extra = rowProps?.(item) ?? {}
        return (
          <div
            {...extra}
            key={key}
            role="row"
            aria-selected={isSelected}
            data-testid={rowTestId}
            data-name={key}
            data-key={key}
            className={cx(
              'grid h-8 cursor-default items-center gap-3 px-3 text-[13px] select-none',
              gridClass,
              isSelected ? 'bg-accent-soft' : 'hover:bg-hover'
            )}
            style={gridStyle ? { ...extra.style, ...gridStyle } : extra.style}
            onClick={(e) => {
              select(item, e)
            }}
            onDoubleClick={() => {
              onOpen(item)
            }}
            onContextMenu={(e) => {
              if (!onContextMenu) return
              e.preventDefault()
              // Chuột phải vào mục chưa chọn → chỉ chọn mục đó (như trình quản lý file).
              const list = isSelected ? chosen : [item]
              if (!isSelected) {
                anchor.current = key
                onSelect(new Set([key]))
              }
              onContextMenu(e, list)
            }}
          >
            <span role="gridcell" className="flex min-w-0 items-center gap-2">
              {icon(item)}
              <span className="truncate" title={key}>
                {getLabel ? getLabel(item) : key}
              </span>
              {badge?.(item)}
            </span>
            {columns.map((c) => (
              <span
                key={c.id}
                role="gridcell"
                className={cx(
                  'truncate text-xs text-muted tabular-nums',
                  c.align === 'right' && 'text-right',
                  c.className
                )}
              >
                {c.render(item)}
              </span>
            ))}
          </div>
        )
      })}
      {virtual && last < items.length && (
        <div aria-hidden style={{ height: (items.length - last) * row }} />
      )}
      {children}
    </div>
  )
}
