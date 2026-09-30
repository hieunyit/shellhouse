import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cloud,
  CloudUpload,
  Copy,
  Database,
  Download,
  File,
  FilePen,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Link,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import {
  bucketNameProblem,
  objectNameProblem,
  parentPrefix,
  type S3Bucket,
  type S3Entry,
  type S3Listing,
  type S3Op
} from '@shared/s3'
import { joinLocal } from '@shared/local-files'
import type { TransferStatus } from '@shared/sftp'
import { Button, Checkbox, cx, IconButton, Input, Modal, Notice, Select } from '../components/ui'
import { useContextMenu, type MenuEntry } from '../components/ContextMenu'
import { S3StatsDialog, type StatsTarget } from './S3Stats'
import { cleanError, formatSize } from './format'
import { S3Transfers } from './S3Transfers'
import { useS3 } from '../stores/s3'
import { useTabStatus } from '../stores/tab-status'
import { S3SessionClient } from './s3-client'

type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'bucket' }
  | { kind: 'delete'; entries: S3Entry[] }
  | { kind: 'link'; entry: S3Entry }
  | { kind: 'rename'; entry: S3Entry }
  | { kind: 'copy'; entries: S3Entry[]; move: boolean }
  | null

/** Trình quản lý S3 (như S3 Browser) của một tài khoản — một tab. */
export function S3View({
  tabId,
  accountId
}: {
  tabId: string
  accountId: string
}): React.JSX.Element {
  const account = useS3((s) => s.accounts.find((a) => a.id === accountId))
  const clientRef = useRef<S3SessionClient | null>(null)
  const [ready, setReady] = useState(false)
  const [buckets, setBuckets] = useState<S3Bucket[] | null>(null)
  const [bucket, setBucket] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [listing, setListing] = useState<S3Listing | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [transfers, setTransfers] = useState<TransferStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dragOver, setDragOver] = useState(false)
  const [stats, setStats] = useState<StatsTarget[] | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'name',
    dir: 'asc'
  })
  const { menu, open: openMenu } = useContextMenu()
  const listRef = useRef<HTMLDivElement | null>(null)
  /** Mục "con trỏ" cho phím mũi tên và Shift+bấm. */
  const anchor = useRef<string | null>(null)

  const run = useCallback(async (op: S3Op): Promise<unknown> => {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    return client.request(op)
  }, [])

  // Mở phiên S3 (Session Host) cho tab; đóng khi tab đóng.
  useEffect(() => {
    let cancelled = false
    useTabStatus.getState().set(tabId, 'connecting')
    void S3SessionClient.open(accountId, setTransfers).then(
      (client) => {
        if (cancelled) {
          client.close()
          return
        }
        clientRef.current = client
        setReady(true)
        useTabStatus.getState().set(tabId, 'connected')
        void client.request({ op: 'listBuckets' }).then(
          (list) => {
            if (!cancelled) setBuckets(list as S3Bucket[])
          },
          (e: unknown) => {
            if (cancelled) return
            setBuckets([])
            setError(cleanError(e))
          }
        )
      },
      (e: unknown) => {
        if (cancelled) return
        setError(cleanError(e))
        useTabStatus.getState().set(tabId, 'disconnected')
      }
    )
    return () => {
      cancelled = true
      clientRef.current?.close()
      clientRef.current = null
      useTabStatus.getState().remove(tabId)
    }
  }, [accountId, tabId])

  const loadBuckets = useCallback(async () => {
    setError(null)
    try {
      const list = (await run({ op: 'listBuckets' })) as S3Bucket[]
      setBuckets(list)
    } catch (e) {
      setBuckets([])
      setError(cleanError(e))
    }
  }, [run])

  const load = useCallback(
    async (b: string, p: string) => {
      setLoading(true)
      setError(null)
      try {
        const result = (await run({ op: 'list', bucket: b, prefix: p })) as S3Listing
        setListing(result)
        setBucket(b)
        setPrefix(p)
        setSelected(new Set())
      } catch (e) {
        setError(cleanError(e))
      } finally {
        setLoading(false)
      }
    },
    [run]
  )

  // Tải lên xong → làm mới thư mục đang xem.
  const doneUploads = transfers.filter((t) => t.direction === 'upload' && t.state === 'done').length
  const lastDone = useRef(0)
  useEffect(() => {
    if (doneUploads > lastDone.current && bucket !== null) void load(bucket, prefix)
    lastDone.current = doneUploads
  }, [doneUploads, bucket, prefix, load])

  const act = async (op: S3Op): Promise<unknown> => {
    try {
      return await run(op)
    } catch (e) {
      setError(cleanError(e))
      return undefined
    }
  }

  const upload = async (paths: string[]): Promise<void> => {
    if (bucket === null) return
    for (const localPath of paths) await act({ op: 'upload', bucket, prefix, localPath })
  }

  const download = async (entries: S3Entry[]): Promise<void> => {
    if (bucket === null || entries.length === 0) return
    const only = entries[0]
    if (entries.length === 1 && only && !only.isFolder) {
      const target = await window.shellhouse.pickSaveLocation(only.name)
      if (target)
        await act({ op: 'download', bucket, key: only.key, localPath: target, overwrite: true })
      return
    }
    const dir = await window.shellhouse.pickFolder('Choose where to save', 'downloads')
    if (!dir) return
    const { sep } = await window.shellhouse.listLocal(dir)
    for (const e of entries)
      await act({
        op: 'download',
        bucket,
        key: e.key,
        localPath: e.isFolder ? dir : joinLocal(dir, e.name, sep),
        overwrite: false
      })
  }

  /** Sửa bằng editor trên máy: lưu → tự tải lên (xem session-host/s3/edit.ts). */
  const edit = async (entry: S3Entry): Promise<void> => {
    if (bucket === null || entry.isFolder) return
    setError(null)
    setOpening(entry.key)
    try {
      const localPath = await window.shellhouse.prepareRemoteEdit(entry.name)
      await run({ op: 'edit', bucket, key: entry.key, localPath })
      await window.shellhouse.openInEditor(localPath)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setOpening(null)
    }
  }

  const folderStats = (list: S3Entry[]): void => {
    if (bucket === null) return
    const folders = list.filter((e) => e.isFolder)
    setStats(
      folders.length > 0
        ? folders.map((e) => ({ bucket, prefix: e.key, label: `${bucket}/${e.key}` }))
        : [{ bucket, prefix, label: prefix ? `${bucket}/${prefix}` : bucket }]
    )
  }

  const entryMenu = (list: S3Entry[]): MenuEntry[] => {
    const one = list.length === 1 ? list[0] : undefined
    const items: MenuEntry[] = []
    if (one?.isFolder)
      items.push({
        id: 's3-open',
        label: 'Open',
        icon: <FolderOpen size={14} />,
        onSelect: () => {
          if (bucket !== null) void load(bucket, one.key)
        }
      })
    if (one && !one.isFolder)
      items.push({
        id: 's3-edit',
        label: 'Edit in local editor',
        icon: <FilePen size={14} />,
        onSelect: () => void edit(one)
      })
    items.push({
      id: 's3-download',
      label: list.length > 1 ? `Download ${list.length} items…` : 'Download…',
      icon: <Download size={14} />,
      onSelect: () => void download(list)
    })
    if (one && !one.isFolder)
      items.push({
        id: 's3-link',
        label: 'Share link…',
        icon: <Link size={14} />,
        onSelect: () => {
          setDialog({ kind: 'link', entry: one })
        }
      })
    items.push('separator')
    if (one)
      items.push({
        id: 's3-rename',
        label: 'Rename…',
        icon: <Pencil size={14} />,
        hint: 'F2',
        onSelect: () => {
          setDialog({ kind: 'rename', entry: one })
        }
      })
    items.push(
      {
        id: 's3-copy',
        label: 'Copy to…',
        icon: <Copy size={14} />,
        onSelect: () => {
          setDialog({ kind: 'copy', entries: list, move: false })
        }
      },
      {
        id: 's3-move',
        label: 'Move to…',
        icon: <FolderInput size={14} />,
        onSelect: () => {
          setDialog({ kind: 'copy', entries: list, move: true })
        }
      }
    )
    if (list.some((e) => e.isFolder))
      items.push({
        id: 's3-stats',
        label: 'Size & object count',
        icon: <BarChart3 size={14} />,
        onSelect: () => {
          folderStats(list)
        }
      })
    items.push('separator', {
      id: 's3-delete',
      label: 'Delete…',
      icon: <Trash2 size={14} />,
      hint: 'Del',
      danger: true,
      onSelect: () => {
        setDialog({ kind: 'delete', entries: list })
      }
    })
    return items
  }

  const entries = useMemo(() => {
    const all = listing?.entries ?? []
    const q = filter.trim().toLowerCase()
    const shown = q ? all.filter((e) => e.name.toLowerCase().includes(q)) : [...all]
    const dir = sort.dir === 'asc' ? 1 : -1
    // Thư mục luôn đứng trước; cùng giá trị thì theo tên (số theo thứ tự tự nhiên: 2 < 10).
    return shown.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
      // Thư mục không có dung lượng / ngày: sắp theo Size / Modified thì vẫn giữ A→Z.
      if (a.isFolder && sort.key !== 'name') return collator.compare(a.name, b.name)
      const by =
        sort.key === 'size'
          ? a.size - b.size
          : sort.key === 'modified'
            ? (a.modified ?? 0) - (b.modified ?? 0)
            : 0
      return (by || collator.compare(a.name, b.name)) * dir
    })
  }, [listing, filter, sort])
  const chosen = entries.filter((e) => selected.has(e.key))
  const crumbs = prefix.split('/').filter(Boolean)
  const fileCount = listing?.entries.filter((e) => !e.isFolder).length ?? 0
  const folderCount = (listing?.entries.length ?? 0) - fileCount
  const filesSize = listing?.entries.reduce((n, e) => n + e.size, 0) ?? 0
  const one = chosen.length === 1 ? chosen[0] : undefined

  /** Chọn như trình quản lý file: bấm = chọn một, Ctrl/⌘ = thêm/bớt, Shift = chọn dải. */
  const select = (entry: S3Entry, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (e.shiftKey && anchor.current !== null) {
      const a = entries.findIndex((x) => x.key === anchor.current)
      const b = entries.findIndex((x) => x.key === entry.key)
      if (a !== -1 && b !== -1) {
        const [from, to] = a < b ? [a, b] : [b, a]
        setSelected(new Set(entries.slice(from, to + 1).map((x) => x.key)))
        return
      }
    }
    anchor.current = entry.key
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(entry.key)) next.delete(entry.key)
      else next.add(entry.key)
      setSelected(next)
    } else setSelected(new Set([entry.key]))
  }

  const moveCursor = (delta: number): void => {
    if (entries.length === 0) return
    const current = entries.findIndex((x) => x.key === anchor.current)
    const next =
      current === -1
        ? delta > 0
          ? 0
          : entries.length - 1
        : Math.max(0, Math.min(entries.length - 1, current + delta))
    const entry = entries[next]
    if (!entry) return
    anchor.current = entry.key
    setSelected(new Set([entry.key]))
    listRef.current
      ?.querySelector(`[data-key="${CSS.escape(entry.key)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  const onListKey = (e: React.KeyboardEvent): void => {
    const handled = (): void => {
      e.preventDefault()
    }
    if (e.key === 'ArrowDown') {
      handled()
      moveCursor(1)
    } else if (e.key === 'ArrowUp') {
      handled()
      moveCursor(-1)
    } else if (e.key === 'F2' && one) {
      handled()
      setDialog({ kind: 'rename', entry: one })
    } else if (e.key === 'Delete' && chosen.length > 0) {
      handled()
      setDialog({ kind: 'delete', entries: chosen })
    } else if (e.key === 'Enter' && one && bucket !== null) {
      handled()
      if (one.isFolder) void load(bucket, one.key)
      else void download([one])
    } else if (e.key === 'Backspace' && bucket !== null && prefix !== '') {
      handled()
      void load(bucket, parentPrefix(prefix))
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      handled()
      setSelected(new Set(entries.map((x) => x.key)))
    }
  }

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(false)
    const paths = [...event.dataTransfer.files]
      .map((f) => window.shellhouse.pathForFile(f))
      .filter(Boolean)
    void upload(paths)
  }

  const sortHeader = (key: SortKey, label: string, className?: string): React.JSX.Element => {
    const activeSort = sort.key === key
    const Arrow = sort.dir === 'asc' ? ChevronUp : ChevronDown
    return (
      <button
        type="button"
        role="columnheader"
        aria-sort={activeSort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cx(
          'flex min-w-0 items-center gap-0.5 rounded hover:text-fg',
          key === 'size' && 'justify-end',
          activeSort && 'text-muted',
          className
        )}
        onClick={() => {
          setSort(
            activeSort
              ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key, dir: key === 'name' ? 'asc' : 'desc' }
          )
        }}
      >
        <span className="truncate">{label}</span>
        {activeSort && <Arrow size={12} className="shrink-0" />}
      </button>
    )
  }

  const location = bucket === null ? '' : `${bucket}/${prefix}`

  return (
    <div
      className="@container flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-surface"
      data-testid="s3-view"
    >
      {/* Buckets */}
      <aside className="flex w-40 shrink-0 flex-col border-r border-line bg-subtle/40 @3xl:w-56">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3 text-xs">
          <Cloud size={14} className="shrink-0 text-muted" />
          <span
            className="min-w-0 flex-1 truncate font-medium text-fg"
            title={account ? account.endpoint || `AWS ${account.region || 'us-east-1'}` : undefined}
          >
            {account?.name ?? 'S3'}
          </span>
          <IconButton label="Refresh buckets" size="sm" onClick={() => void loadBuckets()}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
        <div className="flex h-8 shrink-0 items-center gap-1 pr-1.5 pl-3 text-[11px] font-semibold tracking-wider text-faint uppercase">
          <span className="flex-1">
            Buckets{buckets && buckets.length > 0 ? ` · ${buckets.length}` : ''}
          </span>
          <IconButton
            label="Bucket statistics"
            size="sm"
            data-testid="s3-bucket-stats"
            disabled={!buckets || buckets.length === 0}
            onClick={() => {
              setStats((buckets ?? []).map((b) => ({ bucket: b.name, prefix: '', label: b.name })))
            }}
          >
            <BarChart3 size={13} />
          </IconButton>
          <IconButton
            label="New bucket"
            size="sm"
            data-testid="s3-new-bucket"
            disabled={!ready}
            onClick={() => {
              setDialog({ kind: 'bucket' })
            }}
          >
            <Plus size={13} />
          </IconButton>
        </div>
        <div
          className="min-h-0 flex-1 overflow-auto px-1.5 pb-1.5"
          role="listbox"
          aria-label="Buckets"
        >
          {buckets === null && !error && (
            <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-faint">
              <RefreshCw size={12} className="animate-spin" /> Connecting…
            </p>
          )}
          {buckets?.length === 0 && <p className="px-2 py-1.5 text-xs text-faint">No buckets.</p>}
          {buckets?.map((b) => (
            <button
              key={b.name}
              type="button"
              role="option"
              aria-selected={bucket === b.name}
              data-testid="s3-bucket"
              data-name={b.name}
              title={
                b.createdAt
                  ? `${b.name}\nCreated ${dateFormat.format(new Date(b.createdAt))}`
                  : b.name
              }
              className={cx(
                'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
                bucket === b.name
                  ? 'bg-accent-soft font-medium text-fg'
                  : 'text-muted hover:bg-hover hover:text-fg'
              )}
              onClick={() => void load(b.name, '')}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(e, [
                  {
                    id: 's3-bucket-open',
                    label: 'Open',
                    icon: <FolderOpen size={14} />,
                    onSelect: () => void load(b.name, '')
                  },
                  {
                    id: 's3-bucket-stats',
                    label: 'Size & object count',
                    icon: <BarChart3 size={14} />,
                    onSelect: () => {
                      setStats([{ bucket: b.name, prefix: '', label: b.name }])
                    }
                  }
                ])
              }}
            >
              <Database
                size={14}
                className={cx('shrink-0', bucket === b.name ? 'text-accent' : '')}
              />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Objects */}
      <section
        className="@container relative flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (bucket !== null && e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
        }}
        onDrop={onDrop}
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
          <IconButton
            label="Parent folder (Backspace)"
            disabled={bucket === null || prefix === ''}
            onClick={() => bucket !== null && void load(bucket, parentPrefix(prefix))}
          >
            <ArrowUp size={15} />
          </IconButton>
          <nav
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[13px] whitespace-nowrap"
            aria-label="Path"
            data-testid="s3-path"
            title={location ? `s3://${location}` : undefined}
          >
            {bucket === null ? (
              <span className="px-1 text-faint">No bucket selected</span>
            ) : (
              <>
                <button
                  type="button"
                  className="min-w-0 shrink truncate rounded px-1.5 py-0.5 font-medium text-fg hover:bg-hover"
                  onClick={() => void load(bucket, '')}
                >
                  {bucket}
                </button>
                {crumbs.map((c, i) => (
                  <span key={i} className="flex min-w-0 shrink items-center gap-0.5">
                    <ChevronRight size={12} className="shrink-0 text-faint" />
                    <button
                      type="button"
                      className={cx(
                        'min-w-0 truncate rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg',
                        i === crumbs.length - 1 ? 'text-fg' : 'text-muted'
                      )}
                      onClick={() => void load(bucket, `${crumbs.slice(0, i + 1).join('/')}/`)}
                    >
                      {c}
                    </button>
                  </span>
                ))}
              </>
            )}
          </nav>
          <label className="flex h-7 w-28 shrink-0 items-center gap-1.5 rounded-md border border-line bg-subtle px-2 focus-within:border-accent @xl:w-44">
            <Search size={12} className="shrink-0 text-faint" />
            <input
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
              placeholder="Filter"
              aria-label="Filter this folder"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
              }}
            />
            {filter && (
              <button
                type="button"
                aria-label="Clear filter"
                className="text-faint hover:text-fg"
                onClick={() => {
                  setFilter('')
                }}
              >
                <X size={12} />
              </button>
            )}
          </label>
          <IconButton
            label="Refresh"
            disabled={bucket === null}
            onClick={() => bucket !== null && void load(bucket, prefix)}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </IconButton>
        </div>

        <div
          className="flex h-10 shrink-0 items-center gap-0.5 overflow-hidden border-b border-line px-2"
          role="toolbar"
          aria-label="Actions"
        >
          <ToolButton
            icon={<Upload size={14} />}
            label="Upload"
            labelAt="md"
            testId="s3-upload"
            disabled={bucket === null}
            onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
          />
          <ToolButton
            icon={<FolderUp size={14} />}
            label="Upload folder"
            labelAt="5xl"
            disabled={bucket === null}
            onClick={() =>
              void window.shellhouse
                .pickFolder('Choose a folder to upload', 'downloads')
                .then((dir) => upload(dir ? [dir] : []))
            }
          />
          <ToolButton
            icon={<FolderPlus size={14} />}
            label="New folder"
            labelAt="xl"
            testId="s3-mkdir"
            disabled={bucket === null}
            onClick={() => {
              setDialog({ kind: 'mkdir' })
            }}
          />
          <span className="flex-1" />
          {chosen.length > 0 && (
            <>
              {one && !one.isFolder && (
                <ToolButton
                  icon={<FilePen size={14} />}
                  label={opening ? 'Opening…' : 'Edit'}
                  labelAt="3xl"
                  testId="s3-edit"
                  disabled={opening !== null}
                  onClick={() => void edit(one)}
                />
              )}
              <ToolButton
                icon={<Download size={14} />}
                label={chosen.length > 1 ? `Download ${chosen.length}` : 'Download'}
                labelAt="xl"
                testId="s3-download"
                onClick={() => void download(chosen)}
              />
              {one && !one.isFolder && (
                <ToolButton
                  icon={<Link size={14} />}
                  label="Share link"
                  labelAt="5xl"
                  testId="s3-link"
                  onClick={() => {
                    setDialog({ kind: 'link', entry: one })
                  }}
                />
              )}
              {one && (
                <ToolButton
                  icon={<Pencil size={14} />}
                  label="Rename"
                  labelAt="5xl"
                  testId="s3-rename"
                  onClick={() => {
                    setDialog({ kind: 'rename', entry: one })
                  }}
                />
              )}
              <ToolButton
                icon={<Copy size={14} />}
                label="Copy to…"
                labelAt="5xl"
                testId="s3-copy"
                onClick={() => {
                  setDialog({ kind: 'copy', entries: chosen, move: false })
                }}
              />
              <ToolButton
                icon={<FolderInput size={14} />}
                label="Move to…"
                labelAt="5xl"
                testId="s3-move"
                onClick={() => {
                  setDialog({ kind: 'copy', entries: chosen, move: true })
                }}
              />
              <span className="mx-1 h-4 w-px shrink-0 bg-line" />
              <ToolButton
                icon={<Trash2 size={14} />}
                label="Delete"
                labelAt="3xl"
                testId="s3-delete"
                danger
                onClick={() => {
                  setDialog({ kind: 'delete', entries: chosen })
                }}
              />
            </>
          )}
        </div>

        {error && (
          <div className="flex shrink-0 items-start gap-1 border-b border-line p-2">
            <div className="min-w-0 flex-1">
              <Notice tone="danger" testId="s3-error">
                {error}
              </Notice>
            </div>
            <IconButton
              label="Dismiss"
              size="sm"
              onClick={() => {
                setError(null)
              }}
            >
              <X size={13} />
            </IconButton>
          </div>
        )}

        {bucket === null ? (
          <Empty
            icon={<Database size={20} />}
            title={buckets?.length === 0 ? 'No buckets yet' : 'Choose a bucket'}
            text={
              buckets?.length === 0
                ? 'Create a bucket to start storing files.'
                : 'Pick a bucket on the left to browse its folders and objects.'
            }
            action={
              buckets?.length === 0 ? (
                <Button
                  size="sm"
                  icon={<Plus size={13} />}
                  onClick={() => {
                    setDialog({ kind: 'bucket' })
                  }}
                >
                  New bucket
                </Button>
              ) : null
            }
          />
        ) : (
          <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
            role="grid"
            aria-label="Objects"
            aria-multiselectable
            tabIndex={0}
            onKeyDown={onListKey}
          >
            <div
              role="row"
              className={cx(
                'sticky top-0 z-10 grid h-8 items-center gap-3 border-b border-line bg-surface px-3 text-[11px] font-medium text-faint',
                columns
              )}
            >
              {sortHeader('name', 'Name')}
              {sortHeader('size', 'Size')}
              {sortHeader('modified', 'Modified', 'hidden @xl:flex')}
              <span role="columnheader" className="hidden @3xl:block">
                Class
              </span>
            </div>
            {listing && entries.length === 0 && (
              <Empty
                icon={<FolderOpen size={20} />}
                title={filter ? 'No matches' : 'This folder is empty'}
                text={
                  filter
                    ? `Nothing in this folder matches “${filter}”.`
                    : 'Drop files here, or upload from your computer.'
                }
                action={
                  filter ? null : (
                    <Button
                      size="sm"
                      icon={<Upload size={13} />}
                      onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
                    >
                      Upload files
                    </Button>
                  )
                }
              />
            )}
            {entries.map((entry) => {
              const isSelected = selected.has(entry.key)
              return (
                <div
                  key={entry.key}
                  role="row"
                  aria-selected={isSelected}
                  data-testid="s3-entry"
                  data-name={entry.name}
                  data-key={entry.key}
                  className={cx(
                    'grid h-8 cursor-default items-center gap-3 px-3 text-[13px] select-none',
                    columns,
                    isSelected ? 'bg-accent-soft' : 'hover:bg-hover'
                  )}
                  onClick={(e) => {
                    select(entry, e)
                  }}
                  onDoubleClick={() => {
                    if (entry.isFolder) void load(bucket, entry.key)
                    else void download([entry])
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    // Chuột phải vào mục chưa chọn → chỉ chọn mục đó (như trình quản lý file).
                    const list = isSelected ? chosen : [entry]
                    if (!isSelected) {
                      anchor.current = entry.key
                      setSelected(new Set([entry.key]))
                    }
                    openMenu(e, entryMenu(list))
                  }}
                >
                  <span role="gridcell" className="flex min-w-0 items-center gap-2">
                    {entry.isFolder ? (
                      <Folder size={15} className="shrink-0 text-accent" />
                    ) : (
                      <File size={15} className="shrink-0 text-muted" />
                    )}
                    <span className="truncate" title={entry.name}>
                      {entry.name}
                    </span>
                  </span>
                  <span role="gridcell" className="text-right text-xs text-muted tabular-nums">
                    {entry.isFolder ? '' : formatSize(entry.size)}
                  </span>
                  <span
                    role="gridcell"
                    className="hidden truncate text-xs text-muted tabular-nums @xl:block"
                  >
                    {entry.modified ? dateFormat.format(new Date(entry.modified)) : ''}
                  </span>
                  <span role="gridcell" className="hidden truncate text-xs text-faint @3xl:block">
                    {entry.isFolder ? '' : storageClassLabel(entry.storageClass)}
                  </span>
                </div>
              )
            })}
            {listing?.truncated && (
              <p className="p-3 text-xs text-faint">
                Only the first 5,000 items are shown. Use the filter or open a subfolder.
              </p>
            )}
            {!listing && loading && (
              <p className="flex items-center gap-2 p-4 text-xs text-faint">
                <RefreshCw size={12} className="animate-spin" /> Loading…
              </p>
            )}
          </div>
        )}

        {listing && bucket !== null && (
          <div
            className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-3 text-[11px] whitespace-nowrap text-faint"
            data-testid="s3-status"
          >
            <span className="min-w-0 flex-1 truncate">
              {folderCount} folder{folderCount === 1 ? '' : 's'}, {fileCount} file
              {fileCount === 1 ? '' : 's'} · {formatSize(filesSize)}
              {chosen.length > 0 ? ` · ${chosen.length} selected` : ''}
            </span>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg"
              title="Count every object in this folder and its subfolders"
              data-testid="s3-folder-stats"
              onClick={() => {
                folderStats([])
              }}
            >
              <BarChart3 size={12} />
              <span className="hidden @md:inline">Folder size…</span>
            </button>
          </div>
        )}

        <S3Transfers
          transfers={transfers}
          onCancel={(id) => void act({ op: 'cancel', transferId: id })}
          onClear={() => void act({ op: 'clearDone' })}
        />

        {dragOver && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80">
            <p className="flex items-center gap-2 text-sm font-medium text-fg">
              <CloudUpload size={18} className="text-accent" />
              Drop to upload to {location || bucket}
            </p>
          </div>
        )}
      </section>

      {menu}
      {stats && (
        <S3StatsDialog
          targets={stats}
          run={run}
          onClose={() => {
            setStats(null)
          }}
        />
      )}
      {dialog && (
        <S3Dialog
          dialog={dialog}
          buckets={buckets ?? []}
          bucket={bucket}
          prefix={prefix}
          run={run}
          onClose={() => {
            setDialog(null)
          }}
          onDone={async (kind) => {
            setDialog(null)
            if (kind === 'bucket') await loadBuckets()
            else if (bucket !== null) await load(bucket, prefix)
          }}
        />
      )}
    </div>
  )
}

