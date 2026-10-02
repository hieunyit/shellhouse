import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  ArrowLeftRight,
  ArrowUp,
  BarChart3,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cloud,
  CloudUpload,
  Copy,
  Download,
  FileDown,
  File,
  FileCode,
  FilePen,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Link,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import {
  parentPrefix,
  S3_EDIT_MAX_BYTES,
  S3_OBJECT_CHANGED,
  type S3Bucket,
  type S3Entry,
  type S3Listing,
  type S3Op
} from '../shared/ops'
import { joinLocal } from '@shared/local-files'
import type { TransferStatus } from '@shared/sftp'
import { Button, cx, IconButton, Notice } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { S3StatsDialog, type StatsTarget } from './S3Stats'
import { cleanError, formatSize } from './format'
import { TransferList } from '../../../renderer/src/components/files/TransferList'
import {
  BUCKET_SORT_KEYS,
  BUCKET_SORT_OPTIONS,
  S3BucketTable,
  type BucketSortKey,
  type BucketStats
} from './S3BucketTable'
import { SortMenu, usePersistentSort } from '../../../renderer/src/components/SortMenu'
import { S3BucketSwitcher } from './S3BucketSwitcher'
import { S3Dialog, type S3DialogState } from './S3Dialogs'
import {
  collator,
  columns,
  dateFormat,
  Empty,
  OBJECT_SORT_KEYS,
  OBJECT_SORT_OPTIONS,
  storageClassLabel,
  ToolButton,
  type SortKey
} from './parts'
import { useS3 } from './store'
import { s3Api } from './api'
import {
  fromBase64,
  isBinaryName,
  openEditorDoc,
  setModuleTabParams,
  setTabState,
  toBase64,
  useEditInApp
} from '../../registry/renderer-kit'
import type { ModuleTabProps } from '../../registry/renderer-types'
import type { S3BrowserParams } from '../shared/ipc'
import { S3SessionClient } from './s3-client'
import { eachLimit, runStatsJob } from './stats-job'
import { ExportBucketsDialog, SyncDialog, type SyncSource } from './S3Sync'

/** Số bucket đếm cùng lúc khi "Calculate all sizes". */
const PARALLEL_BUCKETS = 3

/**
 * Trình quản lý S3 của một tài khoản — một tab. Cấp gốc là bảng bucket (như AWS Console /
 * Cyberduck); vào bucket thì duyệt thư mục, đổi bucket bằng nút ▾ trên thanh đường dẫn.
 */
/** Tab `s3/browser` của registry → trình quản lý S3. */
export function S3Tab({ tabId, params }: ModuleTabProps<S3BrowserParams>): React.JSX.Element {
  return (
    <S3View
      tabId={tabId}
      accountId={params.accountId}
      initialLocation={
        params.bucket ? { bucket: params.bucket, prefix: params.prefix ?? '' } : undefined
      }
    />
  )
}

