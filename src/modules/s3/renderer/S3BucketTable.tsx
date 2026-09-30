import { useMemo, useRef } from 'react'
import { ChevronDown, ChevronUp, Database, Pin, RefreshCw } from 'lucide-react'
import type { S3Bucket } from '../shared/ops'
import { cx } from '../../../renderer/src/components/ui'
import type { SortOption, SortState } from '../../../renderer/src/components/SortMenu'
import { formatSize } from './format'
import { collator, dateFormat } from './parts'

/** Thống kê một bucket, tính khi người dùng bấm (S3 không có API trả sẵn con số này). */
export interface BucketStats {
  state: 'running' | 'done' | 'stopped' | 'error'
  objects: number
  bytes: number
  error?: string
}

export type BucketSortKey = 'name' | 'region' | 'created' | 'objects' | 'size'

export const BUCKET_SORT_OPTIONS = [
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'region', label: 'Region', kind: 'text' },
  { key: 'created', label: 'Created', kind: 'date' },
  { key: 'objects', label: 'Objects', kind: 'number' },
  { key: 'size', label: 'Size', kind: 'number' }
] as const satisfies readonly SortOption<BucketSortKey>[]
export const BUCKET_SORT_KEYS: readonly BucketSortKey[] = BUCKET_SORT_OPTIONS.map((o) => o.key)

const monthYear = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit' })

/** Name, [Region], [Created], Objects, Size, ghim — Region / Created ẩn khi khung hẹp. */
const COLUMNS = {
  plain:
    'grid-cols-[minmax(0,1fr)_6rem_6rem_1.25rem] @xl:grid-cols-[minmax(0,1fr)_5.5rem_6rem_6rem_1.25rem]',
  region:
    'grid-cols-[minmax(0,1fr)_6rem_6rem_1.25rem] @xl:grid-cols-[minmax(0,1fr)_5.5rem_6rem_6rem_1.25rem] @3xl:grid-cols-[minmax(0,1fr)_8rem_5.5rem_6rem_6rem_1.25rem]'
} as const

/**
 * Bảng bucket — cấp gốc của tài khoản (như AWS Console / Cyberduck): chiếm toàn bộ chiều ngang,
 * lọc / sắp xếp được, dung lượng và số object tính khi cần.
 */