type SortKey = 'name' | 'size' | 'modified'

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
/** Ngày giờ dạng số theo thói quen máy người dùng (không có chữ → giao diện vẫn thuần tiếng Anh). */
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})
/** Cột danh sách: Modified / Class chỉ hiện khi khung đủ rộng (container query). */
const columns =
  'grid-cols-[minmax(0,1fr)_5rem] @xl:grid-cols-[minmax(0,1fr)_5rem_8.5rem] @3xl:grid-cols-[minmax(0,1fr)_5rem_8.5rem_6.5rem]'

function storageClassLabel(cls: string | null): string {
  if (!cls) return 'Standard'
  return cls
    .toLowerCase()
    .split('_')
    .map((w) => (w === 'ia' ? 'IA' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

/** Mức rộng của khung mà từ đó nút hiện cả chữ (hẹp hơn: chỉ icon + tooltip). */
const labelAt = {
  md: 'hidden @md:inline',
  xl: 'hidden @xl:inline',
  '3xl': 'hidden @3xl:inline',
  '5xl': 'hidden @5xl:inline'
} as const

function ToolButton({
  icon,
  label,
  labelAt: at,
  testId,
  danger,
  disabled,
  onClick
}: {
  icon: React.ReactNode
  label: string
  labelAt: keyof typeof labelAt
  testId?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      className={cx(
        'inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40',
        danger ? 'text-danger hover:bg-danger-soft' : 'text-muted hover:bg-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {icon}
      <span className={cx(labelAt[at], 'pr-0.5')}>{label}</span>
    </button>
  )
}

function Empty({
  icon,
  title,
  text,
  action
}: {
  icon: React.ReactNode
  title: string
  text: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl border border-line bg-subtle text-muted">
        {icon}
      </span>
      <p className="mt-1 text-[13px] font-medium text-fg">{title}</p>
      <p className="max-w-xs text-xs text-muted">{text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

function S3Dialog({
  dialog,
  buckets,
  bucket,
  prefix,
  run,
  onClose,
  onDone
}: {
  dialog: NonNullable<Dialog>
  buckets: S3Bucket[]
  bucket: string | null
  prefix: string
  run: (op: S3Op) => Promise<unknown>
  onClose: () => void
  onDone: (kind: NonNullable<Dialog>['kind']) => Promise<void>
}): React.JSX.Element {
  const [value, setValue] = useState(dialog.kind === 'rename' ? dialog.entry.name : '')
  const [destBucket, setDestBucket] = useState(bucket ?? '')
  const [destPrefix, setDestPrefix] = useState(prefix)
  const [overwrite, setOverwrite] = useState(false)
  const [expires, setExpires] = useState('3600')
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const problem =
    dialog.kind === 'bucket'
      ? value
        ? bucketNameProblem(value)
        : 'Enter a name'
      : dialog.kind === 'mkdir'
        ? !value.trim() || value.includes('/')
          ? 'Enter a folder name (no “/”)'
          : null
        : dialog.kind === 'rename'
          ? objectNameProblem(value)
          : dialog.kind === 'copy'
            ? destBucket
              ? destPrefix.startsWith('/') || destPrefix.includes('//')
                ? 'Use a path like logs/2024/ (no leading “/”)'
                : null
              : 'Choose a bucket'
            : null

  const submit = async (): Promise<void> => {
    if (problem) return
    setBusy(true)
    setError(null)
    try {
      if (dialog.kind === 'bucket') await run({ op: 'createBucket', bucket: value })
      if (dialog.kind === 'mkdir' && bucket !== null)
        await run({ op: 'mkdir', bucket, key: `${prefix}${value.trim()}/` })
      if (dialog.kind === 'delete' && bucket !== null)
        await run({ op: 'delete', bucket, keys: dialog.entries.map((e) => e.key) })
      if (dialog.kind === 'rename' && bucket !== null)
        await run({ op: 'rename', bucket, key: dialog.entry.key, name: value, overwrite: false })
      if (dialog.kind === 'copy' && bucket !== null)
        await run({
          op: 'copy',
          bucket,
          keys: dialog.entries.map((e) => e.key),
          destBucket,
          destPrefix: destPrefix.trim(),
          move: dialog.move,
          overwrite
        })
      if (dialog.kind === 'link' && bucket !== null) {
        setUrl(
          (await run({
            op: 'presign',
            bucket,
            key: dialog.entry.key,
            expiresSeconds: Number(expires)
          })) as string
        )
        setBusy(false)
        return
      }
      await onDone(dialog.kind)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const titles = {
    bucket: 'New bucket',
    mkdir: 'New folder',
    delete: 'Delete',
    link: 'Share link',
    rename: 'Rename',
    copy: dialog.kind === 'copy' && dialog.move ? 'Move to' : 'Copy to'
  } as const
  const submitLabel = {
    bucket: 'Create',
    mkdir: 'Create',
    delete: 'Delete',
    link: 'Create link',
    rename: 'Rename',
    copy: dialog.kind === 'copy' && dialog.move ? 'Move' : 'Copy'
  } as const
  const folders = dialog.kind === 'delete' ? dialog.entries.filter((e) => e.isFolder).length : 0

  return (
    <Modal
      title={titles[dialog.kind]}
      onClose={onClose}
      width="max-w-md"
      testId="s3-dialog"
      footer={
        <>
          <Button onClick={onClose}>{url ? 'Close' : 'Cancel'}</Button>
          {!url && (
            <Button
              variant={dialog.kind === 'delete' ? 'danger' : 'primary'}
              disabled={!!problem || busy}
              data-testid="s3-dialog-submit"
              onClick={() => void submit()}
            >
              {busy && (dialog.kind === 'copy' || dialog.kind === 'rename')
                ? 'Working…'
                : submitLabel[dialog.kind]}
            </Button>
          )}
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {(dialog.kind === 'bucket' || dialog.kind === 'mkdir') && (
          <Input
            autoFocus
            mono
            data-testid="s3-dialog-input"
            placeholder={dialog.kind === 'bucket' ? 'my-bucket' : 'folder name'}
            value={value}
            onChange={(e) => {
              setValue(dialog.kind === 'bucket' ? e.target.value.toLowerCase() : e.target.value)
            }}
          />
        )}
        {dialog.kind === 'rename' && (
          <Input
            autoFocus
            mono
            data-testid="s3-dialog-input"
            value={value}
            onFocus={(e) => {
              // Chọn phần tên, chừa đuôi file (như Explorer / Finder).
              const dot = dialog.entry.isFolder ? -1 : value.lastIndexOf('.')
              e.target.setSelectionRange(0, dot > 0 ? dot : value.length)
            }}
            onChange={(e) => {
              setValue(e.target.value)
            }}
          />
        )}
        {dialog.kind === 'copy' && (
          <>
            <p className="text-[13px]">
              {dialog.move ? 'Move' : 'Copy'}{' '}
              {dialog.entries.length === 1 ? (
                <strong>{dialog.entries[0]?.name}</strong>
              ) : (
                `${dialog.entries.length} items`
              )}{' '}
              to:
            </p>
            <Select
              aria-label="Destination bucket"
              data-testid="s3-copy-bucket"
              value={destBucket}
              onChange={(e) => {
                setDestBucket(e.target.value)
              }}
            >
              {buckets.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Input
              mono
              aria-label="Destination folder"
              placeholder="Folder (empty = bucket root), e.g. backups/2024/"
              data-testid="s3-copy-prefix"
              value={destPrefix}
              onChange={(e) => {
                setDestPrefix(e.target.value)
              }}
            />
            <Checkbox
              label="Replace objects that already exist"
              checked={overwrite}
              onChange={(e) => {
                setOverwrite(e.target.checked)
              }}
            />
            <p className="text-xs text-faint">
              Objects are copied on the server — nothing is downloaded to this computer.
            </p>
          </>
        )}
        {(value || dialog.kind === 'copy') && problem && (
          <p className="text-xs text-danger">{problem}</p>
        )}
        {dialog.kind === 'delete' && (
          <>
            <p className="text-[13px]">
              {dialog.entries.length === 1 ? (
                <>
                  Delete <strong className="break-all">{dialog.entries[0]?.name}</strong>
                  {folders > 0 ? ' and everything inside it' : ''}?
                </>
              ) : (
                <>
                  Delete these {dialog.entries.length} items
                  {folders > 0 ? ', including everything inside the folders' : ''}?
                </>
              )}
            </p>
            {dialog.entries.length > 1 && (
              <ul className="max-h-32 overflow-auto rounded-md border border-line bg-subtle px-2.5 py-1.5 font-mono text-xs text-muted">
                {dialog.entries.slice(0, 50).map((e) => (
                  <li key={e.key} className="flex items-center gap-1.5 truncate py-0.5">
                    {e.isFolder ? (
                      <Folder size={12} className="shrink-0 text-accent" />
                    ) : (
                      <File size={12} className="shrink-0" />
                    )}
                    <span className="truncate">{e.name}</span>
                  </li>
                ))}
                {dialog.entries.length > 50 && (
                  <li className="py-0.5 text-faint">…and {dialog.entries.length - 50} more</li>
                )}
              </ul>
            )}
            <p className="text-xs text-danger">This cannot be undone.</p>
          </>
        )}
        {dialog.kind === 'link' && (
          <>
            <p className="text-[13px]">
              Anyone with the link can download <strong>{dialog.entry.name}</strong> until it
              expires. No account is needed.
            </p>
            <Select
              value={expires}
              onChange={(e) => {
                setExpires(e.target.value)
                setUrl(null)
                setCopied(false)
              }}
            >
              <option value="3600">Valid for 1 hour</option>
              <option value="86400">Valid for 1 day</option>
              <option value="604800">Valid for 7 days (maximum)</option>
            </Select>
            {url && (
              <div className="flex gap-2">
                <Input
                  mono
                  readOnly
                  value={url}
                  data-testid="s3-link-url"
                  className="min-w-0 flex-1"
                />
                <Button
                  icon={copied ? <Check size={14} /> : <Copy size={14} />}
                  onClick={() => {
                    void window.shellhouse.writeClipboard(url).then(() => {
                      setCopied(true)
                    })
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}
          </>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  )
}
