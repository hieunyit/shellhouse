import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Copy,
  CornerDownRight,
  Download,
  File,
  FileX,
  Folder,
  History,
  Info,
  RefreshCw,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react'
import type { S3Op } from '../shared/ops'
import { shortVersionId, versionRef, type S3Version, type S3VersionListing } from '../shared/manage'
import { Button, cx } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import type { SortState } from '../../../renderer/src/components/SortMenu'
import {
  confirmAction,
  formatDateTime,
  formatNumber,
  formatRelative,
  t,
  tn,
  toast
} from '../../registry/renderer-kit'
import { cleanError, formatSize } from './format'
import { collator, columns, Empty, storageClassLabel, ToolButton, type SortKey } from './parts'

type Row =
  | { kind: 'folder'; name: string; key: string }
  | { kind: 'version'; version: S3Version; first: boolean }

/** Gộp phần "Load more" (bỏ trùng). */
function mergeVersions(base: S3VersionListing, more: S3VersionListing): S3VersionListing {
  const seen = new Set(base.versions.map(versionRef))
  const folders = new Set(base.folders.map((f) => f.key))
  return {
    ...more,
    folders: [...base.folders, ...more.folders.filter((f) => !folders.has(f.key))],
    versions: [...base.versions, ...more.versions.filter((v) => !seen.has(versionRef(v)))]
  }
}

/**
 * Chế độ "Show versions" của một thư mục: mọi phiên bản + delete marker của object (như "Show
 * versions" của AWS console). Tải về / khôi phục một phiên bản cũ, xoá vĩnh viễn phiên bản.
 */