export function S3BucketTable({
  buckets,
  filter,
  stats,
  sort,
  onSort,
  selected,
  isPinned,
  onSelect,
  onOpen,
  onCalculate,
  onContextMenu
}: {
  buckets: S3Bucket[]
  filter: string
  stats: Readonly<Record<string, BucketStats>>
  sort: SortState<BucketSortKey>
  onSort: (sort: SortState<BucketSortKey>) => void
  selected: string | null
  isPinned: (bucket: string) => boolean
  onSelect: (name: string) => void
  onOpen: (name: string) => void
  onCalculate: (name: string) => void
  onContextMenu: (event: React.MouseEvent, name: string) => void
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  const withRegion = buckets.some((b) => b.region)
  const columns = withRegion ? COLUMNS.region : COLUMNS.plain

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const shown = q ? buckets.filter((b) => b.name.toLowerCase().includes(q)) : [...buckets]
    const dir = sort.dir === 'asc' ? 1 : -1
    // Chưa tính dung lượng = -1 → luôn đứng cuối khi sắp giảm dần.
    const metric = (b: S3Bucket): number => {
      const s = stats[b.name]
      if (!s || s.state === 'error') return -1
      return sort.key === 'objects' ? s.objects : s.bytes
    }
    return shown.sort((a, b) => {
      const by =
        sort.key === 'region'
          ? collator.compare(a.region ?? '', b.region ?? '')
          : sort.key === 'created'
            ? (a.createdAt ?? 0) - (b.createdAt ?? 0)
            : sort.key === 'objects' || sort.key === 'size'
              ? metric(a) - metric(b)
              : 0
      return (by || collator.compare(a.name, b.name)) * dir
    })
  }, [buckets, filter, sort, stats])

  const header = (key: BucketSortKey, label: string, className?: string): React.JSX.Element => {
    const active = sort.key === key
    const Arrow = sort.dir === 'asc' ? ChevronUp : ChevronDown
    const numeric = key === 'objects' || key === 'size'
    return (
      <button
        type="button"
        role="columnheader"
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cx(
          'flex min-w-0 items-center gap-0.5 rounded hover:text-fg',
          numeric && 'justify-end',
          active && 'text-muted',
          className
        )}
        onClick={() => {
          onSort(
            active
              ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key, dir: key === 'name' || key === 'region' ? 'asc' : 'desc' }
          )
        }}
      >
        <span className="truncate">{label}</span>
        {active && <Arrow size={12} className="shrink-0" />}
      </button>
    )
  }

  const move = (delta: number): void => {
    if (rows.length === 0) return
    const i = rows.findIndex((b) => b.name === selected)
    const next =
      rows[
        i === -1
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, i + delta))
      ]
    if (!next) return
    onSelect(next.name)
    listRef.current
      ?.querySelector(`[data-name="${CSS.escape(next.name)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <div
      ref={listRef}
      className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
      role="grid"
      aria-label="Buckets"
      tabIndex={0}
      data-testid="s3-buckets"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          move(e.key === 'ArrowDown' ? 1 : -1)
        } else if (e.key === 'Enter' && selected) {
          e.preventDefault()
          onOpen(selected)
        }
      }}
    >
      <div
        role="row"
        className={cx(
          'sticky top-0 z-10 grid h-8 items-center gap-3 border-b border-line bg-surface px-3 text-xs font-medium text-faint',
          columns
        )}
      >
        {header('name', 'Name')}
        {withRegion && header('region', 'Region', 'hidden @3xl:flex')}
        {header('created', 'Created', 'hidden @xl:flex')}
        {header('objects', 'Objects')}
        {header('size', 'Size')}
        <span />
      </div>
      {rows.length === 0 && (
        <p className="px-4 py-10 text-center text-xs text-faint">
          {filter ? `No bucket matches “${filter}”.` : 'No buckets.'}
        </p>
      )}
      {rows.map((b) => {
        const s = stats[b.name]
        const isSelected = selected === b.name
        const pinned = isPinned(b.name)
        return (
          <div
            key={b.name}
            role="row"
            aria-selected={isSelected}
            data-testid="s3-bucket"
            data-name={b.name}
            className={cx(
              'grid h-9 cursor-default items-center gap-3 px-3 text-[13px] select-none',
              columns,
              isSelected ? 'bg-accent-soft' : 'hover:bg-hover'
            )}
            onClick={() => {
              onSelect(b.name)
            }}
            onDoubleClick={() => {
              onOpen(b.name)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              onSelect(b.name)
              onContextMenu(e, b.name)
            }}
          >
            <span role="gridcell" className="flex min-w-0 items-center gap-2">
              <Database size={15} className="shrink-0 text-accent" />
              <span className="truncate font-medium" title={b.name}>
                {b.name}
              </span>
            </span>
            {withRegion && (
              <span role="gridcell" className="hidden truncate text-xs text-muted @3xl:block">
                {b.region ?? '—'}
              </span>
            )}
            <span
              role="gridcell"
              className="hidden truncate text-xs text-muted tabular-nums @xl:block"
              title={b.createdAt ? dateFormat.format(new Date(b.createdAt)) : undefined}
            >
              {b.createdAt ? monthYear.format(new Date(b.createdAt)) : '—'}
            </span>
            <span
              role="gridcell"
              className="flex items-center justify-end gap-1.5 text-xs text-muted tabular-nums"
              data-testid="s3-bucket-objects"
              title={s?.error}
            >
              {s?.state === 'running' && (
                <RefreshCw size={11} className="animate-spin text-faint" />
              )}
              {!s ? '—' : s.state === 'error' ? 'Failed' : s.objects.toLocaleString('en-US')}
              {s?.state === 'stopped' && '+'}
            </span>
            <span
              role="gridcell"
              className="text-right text-xs text-muted tabular-nums"
              data-testid="s3-bucket-size"
            >
              {!s || s.state === 'error' ? (
                <button
                  type="button"
                  className="rounded px-1 text-accent hover:underline"
                  data-testid="s3-bucket-calc"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCalculate(b.name)
                  }}
                >
                  {s ? 'Retry' : 'Calculate'}
                </button>
              ) : (
                `${formatSize(s.bytes)}${s.state === 'stopped' ? '+' : ''}`
              )}
            </span>
            <span role="gridcell" className="flex justify-end">
              {pinned && (
                <Pin size={12} className="text-accent" aria-label="Pinned to the sidebar" />
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
