import { Fragment, useRef, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cx } from '../ui'
import { defaultDir, type SortOption, type SortState } from '../SortMenu'

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
  icon,
  badge,
  columns,
  gridClass,
  nameSort,
  sort,
  onSort,
  selected,
  onSelect,
  onOpen,
  onUp,
  onRename,
  onDelete,
  onContextMenu,
  rowProps,
  ariaLabel,
  rowTestId,
  children
}: {
  items: readonly T[]
  getKey: (item: T) => string
  icon: (item: T) => ReactNode
  /** Nội dung nhỏ sau tên (đang mở, đã ghim…). */
  badge?: (item: T) => ReactNode
  columns: readonly FileColumn<T, K>[]
  /** Lớp grid-cols (tĩnh, để Tailwind thấy) — cột đầu là tên. */
  gridClass: string
  nameSort: SortOption<K>
  sort: SortState<K>
  onSort: (sort: SortState<K>) => void
  selected: ReadonlySet<string>
  onSelect: (keys: ReadonlySet<string>) => void
  onOpen: (item: T) => void
  onUp?: () => void
  onRename?: (item: T) => void
  onDelete?: (items: T[]) => void
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
    listRef.current
      ?.querySelector(`[data-key="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
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
    } else if (e.key === 'F2' && one !== undefined && onRename) {
      handled()
      onRename(one)
    } else if (e.key === 'Delete' && chosen.length > 0 && onDelete) {
      handled()
      onDelete(chosen)
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
    >
      <div
        role="row"
        className={cx(
          'sticky top-0 z-10 grid h-8 items-center gap-3 border-b border-line bg-surface px-3 text-xs font-medium text-faint',
          gridClass
        )}
      >
        {header(nameSort, 'Name')}
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
      {items.map((item) => {
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
                {key}
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
      {children}
    </div>
  )
}