export function S3VersionList({
  run,
  bucket,
  prefix,
  filter,
  sort,
  onSort,
  reloadKey,
  onOpenFolder,
  onDetails,
  onDeleteVersions,
  onChanged
}: {
  run: (op: S3Op) => Promise<unknown>
  bucket: string
  prefix: string
  filter: string
  sort: SortState<SortKey>
  onSort: (sort: SortState<SortKey>) => void
  /** Tăng lên để tải lại (sau khi xoá phiên bản…). */
  reloadKey: number
  onOpenFolder: (key: string) => void
  onDetails: (version: S3Version) => void
  onDeleteVersions: (versions: S3Version[]) => void
  /** Đã khôi phục một phiên bản — danh sách thường cũng đổi. */
  onChanged: () => void
}): React.JSX.Element {
  const [listing, setListing] = useState<S3VersionListing | null>(null)
  /** Lượt tải xong gần nhất — khác lượt hiện tại = đang tải. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  /** Nút "Try again" / sau khi khôi phục → tải lại. */
  const [refresh, setRefresh] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const { menu, open: openMenu } = useContextMenu()
  // Component được gắn `key` theo bucket/prefix: đổi thư mục = state mới hoàn toàn.
  const loadId = `${String(reloadKey)}:${String(refresh)}`
  const loading = loadedFor !== loadId

  useEffect(() => {
    let alive = true
    run({ op: 'listVersions', bucket, prefix }).then(
      (r) => {
        if (!alive) return
        const result = r as S3VersionListing
        setListing(result)
        setError(null)
        setLoadedFor(loadId)
        // Giữ mục đang chọn còn tồn tại.
        const refs = new Set(result.versions.map(versionRef))
        setSelected((cur) => {
          const next = new Set([...cur].filter((ref) => refs.has(ref)))
          return next.size === cur.size ? cur : next
        })
      },
      (e: unknown) => {
        if (!alive) return
        setListing(null)
        setError(cleanError(e))
        setLoadedFor(loadId)
      }
    )
    return () => {
      alive = false
    }
  }, [run, bucket, prefix, loadId])

  const load = (): void => {
    setRefresh((n) => n + 1)
  }

  const loadMore = async (): Promise<void> => {
    const base = listing
    if (!base?.next) return
    setLoadingMore(true)
    try {
      const more = (await run({
        op: 'listVersions',
        bucket,
        prefix,
        keyMarker: base.next.keyMarker,
        ...(base.next.versionIdMarker ? { versionIdMarker: base.next.versionIdMarker } : {})
      })) as S3VersionListing
      setListing((cur) => (cur === base ? mergeVersions(base, more) : cur))
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setLoadingMore(false)
    }
  }

  /** Thư mục trước; object theo kiểu sắp xếp (giá trị của bản mới nhất), các bản cũ ngay dưới. */
  const rows = useMemo((): Row[] => {
    if (!listing) return []
    const q = filter.trim().toLowerCase()
    const dir = sort.dir === 'asc' ? 1 : -1
    const folders = listing.folders
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .sort((a, b) => collator.compare(a.name, b.name))
    const groups = new Map<string, S3Version[]>()
    for (const v of listing.versions) {
      if (q && !v.name.toLowerCase().includes(q)) continue
      const list = groups.get(v.key)
      if (list) list.push(v)
      else groups.set(v.key, [v])
    }
    const ordered = [...groups.values()].sort((a, b) => {
      const x = a[0]
      const y = b[0]
      if (!x || !y) return 0
      const by =
        sort.key === 'size'
          ? x.size - y.size
          : sort.key === 'modified'
            ? (x.modified ?? 0) - (y.modified ?? 0)
            : 0
      return (by || collator.compare(x.name, y.name)) * dir
    })
    return [
      ...folders.map((f): Row => ({ kind: 'folder', name: f.name, key: f.key })),
      ...ordered.flatMap((group) =>
        group.map((version, i): Row => ({ kind: 'version', version, first: i === 0 }))
      )
    ]
  }, [listing, filter, sort])

  const versions = useMemo(
    () => rows.flatMap((r) => (r.kind === 'version' ? [r.version] : [])),
    [rows]
  )
  const chosen = useMemo(
    () => versions.filter((v) => selected.has(versionRef(v))),
    [versions, selected]
  )
  const one = chosen.length === 1 ? chosen[0] : undefined
  const markerCount = listing?.versions.filter((v) => v.deleteMarker).length ?? 0

  const select = (v: S3Version, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    const ref = versionRef(v)
    if (e.shiftKey && anchor.current !== null) {
      const a = versions.findIndex((x) => versionRef(x) === anchor.current)
      const b = versions.findIndex((x) => versionRef(x) === ref)
      if (a !== -1 && b !== -1) {
        const [from, to] = a < b ? [a, b] : [b, a]
        setSelected(new Set(versions.slice(from, to + 1).map(versionRef)))
        return
      }
    }
    anchor.current = ref
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      setSelected(next)
    } else setSelected(new Set([ref]))
  }

  const moveTo = (index: number, extend: boolean): void => {
    const v = versions[Math.max(0, Math.min(versions.length - 1, index))]
    if (!v) return
    const ref = versionRef(v)
    if (extend && anchor.current !== null) {
      const a = versions.findIndex((x) => versionRef(x) === anchor.current)
      const b = versions.indexOf(v)
      const [from, to] = a < b ? [a, b] : [b, a]
      setSelected(new Set(versions.slice(from, to + 1).map(versionRef)))
    } else {
      anchor.current = ref
      setSelected(new Set([ref]))
    }
    listRef.current
      ?.querySelector(`[data-ref="${CSS.escape(ref)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  const download = async (v: S3Version): Promise<void> => {
    const target = await window.shellhouse.pickSaveLocation(v.name)
    if (!target) return
    try {
      await run({
        op: 'download',
        bucket,
        key: v.key,
        localPath: target,
        overwrite: true,
        versionId: v.versionId
      })
    } catch (e) {
      toast.error(t('Could not download the version'), { description: cleanError(e) })
    }
  }

  const restore = async (v: S3Version): Promise<void> => {
    const ok = await confirmAction({
      title: t('Restore this version?'),
      message: t(
        'A copy of the version from {date} becomes the current “{name}”. Newer versions stay in the history.',
        { date: v.modified ? formatDateTime(v.modified) : '—', name: v.name }
      ),
      confirmLabel: t('Restore'),
      testId: 's3-restore-confirm'
    })
    if (!ok) return
    try {
      await run({ op: 'restoreVersion', bucket, key: v.key, versionId: v.versionId })
      toast.success(t('Restored “{name}”', { name: v.name }))
      onChanged()
      load()
    } catch (e) {
      toast.error(t('Could not restore the version'), { description: cleanError(e) })
    }
  }

  const canRestore = (v: S3Version | undefined): v is S3Version =>
    !!v && !v.deleteMarker && !v.isLatest

  const menuFor = (list: S3Version[]): MenuEntry[] => {
    const single = list.length === 1 ? list[0] : undefined
    const items: MenuEntry[] = []
    if (single) {
      items.push({
        id: 's3-version-details',
        label: t('Details'),
        icon: <Info size={14} />,
        disabled: single.deleteMarker,
        onSelect: () => {
          onDetails(single)
        }
      })
      if (!single.deleteMarker)
        items.push({
          id: 's3-version-download',
          label: t('Download this version…'),
          icon: <Download size={14} />,
          onSelect: () => void download(single)
        })
      if (canRestore(single))
        items.push({
          id: 's3-version-restore',
          label: t('Restore this version'),
          icon: <RotateCcw size={14} />,
          onSelect: () => void restore(single)
        })
      items.push({
        id: 's3-version-copy-id',
        label: t('Copy version ID'),
        icon: <Copy size={14} />,
        onSelect: () => void window.shellhouse.writeClipboard(single.versionId)
      })
    }
    items.push('separator', {
      id: 's3-version-delete',
      label: list.every((v) => v.deleteMarker)
        ? t('Remove delete marker…')
        : t('Delete permanently…'),
      icon: <Trash2 size={14} />,
      hint: 'Del',
      danger: true,
      onSelect: () => {
        onDeleteVersions(list)
      }
    })
    return items
  }

  const onKey = (e: React.KeyboardEvent): void => {
    const current = versions.findIndex((x) => versionRef(x) === anchor.current)
    const handled = (): void => {
      e.preventDefault()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      handled()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      moveTo(current === -1 ? (delta > 0 ? 0 : versions.length - 1) : current + delta, e.shiftKey)
    } else if (e.key === 'Home' || e.key === 'End') {
      handled()
      moveTo(e.key === 'Home' ? 0 : versions.length - 1, e.shiftKey)
    } else if (e.key === 'Enter' && one && !one.deleteMarker) {
      handled()
      onDetails(one)
    } else if (e.key === 'Delete' && chosen.length > 0) {
      handled()
      onDeleteVersions(chosen)
    } else if (e.key === 'Escape' && chosen.length > 0) {
      handled()
      setSelected(new Set())
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      handled()
      setSelected(new Set(versions.map(versionRef)))
    }
  }

  const header = (key: SortKey, label: string, className?: string): React.JSX.Element => {
    const active = sort.key === key
    const Arrow = sort.dir === 'asc' ? ChevronUp : ChevronDown
    return (
      <button
        type="button"
        role="columnheader"
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cx(
          'flex min-w-0 items-center gap-0.5 rounded hover:text-fg',
          key === 'size' && 'justify-end',
          active && 'text-muted',
          className
        )}
        onClick={() => {
          onSort(
            active
              ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key, dir: key === 'name' ? 'asc' : 'desc' }
          )
        }}
      >
        <span className="truncate">{label}</span>
        {active && <Arrow size={12} className="shrink-0" />}
      </button>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="s3-versions">
      {/* Thanh chọn: số mục + thao tác trên phiên bản đã chọn */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line bg-subtle/60 px-2 text-xs">
        <History size={13} className="mx-1 shrink-0 text-accent" />
        {chosen.length === 0 ? (
          <span className="min-w-0 flex-1 truncate text-muted">
            {t(
              'Showing every version and delete marker. Select a version to restore or delete it.'
            )}
          </span>
        ) : (
          <>
            <span className="shrink-0 px-1 font-medium text-fg" data-testid="s3-versions-selected">
              {tn(chosen.length, '{n} selected', '{n} selected')}
            </span>
            <button
              type="button"
              aria-label={t('Clear selection')}
              title={t('Clear selection (Esc)')}
              className="rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
              onClick={() => {
                setSelected(new Set())
              }}
            >
              <X size={12} />
            </button>
            <span className="flex-1" />
            {one && !one.deleteMarker && (
              <>
                <ToolButton
                  icon={<Info size={14} />}
                  label={t('Details')}
                  labelAt="3xl"
                  testId="s3-version-details"
                  onClick={() => {
                    onDetails(one)
                  }}
                />
                <ToolButton
                  icon={<Download size={14} />}
                  label={t('Download')}
                  labelAt="xl"
                  testId="s3-version-download"
                  onClick={() => void download(one)}
                />
              </>
            )}
            {canRestore(one) && (
              <ToolButton
                icon={<RotateCcw size={14} />}
                label={t('Restore')}
                labelAt="md"
                testId="s3-version-restore"
                onClick={() => void restore(one)}
              />
            )}
            <span className="mx-1 h-4 w-px shrink-0 bg-line" />
            <ToolButton
              icon={<Trash2 size={14} />}
              label={
                chosen.every((v) => v.deleteMarker)
                  ? t('Remove delete marker')
                  : t('Delete permanently')
              }
              labelAt="xl"
              danger
              testId="s3-version-delete"
              onClick={() => {
                onDeleteVersions(chosen)
              }}
            />
          </>
        )}
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
        role="grid"
        aria-label={t('Object versions')}
        aria-multiselectable
        aria-busy={loading}
        tabIndex={0}
        onKeyDown={onKey}
      >
        <div
          role="row"
          className={cx(
            'sticky top-0 z-10 grid h-8 items-center gap-3 border-b border-line bg-surface px-3 text-xs font-medium text-faint',
            columns
          )}
        >
          {header('name', t('Name'))}
          {header('size', t('Size'))}
          {header('modified', t('Modified'), 'hidden @xl:flex')}
          <span role="columnheader" className="hidden @3xl:block">
            {t('Class')}
          </span>
        </div>
        {error && !listing && (
          <Empty
            icon={<History size={20} />}
            title={t('Could not list versions')}
            text={error}
            action={
              <Button size="sm" icon={<RefreshCw size={13} />} onClick={load}>
                {t('Try again')}
              </Button>
            }
          />
        )}
        {listing && rows.length === 0 && (
          <Empty
            icon={<History size={20} />}
            title={filter ? t('No matches') : t('No versions here')}
            text={
              filter
                ? t('Nothing in this folder matches “{filter}”.', { filter })
                : t('This folder has no objects or versions.')
            }
            action={null}
          />
        )}
        {!listing && loading && (
          <p className="flex items-center gap-2 p-4 text-xs text-faint">
            <RefreshCw size={12} className="animate-spin" /> {t('Loading versions…')}
          </p>
        )}
        {rows.map((row) => {
          if (row.kind === 'folder')
            return (
              <div
                key={`d:${row.key}`}
                role="row"
                data-testid="s3-version-folder"
                data-name={row.name}
                className={cx(
                  'grid h-8 cursor-default items-center gap-3 px-3 text-[13px] select-none hover:bg-hover',
                  columns
                )}
                onDoubleClick={() => {
                  onOpenFolder(row.key)
                }}
              >
                <span role="gridcell" className="flex min-w-0 items-center gap-2">
                  <Folder size={15} className="shrink-0 text-accent" />
                  <span className="truncate">{row.name}</span>
                </span>
                <span role="gridcell" />
              </div>
            )
          const v = row.version
          const ref = versionRef(v)
          const isSelected = selected.has(ref)
          return (
            <div
              key={ref}
              role="row"
              aria-selected={isSelected}
              data-testid="s3-version"
              data-name={v.name}
              data-ref={ref}
              data-latest={v.isLatest}
              data-marker={v.deleteMarker}
              className={cx(
                'grid h-8 cursor-default items-center gap-3 px-3 text-[13px] select-none',
                columns,
                isSelected ? 'bg-accent-soft' : 'hover:bg-hover',
                !v.isLatest && !isSelected && 'text-muted'
              )}
              onClick={(e) => {
                select(v, e)
              }}
              onDoubleClick={() => {
                if (!v.deleteMarker) onDetails(v)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                const list = isSelected ? chosen : [v]
                if (!isSelected) {
                  anchor.current = ref
                  setSelected(new Set([ref]))
                }
                openMenu(e, menuFor(list))
              }}
            >
              <span role="gridcell" className="flex min-w-0 items-center gap-2">
                {row.first ? (
                  v.deleteMarker ? (
                    <FileX size={15} className="shrink-0 text-warning" />
                  ) : (
                    <File size={15} className="shrink-0 text-muted" />
                  )
                ) : (
                  <CornerDownRight size={13} className="ml-1 shrink-0 text-faint" />
                )}
                <span className={cx('truncate', !row.first && 'text-xs')} title={v.key}>
                  {row.first ? v.name : v.deleteMarker ? t('Delete marker') : t('Older version')}
                </span>
                {v.isLatest && (
                  <span className="shrink-0 rounded bg-accent-soft px-1.5 py-px text-[10.5px] font-medium text-accent">
                    {v.deleteMarker ? t('Deleted') : t('Current')}
                  </span>
                )}
                {row.first && v.deleteMarker && !v.isLatest && (
                  <span className="shrink-0 rounded bg-warning-soft px-1.5 py-px text-[10.5px] text-warning">
                    {t('Delete marker')}
                  </span>
                )}
                <span
                  className="hidden shrink-0 font-mono text-[11px] text-faint @2xl:inline"
                  title={v.versionId}
                >
                  {shortVersionId(v.versionId)}
                </span>
              </span>
              <span role="gridcell" className="text-right text-xs text-muted tabular-nums">
                {v.deleteMarker ? '—' : formatSize(v.size)}
              </span>
              <span
                role="gridcell"
                className="hidden truncate text-xs text-muted tabular-nums @xl:block"
                title={v.modified ? formatRelative(v.modified) : undefined}
              >
                {v.modified ? formatDateTime(v.modified) : ''}
              </span>
              <span role="gridcell" className="hidden truncate text-xs text-faint @3xl:block">
                {v.deleteMarker ? '' : storageClassLabel(v.storageClass)}
              </span>
            </div>
          )
        })}
        {listing?.truncated && (
          <div className="flex items-center gap-3 p-3 text-xs text-faint">
            <span className="min-w-0 flex-1">
              {t('Showing the first {n} versions.', { n: formatNumber(listing.versions.length) })}
            </span>
            {listing.next && (
              <Button size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? t('Loading…') : t('Load more')}
              </Button>
            )}
          </div>
        )}
      </div>
      {listing && (
        <div
          className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-3 text-xs whitespace-nowrap text-faint"
          data-testid="s3-versions-status"
        >
          <span className="min-w-0 flex-1 truncate">
            {tn(listing.versions.length - markerCount, '{n} version', '{n} versions')}
            {markerCount > 0
              ? ` · ${tn(markerCount, '{n} delete marker', '{n} delete markers')}`
              : ''}
            {listing.folders.length > 0
              ? ` · ${tn(listing.folders.length, '{n} folder', '{n} folders')}`
              : ''}
          </span>
          {loading && <RefreshCw size={11} className="animate-spin" />}
        </div>
      )}
      {menu}
    </div>
  )
}
