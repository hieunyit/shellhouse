import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  ArrowUp,
  BarChart3,
  ChevronRight,
  Cloud,
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
  const { menu, open: openMenu } = useContextMenu()

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
    return q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all
  }, [listing, filter])
  const chosen = entries.filter((e) => selected.has(e.key))
  const crumbs = prefix.split('/').filter(Boolean)
  const fileCount = listing?.entries.filter((e) => !e.isFolder).length ?? 0
  const folderCount = (listing?.entries.length ?? 0) - fileCount
  const filesSize = listing?.entries.reduce((n, e) => n + e.size, 0) ?? 0

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(false)
    const paths = [...event.dataTransfer.files]
      .map((f) => window.shellhouse.pathForFile(f))
      .filter(Boolean)
    void upload(paths)
  }

  return (
    <div className="flex h-full min-h-0 bg-surface" data-testid="s3-view">
      {/* Buckets */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-subtle/40">
        <div className="flex h-10 items-center gap-2 border-b border-line px-3 text-xs">
          <Cloud size={14} className="text-muted" />
          <span className="min-w-0 flex-1 truncate font-medium text-fg" title={account?.endpoint}>
            {account?.name ?? 'S3'}
          </span>
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
          <IconButton label="Refresh buckets" size="sm" onClick={() => void loadBuckets()}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1.5" role="listbox" aria-label="Buckets">
          {buckets === null && !error && <p className="p-2 text-xs text-faint">Connecting…</p>}
          {buckets?.length === 0 && <p className="p-2 text-xs text-faint">No buckets.</p>}
          {buckets?.map((b) => (
            <button
              key={b.name}
              type="button"
              role="option"
              aria-selected={bucket === b.name}
              data-testid="s3-bucket"
              data-name={b.name}
              className={cx(
                'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
                bucket === b.name
                  ? 'bg-accent-soft text-fg'
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
              <Database size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Objects */}
      <section
        className={cx('flex min-w-0 flex-1 flex-col', dragOver && 'ring-2 ring-accent ring-inset')}
        onDragOver={(e) => {
          if (bucket !== null && e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragLeave={() => {
          setDragOver(false)
        }}
        onDrop={onDrop}
      >
        <div className="flex h-10 items-center gap-1 border-b border-line px-2">
          <IconButton
            label="Parent folder"
            disabled={bucket === null || prefix === ''}
            onClick={() => bucket !== null && void load(bucket, parentPrefix(prefix))}
          >
            <ArrowUp size={15} />
          </IconButton>
          <nav
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[13px]"
            aria-label="Path"
            data-testid="s3-path"
          >
            {bucket === null ? (
              <span className="px-1 text-faint">Choose a bucket</span>
            ) : (
              <>
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 font-medium text-fg hover:bg-hover"
                  onClick={() => void load(bucket, '')}
                >
                  {bucket}
                </button>
                {crumbs.map((c, i) => (
                  <span key={i} className="flex min-w-0 items-center gap-0.5">
                    <ChevronRight size={12} className="shrink-0 text-faint" />
                    <button
                      type="button"
                      className="min-w-0 truncate rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg"
                      onClick={() => void load(bucket, `${crumbs.slice(0, i + 1).join('/')}/`)}
                    >
                      {c}
                    </button>
                  </span>
                ))}
              </>
            )}
          </nav>
          <div className="flex h-7 w-44 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
            <Search size={12} className="text-faint" />
            <input
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
              placeholder="Filter this folder"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
              }}
            />
          </div>
          <IconButton
            label="Refresh"
            disabled={bucket === null}
            onClick={() => bucket !== null && void load(bucket, prefix)}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </IconButton>
        </div>
        <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={<Upload size={13} />}
            data-testid="s3-upload"
            disabled={bucket === null}
            onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
          >
            Upload
          </Button>
          <IconButton
            label="Upload a folder"
            size="sm"
            className="size-7"
            disabled={bucket === null}
            onClick={() =>
              void window.shellhouse
                .pickFolder('Choose a folder to upload', 'downloads')
                .then((dir) => upload(dir ? [dir] : []))
            }
          >
            <FolderUp size={14} />
          </IconButton>
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderPlus size={13} />}
            data-testid="s3-mkdir"
            disabled={bucket === null}
            onClick={() => {
              setDialog({ kind: 'mkdir' })
            }}
          >
            New folder
          </Button>
          <div className="flex-1" />
          {chosen.length > 0 && (
            <>
              {chosen.length === 1 && chosen[0] && !chosen[0].isFolder && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<FilePen size={13} />}
                  data-testid="s3-edit"
                  disabled={opening !== null}
                  onClick={() => {
                    if (chosen[0]) void edit(chosen[0])
                  }}
                >
                  {opening ? 'Opening…' : 'Edit'}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                icon={<Download size={13} />}
                data-testid="s3-download"
                onClick={() => void download(chosen)}
              >
                Download{chosen.length > 1 ? ` ${chosen.length}` : ''}
              </Button>
              {chosen.length === 1 && chosen[0] && !chosen[0].isFolder && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Link size={13} />}
                  data-testid="s3-link"
                  onClick={() => {
                    if (chosen[0]) setDialog({ kind: 'link', entry: chosen[0] })
                  }}
                >
                  Share link
                </Button>
              )}
              {chosen.length === 1 && (
                <IconButton
                  label="Rename (F2)"
                  size="sm"
                  className="size-7"
                  data-testid="s3-rename"
                  onClick={() => {
                    if (chosen[0]) setDialog({ kind: 'rename', entry: chosen[0] })
                  }}
                >
                  <Pencil size={14} />
                </IconButton>
              )}
              <IconButton
                label="Copy to…"
                size="sm"
                className="size-7"
                data-testid="s3-copy"
                onClick={() => {
                  setDialog({ kind: 'copy', entries: chosen, move: false })
                }}
              >
                <Copy size={14} />
              </IconButton>
              <IconButton
                label="Move to…"
                size="sm"
                className="size-7"
                data-testid="s3-move"
                onClick={() => {
                  setDialog({ kind: 'copy', entries: chosen, move: true })
                }}
              >
                <FolderInput size={14} />
              </IconButton>
              <Button
                size="sm"
                variant="danger-ghost"
                icon={<Trash2 size={13} />}
                data-testid="s3-delete"
                onClick={() => {
                  setDialog({ kind: 'delete', entries: chosen })
                }}
              >
                Delete
              </Button>
            </>
          )}
        </div>

        {error && (
          <div className="border-b border-line p-2">
            <Notice tone="danger" testId="s3-error">
              {error}
            </Notice>
          </div>
        )}

        <div
          className="min-h-0 flex-1 overflow-auto outline-none"
          role="listbox"
          aria-label="Objects"
          aria-multiselectable
          tabIndex={0}
          onKeyDown={(e) => {
            const only = chosen.length === 1 ? chosen[0] : undefined
            if (e.key === 'F2' && only) {
              e.preventDefault()
              setDialog({ kind: 'rename', entry: only })
            } else if (e.key === 'Delete' && chosen.length > 0) {
              e.preventDefault()
              setDialog({ kind: 'delete', entries: chosen })
            } else if (e.key === 'Enter' && only?.isFolder && bucket !== null) {
              e.preventDefault()
              void load(bucket, only.key)
            } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              setSelected(new Set(entries.map((x) => x.key)))
            }
          }}
        >
          {bucket !== null && (
            <div className="sticky top-0 z-10 grid grid-cols-[1fr_6rem_10rem_7rem] gap-2 border-b border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-faint">
              <span>Name</span>
              <span className="text-right">Size</span>
              <span>Modified</span>
              <span>Class</span>
            </div>
          )}
          {listing && entries.length === 0 && (
            <p className="px-4 py-10 text-center text-xs text-faint">
              {filter
                ? 'Nothing matches the filter.'
                : 'This folder is empty. Drop files here to upload.'}
            </p>
          )}
          {entries.map((entry) => (
            <div
              key={entry.key}
              role="option"
              aria-selected={selected.has(entry.key)}
              data-testid="s3-entry"
              data-name={entry.name}
              className={cx(
                'grid h-8 cursor-default grid-cols-[1fr_6rem_10rem_7rem] items-center gap-2 px-3 text-[13px]',
                selected.has(entry.key) ? 'bg-accent-soft' : 'hover:bg-hover'
              )}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  const next = new Set(selected)
                  if (next.has(entry.key)) next.delete(entry.key)
                  else next.add(entry.key)
                  setSelected(next)
                } else setSelected(new Set([entry.key]))
              }}
              onDoubleClick={() => {
                if (entry.isFolder && bucket !== null) void load(bucket, entry.key)
                else void download([entry])
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                // Chuột phải vào mục chưa chọn → chỉ chọn mục đó (như trình quản lý file).
                const list = selected.has(entry.key) ? chosen : [entry]
                if (!selected.has(entry.key)) setSelected(new Set([entry.key]))
                openMenu(e, entryMenu(list))
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                {entry.isFolder ? (
                  <Folder size={15} className="shrink-0 text-accent" />
                ) : (
                  <File size={15} className="shrink-0 text-muted" />
                )}
                <span className="truncate">{entry.name}</span>
              </span>
              <span className="text-right text-xs text-faint tabular-nums">
                {entry.isFolder ? '' : formatSize(entry.size)}
              </span>
              <span className="truncate text-xs text-faint">
                {entry.modified ? new Date(entry.modified).toLocaleString() : ''}
              </span>
              <span className="truncate text-xs text-faint">{entry.storageClass ?? ''}</span>
            </div>
          ))}
          {listing?.truncated && (
            <p className="p-3 text-xs text-faint">Only the first 5000 items are shown.</p>
          )}
        </div>

        {listing && (
          <div
            className="flex h-7 shrink-0 items-center gap-3 border-t border-line px-3 text-[11px] text-faint"
            data-testid="s3-status"
          >
            <span>
              {folderCount} folder{folderCount === 1 ? '' : 's'}, {fileCount} file
              {fileCount === 1 ? '' : 's'} · {formatSize(filesSize)}
              {chosen.length > 0 ? ` · ${chosen.length} selected` : ''}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              className="rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg"
              data-testid="s3-folder-stats"
              onClick={() => {
                folderStats([])
              }}
            >
              Total size incl. subfolders…
            </button>
          </div>
        )}

        <Transfers
          transfers={transfers}
          onCancel={(id) => void act({ op: 'cancel', transferId: id })}
          onClear={() => void act({ op: 'clearDone' })}
        />
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

function Transfers({
  transfers,
  onCancel,
  onClear
}: {
  transfers: TransferStatus[]
  onCancel: (id: string) => void
  onClear: () => void
}): React.JSX.Element | null {
  if (transfers.length === 0) return null
  return (
    <div className="max-h-44 overflow-auto border-t border-line p-2.5" data-testid="s3-transfers">
      <div className="mb-1.5 flex items-center text-xs font-medium text-muted">
        <span className="flex-1">Transfers</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-fg"
          onClick={onClear}
        >
          Clear finished
        </button>
      </div>
      {transfers.map((t) => {
        const pct =
          t.size > 0 ? Math.floor((t.transferred / t.size) * 100) : t.state === 'done' ? 100 : 0
        const name = t.remotePath.split('/').at(-1) ?? t.remotePath
        return (
          <div key={t.id} className="mb-2 text-xs" data-testid="s3-transfer" data-state={t.state}>
            <div className="flex items-center gap-1.5">
              {t.direction === 'upload' ? (
                <Upload size={12} className="text-muted" />
              ) : (
                <Download size={12} className="text-muted" />
              )}
              <span className="min-w-0 flex-1 truncate" title={t.remotePath}>
                {name}
              </span>
              <span className="text-faint">
                {t.state === 'running' && `${pct}% · ${formatSize(t.bytesPerSecond)}/s`}
                {t.state === 'queued' && 'Queued'}
                {t.state === 'done' && 'Done'}
                {t.state === 'cancelled' && 'Cancelled'}
                {t.state === 'error' && 'Failed'}
              </span>
              {(t.state === 'running' || t.state === 'queued') && (
                <IconButton
                  label="Cancel"
                  size="sm"
                  onClick={() => {
                    onCancel(t.id)
                  }}
                >
                  <X size={12} />
                </IconButton>
              )}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-subtle">
              <div
                className={cx(
                  'h-1 rounded-full transition-[width]',
                  t.state === 'error'
                    ? 'bg-danger'
                    : t.state === 'done'
                      ? 'bg-success'
                      : 'bg-accent'
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            {t.error && <p className="mt-1 text-danger">{t.error}</p>}
          </div>
        )
      })}
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
          <p className="text-[13px]">
            Delete{' '}
            {dialog.entries.length === 1 ? (
              <strong>{dialog.entries[0]?.name}</strong>
            ) : (
              `${dialog.entries.length} items`
            )}
            {folders > 0 ? ' and EVERYTHING inside the selected folders' : ''}? This cannot be
            undone.
          </p>
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
                <Button onClick={() => void window.shellhouse.writeClipboard(url)}>Copy</Button>
              </div>
            )}
          </>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  )
}