export function S3View({
  tabId,
  accountId,
  initialLocation
}: {
  tabId: string
  accountId: string
  initialLocation?: { bucket: string; prefix: string } | undefined
}): React.JSX.Element {
  const account = useS3((s) => s.accounts.find((a) => a.id === accountId))
  const clientRef = useRef<S3SessionClient | null>(null)
  const [ready, setReady] = useState(false)
  const [buckets, setBuckets] = useState<S3Bucket[] | null>(null)
  /** null = bảng bucket (cấp gốc). */
  const [bucket, setBucket] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [listing, setListing] = useState<S3Listing | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [transfers, setTransfers] = useState<TransferStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [dialog, setDialog] = useState<S3DialogState>(null)
  const [dragOver, setDragOver] = useState(false)
  const [stats, setStats] = useState<StatsTarget[] | null>(null)
  const [bucketStats, setBucketStats] = useState<Record<string, BucketStats>>({})
  const [calculating, setCalculating] = useState(false)
  const stopCalc = useRef(false)
  const [opening, setOpening] = useState<string | null>(null)
  /** Hộp thoại export / đồng bộ (ngoài S3Dialog). */
  const [tool, setTool] = useState<
    { kind: 'export' } | { kind: 'sync'; source: SyncSource } | null
  >(null)
  const accounts = useS3((s) => s.accounts)
  const [sort, setSort] = usePersistentSort<SortKey>('s3-objects', OBJECT_SORT_KEYS, {
    key: 'name',
    dir: 'asc'
  })
  const [bucketSort, setBucketSort] = usePersistentSort<BucketSortKey>(
    's3-buckets',
    BUCKET_SORT_KEYS,
    { key: 'name', dir: 'asc' }
  )
  const { menu, open: openMenu } = useContextMenu()
  const listRef = useRef<HTMLDivElement | null>(null)
  /** Mục "con trỏ" cho phím mũi tên và Shift+bấm. */
  const anchor = useRef<string | null>(null)
  /** Vị trí đang xem (để biết lần tải mới có phải chỗ khác không → xoá bộ lọc). */
  const here = useRef<string | null>(null)
  const firstLocation = useRef(initialLocation)
  const accountName = account?.name ?? 'S3'
  const editInAppPreferred = useEditInApp()

  const run = useCallback(async (op: S3Op): Promise<unknown> => {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    return client.request(op)
  }, [])

  const load = useCallback(
    async (b: string, p: string) => {
      setLoading(true)
      setError(null)
      try {
        const result = (await run({ op: 'list', bucket: b, prefix: p })) as S3Listing
        if (here.current !== `${b}/${p}`) setFilter('')
        here.current = `${b}/${p}`
        setListing(result)
        setBucket(b)
        setPrefix(p)
        setSelected(new Set())
        anchor.current = null
        setModuleTabParams(tabId, { accountId, bucket: b, prefix: p })
      } catch (e) {
        setError(cleanError(e))
      } finally {
        setLoading(false)
      }
    },
    [run, tabId, accountId]
  )

  const goRoot = useCallback(() => {
    here.current = null
    setBucket(null)
    setPrefix('')
    setListing(null)
    setSelected(new Set())
    setFilter('')
    setError(null)
    setModuleTabParams(tabId, { accountId })
  }, [tabId, accountId])

  // Mở phiên S3 (Session Host) cho tab; đóng khi tab đóng.
  useEffect(() => {
    let cancelled = false
    setTabState(tabId, 'connecting')
    void S3SessionClient.open(accountId, setTransfers).then(
      (client) => {
        if (cancelled) {
          client.close()
          return
        }
        clientRef.current = client
        setReady(true)
        setTabState(tabId, 'connected')
        void client.request({ op: 'listBuckets' }).then(
          (list) => {
            if (cancelled) return
            setBuckets(list as S3Bucket[])
            // Mở từ mục ghim / nhân bản tab / workspace: vào thẳng vị trí đó.
            const start = firstLocation.current
            if (start) void load(start.bucket, start.prefix)
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
        setTabState(tabId, 'disconnected')
      }
    )
    return () => {
      cancelled = true
      stopCalc.current = true
      clientRef.current?.close()
      clientRef.current = null
      setTabState(tabId, null)
    }
  }, [accountId, tabId, load])

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

  const refresh = (): void => {
    if (bucket === null) void loadBuckets()
    else void load(bucket, prefix)
  }

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

  // ---------- Thống kê bucket (tính khi cần, cập nhật dần trong bảng) ----------

  /** Tính dung lượng các bucket: vài bucket cùng lúc, mỗi bucket Session Host quét song song. */
  const calculate = async (names: readonly string[]): Promise<Record<string, BucketStats>> => {
    const results: Record<string, BucketStats> = {}
    stopCalc.current = false
    // Hàm (không phải đọc thẳng): TS không thu hẹp kiểu ref qua các lần await.
    const stopped = (): boolean => stopCalc.current
    setCalculating(true)
    const patch = (name: string, value: BucketStats): void => {
      results[name] = value
      setBucketStats((all) => ({ ...all, [name]: value }))
    }
    await eachLimit(names, PARALLEL_BUCKETS, async (name) => {
      if (stopped()) return
      patch(name, { state: 'running', objects: 0, bytes: 0 })
      try {
        const { result, stopped: wasStopped } = await runStatsJob(
          run,
          name,
          '',
          (p) => {
            patch(name, { state: 'running', objects: p.objects, bytes: p.bytes })
          },
          stopped
        )
        patch(
          name,
          result.error
            ? { state: 'error', objects: result.objects, bytes: result.bytes, error: result.error }
            : {
                state: wasStopped ? 'stopped' : 'done',
                objects: result.objects,
                bytes: result.bytes
              }
        )
      } catch (e) {
        patch(name, { state: 'error', objects: 0, bytes: 0, error: cleanError(e) })
      }
    })
    setCalculating(false)
    return results
  }

  // ---------- Ghim lên thanh bên ----------

  const isPinned = (b: string, p: string): boolean =>
    account?.pins.some((x) => x.bucket === b && x.prefix === p) ?? false
  const togglePin = (b: string, p: string): void => {
    void s3Api.pin(accountId, { bucket: b, prefix: p }, !isPinned(b, p)).catch((e: unknown) => {
      setError(cleanError(e))
    })
  }
  const pinItem = (b: string, p: string): MenuEntry => {
    const pinned = isPinned(b, p)
    return {
      id: 's3-pin',
      label: pinned ? 'Unpin from sidebar' : 'Pin to sidebar',
      icon: pinned ? <PinOff size={14} /> : <Pin size={14} />,
      onSelect: () => {
        togglePin(b, p)
      }
    }
  }
  const copyPathItem = (path: string): MenuEntry => ({
    id: 's3-copy-path',
    label: 'Copy S3 path',
    icon: <Copy size={14} />,
    hint: 's3://…',
    onSelect: () => void window.shellhouse.writeClipboard(`s3://${path}`)
  })

  // ---------- Thao tác trên object ----------

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

  /** Mở trong tab editor của app; Ctrl+S ghi thẳng lên bucket (kiểm tra ETag). */
  const editInApp = (entry: S3Entry): void => {
    if (bucket === null || entry.isFolder) return
    const b = bucket
    openEditorDoc({
      key: `s3:${accountId}:${b}/${entry.key}`,
      name: entry.name,
      path: `s3://${b}/${entry.key}`,
      where: accountName,
      read: async () => {
        const r = (await run({ op: 'readText', bucket: b, key: entry.key })) as {
          data: string
          etag: string | null
        }
        return { bytes: fromBase64(r.data), version: r.etag ? { etag: r.etag } : null }
      },
      write: async (bytes, expect) => {
        const etag = typeof expect?.['etag'] === 'string' ? expect['etag'] : undefined
        const r = (await run({
          op: 'writeText',
          bucket: b,
          key: entry.key,
          data: toBase64(bytes),
          ...(etag ? { expectEtag: etag } : {})
        })) as { etag: string | null }
        return r.etag ? { etag: r.etag } : null
      },
      isConflict: (e) => cleanError(e).includes(S3_OBJECT_CHANGED)
    })
  }

  /** Nút "Edit": văn bản vừa sức → editor của app; còn lại → editor trên máy. */
  const editBest = (entry: S3Entry): void => {
    if (editInAppPreferred && entry.size <= S3_EDIT_MAX_BYTES && !isBinaryName(entry.name))
      editInApp(entry)
    else void edit(entry)
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
    if (bucket === null) return []
    const one = list.length === 1 ? list[0] : undefined
    const items: MenuEntry[] = []
    if (one?.isFolder)
      items.push({
        id: 's3-open',
        label: 'Open',
        icon: <FolderOpen size={14} />,
        onSelect: () => void load(bucket, one.key)
      })
    if (one && !one.isFolder) {
      if (one.size <= S3_EDIT_MAX_BYTES)
        items.push({
          id: 's3-edit-app',
          label: 'Edit',
          icon: <FileCode size={14} />,
          onSelect: () => {
            editInApp(one)
          }
        })
      items.push({
        id: 's3-edit',
        label: 'Edit in local editor',
        icon: <FilePen size={14} />,
        onSelect: () => void edit(one)
      })
    }
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
    if (one?.isFolder) items.push(pinItem(bucket, one.key))
    if (one) items.push(copyPathItem(`${bucket}/${one.key}`))
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
    const onlyFolder = list.length === 1 && list[0]?.isFolder ? list[0] : undefined
    if (onlyFolder)
      items.push({
        id: 's3-sync',
        label: 'Sync to…',
        icon: <ArrowLeftRight size={14} />,
        onSelect: () => {
          setTool({ kind: 'sync', source: { bucket, prefix: onlyFolder.key } })
        }
      })
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

  const bucketMenu = (name: string): MenuEntry[] => [
    {
      id: 's3-bucket-open',
      label: 'Open',
      icon: <FolderOpen size={14} />,
      onSelect: () => void load(name, '')
    },
    {
      id: 's3-bucket-stats',
      label: 'Size & object count',
      icon: <BarChart3 size={14} />,
      disabled: calculating,
      onSelect: () => void calculate([name])
    },
    {
      id: 's3-bucket-sync',
      label: 'Sync to…',
      icon: <ArrowLeftRight size={14} />,
      onSelect: () => {
        setTool({ kind: 'sync', source: { bucket: name, prefix: '' } })
      }
    },
    'separator',
    pinItem(name, ''),
    {
      id: 's3-bucket-copy-name',
      label: 'Copy name',
      icon: <Copy size={14} />,
      onSelect: () => void window.shellhouse.writeClipboard(name)
    }
  ]

  // ---------- Danh sách object ----------

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

  const goUp = (): void => {
    if (bucket === null) return
    if (prefix === '') goRoot()
    else void load(bucket, parentPrefix(prefix))
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
    } else if (e.key === 'Backspace') {
      handled()
      goUp()
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
  const herePinned = bucket !== null && isPinned(bucket, prefix)
  const unknownSizes = (buckets ?? []).filter((b) => bucketStats[b.name]?.state !== 'done')

  return (
    <div
      className="@container relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-surface"
      data-testid="s3-view"
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
      {/* Thanh đường dẫn: tài khoản › bucket ▾ › thư mục */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton
          label={bucket === null ? 'Up' : 'Up (Backspace)'}
          disabled={bucket === null}
          onClick={goUp}
        >
          <ArrowUp size={15} />
        </IconButton>
        <nav
          className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px] whitespace-nowrap"
          aria-label="Path"
          data-testid="s3-path"
          title={location ? `s3://${location}` : undefined}
        >
          <button
            type="button"
            className={cx(
              'flex min-w-0 shrink-[2] items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-hover',
              bucket === null ? 'font-medium text-fg' : 'text-muted hover:text-fg'
            )}
            data-testid="s3-crumb-account"
            title={account ? account.endpoint || `AWS ${account.region || 'us-east-1'}` : undefined}
            onClick={goRoot}
          >
            <Cloud size={14} className="shrink-0" />
            {/* Trong bucket + khung hẹp: chỉ còn icon, nhường chỗ cho tên bucket / thư mục. */}
            <span className={cx('truncate', bucket !== null && 'hidden @2xl:inline')}>
              {accountName}
            </span>
          </button>
          {bucket === null ? (
            buckets && (
              <span className="shrink-0 pl-1 text-faint">
                · {buckets.length} bucket{buckets.length === 1 ? '' : 's'}
              </span>
            )
          ) : (
            <>
              <ChevronRight size={12} className="shrink-0 text-faint" />
              <S3BucketSwitcher
                buckets={buckets ?? []}
                current={bucket}
                onRoot={() => void load(bucket, '')}
                onPick={(b) => void load(b, '')}
                onAll={goRoot}
              />
              <span className="flex min-w-0 items-center gap-0.5 overflow-hidden">
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
              </span>
            </>
          )}
        </nav>
        <label className="flex h-7 w-28 shrink-0 items-center gap-1.5 rounded-md border border-line bg-subtle px-2 focus-within:border-accent @xl:w-44">
          <Search size={12} className="shrink-0 text-faint" />
          <input
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
            placeholder={bucket === null ? 'Filter buckets' : 'Filter'}
            aria-label={bucket === null ? 'Filter buckets' : 'Filter this folder'}
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
        {bucket === null ? (
          <SortMenu
            options={
              buckets?.some((b) => b.region)
                ? BUCKET_SORT_OPTIONS
                : BUCKET_SORT_OPTIONS.filter((o) => o.key !== 'region')
            }
            sort={bucketSort}
            onChange={setBucketSort}
            testId="s3-sort"
          />
        ) : (
          <SortMenu options={OBJECT_SORT_OPTIONS} sort={sort} onChange={setSort} testId="s3-sort" />
        )}
        {bucket !== null && (
          <IconButton
            label={herePinned ? 'Unpin from sidebar' : 'Pin this location to the sidebar'}
            active={herePinned}
            data-testid="s3-pin-here"
            onClick={() => {
              togglePin(bucket, prefix)
            }}
          >
            <Pin size={14} className={herePinned ? 'text-accent' : ''} />
          </IconButton>
        )}
        <IconButton label="Refresh" disabled={!ready} onClick={refresh}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>

      {/* Thanh công cụ */}
      <div
        className="flex h-10 shrink-0 items-center gap-0.5 overflow-hidden border-b border-line px-2"
        role="toolbar"
        aria-label="Actions"
      >
        {bucket === null ? (
          <>
            <ToolButton
              icon={<Plus size={14} />}
              label="New bucket"
              labelAt="md"
              primary
              testId="s3-new-bucket"
              disabled={!ready}
              onClick={() => {
                setDialog({ kind: 'bucket' })
              }}
            />
            {calculating ? (
              <ToolButton
                icon={<Square size={13} />}
                label="Stop counting"
                labelAt="md"
                testId="s3-calc-stop"
                onClick={() => {
                  stopCalc.current = true
                }}
              />
            ) : (
              <ToolButton
                icon={<BarChart3 size={14} />}
                label="Calculate all sizes"
                labelAt="md"
                testId="s3-calc-all"
                disabled={unknownSizes.length === 0}
                onClick={() => void calculate(unknownSizes.map((b) => b.name))}
              />
            )}
            <ToolButton
              icon={<FileDown size={14} />}
              label="Export list"
              labelAt="xl"
              testId="s3-export"
              disabled={!buckets?.length}
              onClick={() => {
                setTool({ kind: 'export' })
              }}
            />
            <span className="flex-1" />
            {selectedBucket && (
              <>
                <ToolButton
                  icon={<ArrowLeftRight size={14} />}
                  label="Sync to…"
                  labelAt="xl"
                  testId="s3-sync-bucket"
                  onClick={() => {
                    setTool({ kind: 'sync', source: { bucket: selectedBucket, prefix: '' } })
                  }}
                />
                <ToolButton
                  icon={<FolderOpen size={14} />}
                  label="Open"
                  labelAt="xl"
                  onClick={() => void load(selectedBucket, '')}
                />
                <ToolButton
                  icon={isPinned(selectedBucket, '') ? <PinOff size={14} /> : <Pin size={14} />}
                  label={isPinned(selectedBucket, '') ? 'Unpin' : 'Pin to sidebar'}
                  labelAt="3xl"
                  testId="s3-pin-bucket"
                  onClick={() => {
                    togglePin(selectedBucket, '')
                  }}
                />
              </>
            )}
          </>
        ) : (
          <>
            <ToolButton
              icon={<Upload size={14} />}
              label="Upload"
              labelAt="md"
              primary
              testId="s3-upload"
              onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
            />
            <ToolButton
              icon={<FolderUp size={14} />}
              label="Upload folder"
              labelAt="5xl"
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
              onClick={() => {
                setDialog({ kind: 'mkdir' })
              }}
            />
            <ToolButton
              icon={<ArrowLeftRight size={14} />}
              label="Sync…"
              labelAt="5xl"
              testId="s3-sync-here"
              onClick={() => {
                // Một thư mục đang chọn → đồng bộ thư mục đó; không thì cả chỗ đang xem.
                const folder = one?.isFolder ? one.key : prefix
                setTool({ kind: 'sync', source: { bucket, prefix: folder } })
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
                    onClick={() => {
                      editBest(one)
                    }}
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

      {/* Nội dung: bảng bucket (cấp gốc) hoặc thư mục trong bucket */}
      {bucket === null ? (
        buckets === null ? (
          !error && (
            <p className="flex flex-1 items-start gap-2 p-4 text-xs text-faint">
              <RefreshCw size={12} className="animate-spin" /> Connecting…
            </p>
          )
        ) : buckets.length === 0 ? (
          <Empty
            icon={<Cloud size={20} />}
            title="No buckets yet"
            text="Create a bucket to start storing files."
            action={
              <Button
                size="sm"
                icon={<Plus size={13} />}
                disabled={!ready}
                onClick={() => {
                  setDialog({ kind: 'bucket' })
                }}
              >
                New bucket
              </Button>
            }
          />
        ) : (
          <S3BucketTable
            buckets={buckets}
            filter={filter}
            stats={bucketStats}
            sort={bucketSort}
            onSort={setBucketSort}
            selected={selectedBucket}
            isPinned={(b) => isPinned(b, '')}
            onSelect={setSelectedBucket}
            onOpen={(b) => void load(b, '')}
            onCalculate={(b) => void calculate([b])}
            onContextMenu={(e, b) => {
              openMenu(e, bucketMenu(b))
            }}
          />
        )
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
              'sticky top-0 z-10 grid h-8 items-center gap-3 border-b border-line bg-surface px-3 text-xs font-medium text-faint',
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
                filter ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<X size={13} />}
                    onClick={() => {
                      setFilter('')
                    }}
                  >
                    Clear filter
                  </Button>
                ) : (
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
                  {entry.isFolder && isPinned(bucket, entry.key) && (
                    <Pin size={11} className="shrink-0 text-accent" aria-label="Pinned" />
                  )}
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

      {/* Thanh trạng thái */}
      {bucket === null
        ? buckets &&
          buckets.length > 0 && (
            <div
              className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-3 text-xs whitespace-nowrap text-faint"
              data-testid="s3-status"
            >
              <span className="min-w-0 flex-1 truncate">
                {buckets.length} bucket{buckets.length === 1 ? '' : 's'}
                {selectedBucket ? ' · 1 selected' : ''}
              </span>
              <span className="hidden @xl:inline">Sizes are counted on demand</span>
            </div>
          )
        : listing && (
            <div
              className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-3 text-xs whitespace-nowrap text-faint"
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

      <TransferList
        transfers={transfers}
        testId="s3-transfers"
        rowTestId="s3-transfer"
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
      {tool?.kind === 'export' && buckets && (
        <ExportBucketsDialog
          account={accountName}
          buckets={buckets}
          stats={bucketStats}
          run={run}
          calculate={calculate}
          stop={() => {
            stopCalc.current = true
          }}
          onClose={() => {
            setTool(null)
          }}
        />
      )}
      {tool?.kind === 'sync' && (
        <SyncDialog
          accountId={accountId}
          accounts={accounts}
          buckets={buckets ?? []}
          source={tool.source}
          run={run}
          onClose={() => {
            setTool(null)
          }}
          onFinished={(dest) => {
            if (dest !== accountId) return
            void loadBuckets()
            if (bucket !== null) void load(bucket, prefix)
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
