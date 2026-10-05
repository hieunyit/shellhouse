import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Database,
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
  FileCode,
  FilePen,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Globe,
  History,
  Info,
  Link,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Trash2,
  Upload,
  X,
  TerminalSquare
} from 'lucide-react'
import {
  parentPrefix,
  S3_EDIT_MAX_BYTES,
  S3_LIST_PAGE,
  S3_OBJECT_CHANGED,
  type S3Bucket,
  type S3BulkJob,
  type S3Entry,
  type S3JobProgress,
  type S3Listing,
  type S3Op,
  type S3UploadConflict
} from '../shared/ops'
import type { TransferStatus } from '@shared/sftp'
import { Button, cx, IconButton, Notice } from '../../../renderer/src/components/ui'
import { useContextMenu, type MenuEntry } from '../../../renderer/src/components/ContextMenu'
import { S3StatsDialog, type StatsTarget } from './S3Stats'
import { cleanError, formatSize } from './format'
import { TransferList } from '../../../renderer/src/components/files/TransferList'
import {
  BUCKET_SORT_KEYS,
  bucketSortOptions,
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
  Empty,
  OBJECT_SORT_KEYS,
  objectSortOptions,
  ToolButton,
  type SortKey
} from './parts'
import { useS3 } from './store'
import { s3Api } from './api'
import {
  choose,
  formatNumber,
  fromBase64,
  isBinaryName,
  openEditorDoc,
  setModuleTabParams,
  setTabState,
  t,
  tn,
  toBase64,
  useEditInApp,
  activateTab,
  showCommands,
  usePublishTransfers,
  useReportEnvironment
} from '../../registry/renderer-kit'
import { objectCommands } from '../shared/commands'
import { EnvLabel } from '../../../renderer/src/ds'
import { useAccountEnvironment } from './S3Section'
import { objectHttpUrl, type S3Version } from '../shared/manage'
import { S3DetailsPanel, type DetailsTarget } from './S3Details'
import { S3VersionList } from './S3VersionList'
import { S3BucketSettingsDialog, type BucketSettingsTab } from './S3BucketSettings'
import type { ModuleTabProps } from '../../registry/renderer-types'
import type { S3BrowserParams } from '../shared/ipc'
import { S3SessionClient } from './s3-client'
import { eachLimit, runStatsJob } from './stats-job'
import { ExportBucketsDialog, SyncDialog, type SyncSource } from './S3Sync'
import { JobsPanel, jobErrorText, useBulkJobs, type RunningJob } from './S3Jobs'
import { ObjectRow, type RowHandlers } from './ObjectRow'

/** Số bucket đếm cùng lúc khi "Calculate all sizes". */
const PARALLEL_BUCKETS = 3
/**
 * Tải lên xong → làm mới thư mục đang xem, gộp lại: còn lượt đang chạy thì tối đa mỗi
 * RELOAD_BUSY_MS một lần, hết hàng đợi thì sau RELOAD_IDLE_MS (không phải 5 000 lần cho 5 000 file).
 */
const RELOAD_BUSY_MS = 2000
const RELOAD_IDLE_MS = 250
/** Thanh đường dẫn: sâu hơn chừng này cấp thì gộp các cấp giữa vào nút "…". */
const MAX_CRUMBS = 4
/** Nhớ bảng chi tiết đang mở / đóng giữa các tab. */
const DETAILS_KEY = 'shellhouse.s3.details'

function detailsPreferred(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) === '1'
  } catch {
    return false
  }
}

/** Lượt tải lên vào đúng chỗ đang xem (s3://bucket/prefix…) — chỗ khác không cần làm mới. */
function uploadsHere(tr: TransferStatus, bucket: string, prefix: string): boolean {
  return (
    tr.direction === 'upload' && !tr.edit && tr.remotePath.startsWith(`s3://${bucket}/${prefix}`)
  )
}

/** Gộp phần "Load more" vào danh sách đang có (bỏ trùng theo key). */
function mergeListing(base: S3Listing, more: S3Listing): S3Listing {
  const seen = new Set(base.entries.map((e) => e.key))
  return {
    ...more,
    entries: [...base.entries, ...more.entries.filter((e) => !seen.has(e.key))]
  }
}

/** Một cấp thư mục trên thanh đường dẫn. */
function Crumb({
  label,
  last,
  onOpen
}: {
  label: string
  last: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 shrink items-center gap-0.5">
      <ChevronRight size={12} className="shrink-0 text-faint" />
      <button
        type="button"
        data-testid="s3-crumb"
        className={cx(
          'min-w-0 truncate rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg',
          last ? 'text-fg' : 'text-muted'
        )}
        title={label}
        onClick={onOpen}
      >
        {label}
      </button>
    </span>
  )
}

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
  // Môi trường của tài khoản: nhãn trên header + vạch trên cùng (Settings › Environments).
  const env = useAccountEnvironment(accountId)
  useReportEnvironment(tabId, env?.id)
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
  /** Mục neo cho Shift+bấm / Shift+mũi tên (đầu dải chọn). */
  const anchor = useRef<string | null>(null)
  /** Mục con trỏ bàn phím (cuối dải chọn khi Shift+mũi tên). */
  const cursor = useRef<string | null>(null)
  /** Vị trí đang xem (để biết lần tải mới có phải chỗ khác không → xoá bộ lọc). */
  const here = useRef<string | null>(null)
  const firstLocation = useRef(initialLocation)
  const accountName = account?.name ?? 'S3'
  const editInAppPreferred = useEditInApp()
  /** Chế độ "Show versions" (mọi phiên bản + delete marker). */
  const [versionsMode, setVersionsMode] = useState(false)
  /** Bảng chi tiết bên phải. */
  const [detailsOpen, setDetailsOpen] = useState(detailsPreferred)
  /** Đang xem một phiên bản cụ thể trong bảng chi tiết (không có = object đang chọn). */
  const [detailsVersion, setDetailsVersion] = useState<DetailsTarget | null>(null)
  /** Tăng lên → danh sách phiên bản / bảng chi tiết tải lại. */
  const [reloadKey, setReloadKey] = useState(0)
  const [settings, setSettings] = useState<{ bucket: string; tab: BucketSettingsTab } | null>(null)

  const run = useCallback(async (op: S3Op): Promise<unknown> => {
    const client = clientRef.current
    if (!client) throw new Error(t('Not connected'))
    return client.request(op)
  }, [])

  const toggleDetails = (open = !detailsOpen): void => {
    setDetailsOpen(open)
    try {
      localStorage.setItem(DETAILS_KEY, open ? '1' : '0')
    } catch {
      // Không có localStorage (chế độ riêng tư…) — chỉ nhớ trong tab.
    }
  }

  /** Lần liệt kê mới nhất — kết quả của lần cũ hơn (bấm nhanh qua nhiều thư mục) bị bỏ. */
  const loadSeq = useRef(0)
  /**
   * Liệt kê một thư mục. `refresh`: làm mới chỗ đang xem (sau tải lên / xoá…) — giữ mục đang chọn
   * và không báo lỗi đè lên lỗi khác.
   */
  const load = useCallback(
    async (b: string, p: string, options: { refresh?: boolean } = {}) => {
      const seq = ++loadSeq.current
      setLoading(true)
      if (!options.refresh) setError(null)
      try {
        const result = (await run({ op: 'list', bucket: b, prefix: p })) as S3Listing
        if (seq !== loadSeq.current) return
        const same = here.current === `${b}/${p}`
        if (!same) {
          setFilter('')
          setDetailsVersion(null)
        }
        here.current = `${b}/${p}`
        setListing(result)
        setBucket(b)
        setPrefix(p)
        if (same && options.refresh) {
          // Giữ mục đang chọn còn tồn tại.
          const keys = new Set(result.entries.map((e) => e.key))
          setSelected((cur) => {
            const next = new Set([...cur].filter((k) => keys.has(k)))
            return next.size === cur.size ? cur : next
          })
        } else {
          setSelected(new Set())
          anchor.current = null
        }
        setModuleTabParams(tabId, { accountId, bucket: b, prefix: p })
      } catch (e) {
        if (seq === loadSeq.current) setError(cleanError(e))
      } finally {
        if (seq === loadSeq.current) setLoading(false)
      }
    },
    [run, tabId, accountId]
  )

  /** "Load more": phần tiếp theo của thư mục lớn (S3 trả theo trang). */
  const [loadingMore, setLoadingMore] = useState(false)
  const loadMore = async (): Promise<void> => {
    if (!listing?.nextToken) return
    const seq = loadSeq.current
    const base = listing
    setLoadingMore(true)
    try {
      const more = (await run({
        op: 'list',
        bucket: base.bucket,
        prefix: base.prefix,
        token: base.nextToken
      })) as S3Listing
      // Đã chuyển thư mục / làm mới trong lúc chờ → bỏ.
      if (seq === loadSeq.current)
        setListing((cur) => (cur === base ? mergeListing(base, more) : cur))
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const goRoot = useCallback(() => {
    loadSeq.current++
    here.current = null
    setBucket(null)
    setPrefix('')
    setListing(null)
    setSelected(new Set())
    setFilter('')
    setError(null)
    setVersionsMode(false)
    setDetailsVersion(null)
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
            // Explorer liệt kê bucket dưới tài khoản (cùng danh sách, không đọc lại).
            useS3.getState().setBuckets(
              accountId,
              (list as S3Bucket[]).map((b) => b.name)
            )
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
      useS3.getState().setBuckets(
        accountId,
        list.map((b) => b.name)
      )
    } catch (e) {
      setBuckets([])
      setError(cleanError(e))
    }
  }, [run, accountId])

  const refresh = (): void => {
    if (bucket === null) void loadBuckets()
    else {
      void load(bucket, prefix)
      setReloadKey((k) => k + 1)
    }
  }

  // Tải lên vào chỗ đang xem xong → làm mới, gộp lại (xem RELOAD_BUSY_MS); bỏ qua lượt của tính
  // năng sửa file (nội dung đổi, danh sách không đổi gì đáng kể).
  const { doneHere, activeHere } = useMemo(() => {
    let done = 0
    let active = 0
    if (bucket !== null)
      for (const tr of transfers)
        if (uploadsHere(tr, bucket, prefix)) {
          if (tr.state === 'done') done++
          else if (tr.state === 'running' || tr.state === 'queued') active++
        }
    return { doneHere: done, activeHere: active }
  }, [transfers, bucket, prefix])
  const lastDone = useRef(0)
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshHere = useRef<() => void>(() => undefined)
  useEffect(() => {
    refreshHere.current = () => {
      if (bucket !== null) void load(bucket, prefix, { refresh: true })
    }
  })
  useEffect(() => {
    const grew = doneHere > lastDone.current
    lastDone.current = doneHere
    if (!grew) return
    const delay = activeHere > 0 ? RELOAD_BUSY_MS : RELOAD_IDLE_MS
    // Hết hàng đợi: làm mới sớm (không chờ hết nhịp "đang bận").
    if (reloadTimer.current && activeHere > 0) return
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null
      refreshHere.current()
    }, delay)
  }, [doneHere, activeHere])
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
    },
    []
  )

  // Xoá / copy / move thư mục chạy nền: xong → làm mới, lỗi → thanh lỗi.
  const onJobFinished = (job: RunningJob, p: S3JobProgress): void => {
    const problem = jobErrorText(job.label, p)
    if (problem) setError(problem)
    if (p.done > 0 || p.phase === 'done') refreshHere.current()
  }
  const bulk = useBulkJobs(run, onJobFinished)
  const startJob = (job: S3BulkJob, label: string, verb: string): void => {
    void bulk.start(job, label, verb).catch((e: unknown) => {
      setError(cleanError(e))
    })
  }

  const act = async (op: S3Op): Promise<unknown> => {
    try {
      return await run(op)
    } catch (e) {
      setError(cleanError(e))
      return undefined
    }
  }
  // Trung tâm Transfers của app thấy lượt tải lên / tải xuống của tab này.
  usePublishTransfers({
    id: `s3:${tabId}`,
    label: account?.name ?? 'S3',
    kind: 's3',
    transfers,
    cancel: (id) => {
      clientRef.current?.cancel(id)
    },
    clear: () => void act({ op: 'clearDone' }),
    reveal: () => {
      activateTab(tabId)
    }
  })

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
      label: pinned ? t('Unpin from sidebar') : t('Pin to sidebar'),
      icon: pinned ? <PinOff size={14} /> : <Pin size={14} />,
      onSelect: () => {
        togglePin(b, p)
      }
    }
  }
  const copyPathItem = (path: string): MenuEntry => ({
    id: 's3-copy-path',
    label: t('Copy S3 URI'),
    icon: <Copy size={14} />,
    hint: 's3://…',
    onSelect: () => void window.shellhouse.writeClipboard(`s3://${path}`)
  })
  const bucketRegion = (name: string): string | null =>
    buckets?.find((b) => b.name === name)?.region ?? null
  const copyUrlItem = (b: string, key: string): MenuEntry | null =>
    account
      ? {
          id: 's3-copy-url',
          label: t('Copy URL'),
          icon: <Globe size={14} />,
          hint: 'https://…',
          onSelect: () =>
            void window.shellhouse.writeClipboard(objectHttpUrl(account, b, key, bucketRegion(b)))
        }
      : null

  // ---------- Thao tác trên object ----------

  /**
   * Tải lên: kiểm tra trước file nào sẽ đè lên object đã có → hỏi Replace / Skip (kèm "cho mọi mục
   * còn lại"); không trùng thì tải lên luôn.
   */
  const upload = async (paths: string[]): Promise<void> => {
    if (bucket === null || paths.length === 0) return
    const b = bucket
    const p = prefix
    const checks = (await act({ op: 'uploadCheck', bucket: b, prefix: p, localPaths: paths })) as
      S3UploadConflict[] | undefined
    if (!checks) return
    const conflicting = checks.filter((c) => c.existing > 0).length
    let remembered: 'replace' | 'skip' | null = null
    let asked = 0
    for (const c of checks) {
      let overwrite = true
      if (c.existing > 0) {
        asked++
        let answer = remembered
        if (!answer) {
          const many = conflicting - asked > 0
          const picked = await choose({
            title: c.isFolder ? t('Some files already exist') : t('Replace the existing object?'),
            message: c.isFolder
              ? t('{existing} of {files} files in “{name}” already exist in {where}.', {
                  existing: formatNumber(c.existing),
                  files: formatNumber(c.files),
                  name: c.name,
                  where: `${b}/${p}`
                })
              : t('“{name}” already exists in {where}.', { name: c.name, where: `${b}/${p}` }),
            testId: 's3-upload-conflict',
            width: 'max-w-md',
            choices: [
              { value: 'cancel', label: t('Cancel'), testId: 's3-upload-cancel' },
              ...(many
                ? [
                    { value: 'skip-all', label: t('Skip all'), testId: 's3-upload-skip-all' },
                    {
                      value: 'replace-all',
                      label: t('Replace all'),
                      variant: 'danger' as const,
                      testId: 's3-upload-replace-all'
                    }
                  ]
                : []),
              {
                value: 'skip',
                label: c.isFolder ? t('Skip existing') : t('Skip'),
                testId: 's3-upload-skip'
              },
              {
                value: 'replace',
                label: t('Replace'),
                variant: 'primary' as const,
                autoFocus: true,
                testId: 's3-upload-replace'
              }
            ]
          })
          if (picked === null || picked === 'cancel') return
          if (picked === 'replace-all') remembered = 'replace'
          if (picked === 'skip-all') remembered = 'skip'
          answer = picked === 'replace' || picked === 'replace-all' ? 'replace' : 'skip'
        }
        overwrite = answer === 'replace'
        // Bỏ qua cả file lẻ đã có → không có gì để tải.
        if (!overwrite && !c.isFolder) continue
      }
      await act({ op: 'upload', bucket: b, prefix: p, localPath: c.localPath, overwrite })
    }
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
    const dir = await window.shellhouse.pickFolder(t('Choose where to save'), 'downloads')
    if (!dir) return
    // Session Host tự đặt tên file an toàn từ key (không ghép tên ở đây: "..\\x.exe" trên Windows).
    for (const e of entries)
      await act({
        op: 'download',
        bucket,
        key: e.key,
        localPath: dir,
        overwrite: false,
        ...(e.isFolder ? {} : { intoFolder: true })
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
      // Session Host báo theo ngôn ngữ giao diện — so cả câu gốc lẫn bản dịch.
      isConflict: (e) => {
        const message = cleanError(e)
        return message.includes(S3_OBJECT_CHANGED) || message.includes(t(S3_OBJECT_CHANGED))
      }
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
        label: t('Open'),
        icon: <FolderOpen size={14} />,
        onSelect: () => void load(bucket, one.key)
      })
    if (one && !one.isFolder) {
      items.push({
        id: 's3-details',
        label: t('Details'),
        icon: <Info size={14} />,
        hint: 'Space',
        onSelect: () => {
          setDetailsVersion(null)
          toggleDetails(true)
        }
      })
      if (one.size <= S3_EDIT_MAX_BYTES)
        items.push({
          id: 's3-edit-app',
          label: t('Edit'),
          icon: <FileCode size={14} />,
          onSelect: () => {
            editInApp(one)
          }
        })
      items.push({
        id: 's3-edit',
        label: t('Edit in local editor'),
        icon: <FilePen size={14} />,
        onSelect: () => void edit(one)
      })
    }
    items.push({
      id: 's3-download',
      label:
        list.length > 1
          ? t('Download {n} items…', { n: formatNumber(list.length) })
          : t('Download…'),
      icon: <Download size={14} />,
      onSelect: () => void download(list)
    })
    if (one && account)
      items.push({
        id: 's3-copy-command',
        label: t('Copy as command…'),
        icon: <TerminalSquare size={14} />,
        onSelect: () => {
          showCommands(
            t('{name} as AWS CLI commands', { name: one.key }),
            objectCommands(account, bucket, one.key, one.isFolder).map((l) => ({
              label: awsCommandLabel(l.id),
              command: l.command
            }))
          )
        }
      })
    if (one && !one.isFolder)
      items.push({
        id: 's3-link',
        label: t('Share link…'),
        icon: <Link size={14} />,
        onSelect: () => {
          setDialog({ kind: 'link', entry: one })
        }
      })
    items.push('separator')
    if (one?.isFolder) items.push(pinItem(bucket, one.key))
    if (one) items.push(copyPathItem(`${bucket}/${one.key}`))
    const urlItem = one && !one.isFolder ? copyUrlItem(bucket, one.key) : null
    if (urlItem) items.push(urlItem)
    if (one)
      items.push({
        id: 's3-rename',
        label: t('Rename…'),
        icon: <Pencil size={14} />,
        hint: 'F2',
        onSelect: () => {
          setDialog({ kind: 'rename', entry: one })
        }
      })
    items.push(
      {
        id: 's3-copy',
        label: t('Copy to…'),
        icon: <Copy size={14} />,
        onSelect: () => {
          setDialog({ kind: 'copy', entries: list, move: false })
        }
      },
      {
        id: 's3-move',
        label: t('Move to…'),
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
        label: t('Sync to…'),
        icon: <ArrowLeftRight size={14} />,
        onSelect: () => {
          setTool({ kind: 'sync', source: { bucket, prefix: onlyFolder.key } })
        }
      })
    if (list.some((e) => e.isFolder))
      items.push({
        id: 's3-stats',
        label: t('Size & object count'),
        icon: <BarChart3 size={14} />,
        onSelect: () => {
          folderStats(list)
        }
      })
    items.push('separator', {
      id: 's3-delete',
      label: t('Delete…'),
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
      label: t('Open'),
      icon: <FolderOpen size={14} />,
      onSelect: () => void load(name, '')
    },
    {
      id: 's3-bucket-settings',
      label: t('Bucket settings…'),
      icon: <Settings2 size={14} />,
      onSelect: () => {
        setSettings({ bucket: name, tab: 'versioning' })
      }
    },
    {
      id: 's3-bucket-stats',
      label: t('Size & object count'),
      icon: <BarChart3 size={14} />,
      disabled: calculating,
      onSelect: () => void calculate([name])
    },
    {
      id: 's3-bucket-sync',
      label: t('Sync to…'),
      icon: <ArrowLeftRight size={14} />,
      onSelect: () => {
        setTool({ kind: 'sync', source: { bucket: name, prefix: '' } })
      }
    },
    'separator',
    pinItem(name, ''),
    {
      id: 's3-bucket-copy-name',
      label: t('Copy name'),
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
  const chosen = useMemo(() => entries.filter((e) => selected.has(e.key)), [entries, selected])
  const crumbs = prefix.split('/').filter(Boolean)
  const { fileCount, folderCount, filesSize } = useMemo(() => {
    const all = listing?.entries ?? []
    const files = all.filter((e) => !e.isFolder)
    return {
      fileCount: files.length,
      folderCount: all.length - files.length,
      filesSize: files.reduce((n, e) => n + e.size, 0)
    }
  }, [listing])
  const one = chosen.length === 1 ? chosen[0] : undefined

  /** Chọn như trình quản lý file: bấm = chọn một, Ctrl/⌘ = thêm/bớt, Shift = chọn dải. */
  const select = (entry: S3Entry, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    // Chọn mục khác: bảng chi tiết quay về bản hiện tại của mục đang chọn.
    setDetailsVersion(null)
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
    cursor.current = entry.key
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(entry.key)) next.delete(entry.key)
      else next.add(entry.key)
      setSelected(next)
    } else setSelected(new Set([entry.key]))
  }

  /** Đưa con trỏ tới mục thứ `index`; `extend` (Shift) = chọn dải từ mục neo. */
  const moveTo = (index: number, extend = false): void => {
    if (entries.length === 0) return
    setDetailsVersion(null)
    const entry = entries[Math.max(0, Math.min(entries.length - 1, index))]
    if (!entry) return
    if (extend && anchor.current !== null) {
      const a = entries.findIndex((x) => x.key === anchor.current)
      const b = entries.indexOf(entry)
      if (a !== -1) {
        const [from, to] = a < b ? [a, b] : [b, a]
        setSelected(new Set(entries.slice(from, to + 1).map((x) => x.key)))
        cursor.current = entry.key
        scrollTo(entry.key)
        return
      }
    }
    anchor.current = entry.key
    cursor.current = entry.key
    setSelected(new Set([entry.key]))
    scrollTo(entry.key)
  }

  const scrollTo = (key: string): void => {
    listRef.current
      ?.querySelector(`[data-key="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  const moveCursor = (delta: number, extend = false): void => {
    const current = entries.findIndex((x) => x.key === (cursor.current ?? anchor.current))
    moveTo(current === -1 ? (delta > 0 ? 0 : entries.length - 1) : current + delta, extend)
  }

  /** Số dòng của một trang (PageUp / PageDown). */
  const pageRows = (): number =>
    Math.max(1, Math.floor((listRef.current?.clientHeight ?? 320) / 32) - 1)

  const goUp = (): void => {
    if (bucket === null) return
    if (prefix === '') goRoot()
    else void load(bucket, parentPrefix(prefix))
  }

  const onListKey = (e: React.KeyboardEvent): void => {
    const handled = (): void => {
      e.preventDefault()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      handled()
      if (e.altKey && e.key === 'ArrowUp') goUp()
      else moveCursor(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      handled()
      moveCursor(e.key === 'PageDown' ? pageRows() : -pageRows(), e.shiftKey)
    } else if (e.key === 'Home' || e.key === 'End') {
      handled()
      moveTo(e.key === 'Home' ? 0 : entries.length - 1, e.shiftKey)
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
    } else if (e.key === ' ' && one && !one.isFolder) {
      // Space: mở / đóng bảng chi tiết (như Quick Look).
      handled()
      setDetailsVersion(null)
      toggleDetails()
    } else if (e.key === 'Escape' && chosen.length > 0) {
      handled()
      setSelected(new Set())
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

  // Xử lý sự kiện của dòng (ObjectRow) — cập nhật sau mỗi lần vẽ, dòng memo không phải vẽ lại.
  const rowHandlers = useRef<RowHandlers>({
    select: () => undefined,
    open: () => undefined,
    menu: () => undefined
  })
  useEffect(() => {
    rowHandlers.current = {
      select,
      open: (entry) => {
        if (bucket === null) return
        if (entry.isFolder) void load(bucket, entry.key)
        else void download([entry])
      },
      menu: (entry, e) => {
        // Chuột phải vào mục chưa chọn → chỉ chọn mục đó (như trình quản lý file).
        const isSelected = selected.has(entry.key)
        const list = isSelected ? chosen : [entry]
        if (!isSelected) {
          anchor.current = entry.key
          setSelected(new Set([entry.key]))
        }
        openMenu(e, entryMenu(list))
      }
    }
  })

  const location = bucket === null ? '' : `${bucket}/${prefix}`
  const herePinned = bucket !== null && isPinned(bucket, prefix)
  const unknownSizes = (buckets ?? []).filter((b) => bucketStats[b.name]?.state !== 'done')
  /** Object đang xem trong bảng chi tiết: phiên bản đã chọn, hoặc file đang chọn. */
  const detailsTarget: DetailsTarget | null =
    detailsVersion ?? (one && !one.isFolder ? { key: one.key, name: one.name } : null)
  const showDetails = detailsOpen && bucket !== null
  /** Thanh đường dẫn sâu: giữ cấp đầu + 2 cấp cuối, gộp phần giữa vào nút "…". */
  const hiddenCrumbs = crumbs.length > MAX_CRUMBS ? crumbs.slice(1, crumbs.length - 2) : []
  const crumbPrefix = (i: number): string => `${crumbs.slice(0, i + 1).join('/')}/`
  const deleteVersions = (versions: S3Version[]): void => {
    if (versions.length > 0) setDialog({ kind: 'deleteVersions', versions })
  }

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
      {/* Header (thiết kế v0.5): Storage / tài khoản › bucket ▾ › thư mục */}
      <div className="flex h-ds-header shrink-0 items-center gap-1 border-b border-ds-border-subtle pr-2 pl-2">
        <IconButton
          label={bucket === null ? t('Go up') : t('Go up (Backspace)')}
          disabled={bucket === null}
          onClick={goUp}
        >
          <ArrowUp size={15} />
        </IconButton>
        <nav
          className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px] whitespace-nowrap"
          aria-label={t('Path')}
          data-testid="s3-path"
          title={location ? `s3://${location}` : undefined}
        >
          <span className="hidden shrink-0 items-center gap-1.5 px-1.5 text-ds-fg-3 @3xl:flex">
            <Database size={14} strokeWidth={1.5} />
            {t('S3 storage')}
            <span className="pl-1 text-ds-fg-4">/</span>
          </span>
          <button
            type="button"
            className={cx(
              'flex min-w-0 shrink-[2] items-center gap-1.5 rounded-ds-sm px-1.5 py-0.5 hover:bg-ds-hover',
              bucket === null ? 'font-semibold text-fg' : 'font-medium text-muted hover:text-fg'
            )}
            data-testid="s3-crumb-account"
            title={account ? account.endpoint || `AWS ${account.region || 'us-east-1'}` : undefined}
            onClick={goRoot}
          >
            <Cloud size={14} strokeWidth={1.5} className="shrink-0 text-faint" />
            {/* Trong bucket + khung hẹp: chỉ còn icon, nhường chỗ cho tên bucket / thư mục. */}
            <span className={cx('truncate', bucket !== null && 'hidden @2xl:inline')}>
              {accountName}
            </span>
          </button>
          {bucket === null ? (
            buckets && (
              <span className="shrink-0 pl-1 text-faint">
                · {tn(buckets.length, '{n} bucket', '{n} buckets')}
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
                {hiddenCrumbs.length > 0 ? (
                  <>
                    {crumbs[0] !== undefined && (
                      <Crumb
                        label={crumbs[0]}
                        last={false}
                        onOpen={() => void load(bucket, crumbPrefix(0))}
                      />
                    )}
                    <span className="flex shrink-0 items-center gap-0.5">
                      <ChevronRight size={12} className="shrink-0 text-faint" />
                      <button
                        type="button"
                        aria-label={t('Show {n} hidden folders', { n: hiddenCrumbs.length })}
                        title={hiddenCrumbs.join('/')}
                        data-testid="s3-crumb-more"
                        className="rounded px-1 py-0.5 text-muted hover:bg-hover hover:text-fg"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect()
                          openMenu(
                            {
                              clientX: r.left,
                              clientY: r.bottom + 4,
                              preventDefault: () => undefined
                            },
                            hiddenCrumbs.map((c, j) => ({
                              id: `s3-crumb-${String(j + 1)}`,
                              label: c,
                              icon: <FolderOpen size={14} />,
                              onSelect: () => void load(bucket, crumbPrefix(j + 1))
                            }))
                          )
                        }}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    </span>
                    {crumbs.slice(-2).map((c, k) => (
                      <Crumb
                        key={crumbs.length - 2 + k}
                        label={c}
                        last={k === 1}
                        onOpen={() => void load(bucket, crumbPrefix(crumbs.length - 2 + k))}
                      />
                    ))}
                  </>
                ) : (
                  crumbs.map((c, i) => (
                    <Crumb
                      key={i}
                      label={c}
                      last={i === crumbs.length - 1}
                      onOpen={() => void load(bucket, crumbPrefix(i))}
                    />
                  ))
                )}
              </span>
            </>
          )}
        </nav>
        {env && <EnvLabel env={env} size="md" className="mr-1" />}
        {bucket === null ? (
          <SortMenu
            options={
              buckets?.some((b) => b.region)
                ? bucketSortOptions()
                : bucketSortOptions().filter((o) => o.key !== 'region')
            }
            sort={bucketSort}
            onChange={setBucketSort}
            testId="s3-sort"
          />
        ) : (
          <SortMenu options={objectSortOptions()} sort={sort} onChange={setSort} testId="s3-sort" />
        )}
        {bucket !== null && (
          <IconButton
            label={herePinned ? t('Unpin from sidebar') : t('Pin this location to the sidebar')}
            active={herePinned}
            data-testid="s3-pin-here"
            onClick={() => {
              togglePin(bucket, prefix)
            }}
          >
            <Pin size={14} className={herePinned ? 'text-accent' : ''} />
          </IconButton>
        )}
        <IconButton label={t('Refresh')} disabled={!ready} onClick={refresh}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>

      {/* Thanh công cụ */}
      <div
        className="flex h-10 shrink-0 items-center gap-0.5 overflow-hidden border-b border-line px-2"
        role="toolbar"
        aria-label={t('Actions')}
      >
        <label className="mr-2 flex h-ds-ctl w-36 shrink-0 items-center gap-1.5 rounded-ds-md border border-ds-border-control bg-ds-surface-1 px-2 focus-within:border-ds-accent @xl:w-56">
          <Search size={12} className="shrink-0 text-faint" />
          <input
            className="min-w-0 flex-1 bg-transparent text-ds-sm outline-none placeholder:text-ds-fg-3"
            placeholder={bucket === null ? t('Filter buckets') : t('Filter by prefix…')}
            aria-label={bucket === null ? t('Filter buckets') : t('Filter this folder')}
            data-testid="s3-filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.preventDefault()
                e.stopPropagation()
                setFilter('')
              }
            }}
          />
          {filter && (
            <button
              type="button"
              aria-label={t('Clear filter')}
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
          <>
            {calculating ? (
              <ToolButton
                icon={<Square size={13} />}
                label={t('Stop counting')}
                labelAt="md"
                testId="s3-calc-stop"
                onClick={() => {
                  stopCalc.current = true
                }}
              />
            ) : (
              <ToolButton
                icon={<BarChart3 size={14} />}
                label={t('Calculate all sizes')}
                labelAt="md"
                testId="s3-calc-all"
                disabled={unknownSizes.length === 0}
                onClick={() => void calculate(unknownSizes.map((b) => b.name))}
              />
            )}
            <ToolButton
              icon={<FileDown size={14} />}
              label={t('Export list')}
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
                  icon={<Settings2 size={14} />}
                  label={t('Settings')}
                  labelAt="3xl"
                  title={t('Bucket settings: versioning, lifecycle, CORS')}
                  testId="s3-bucket-settings-selected"
                  onClick={() => {
                    setSettings({ bucket: selectedBucket, tab: 'versioning' })
                  }}
                />
                <ToolButton
                  icon={<ArrowLeftRight size={14} />}
                  label={t('Sync to…')}
                  labelAt="xl"
                  testId="s3-sync-bucket"
                  onClick={() => {
                    setTool({ kind: 'sync', source: { bucket: selectedBucket, prefix: '' } })
                  }}
                />
                <ToolButton
                  icon={<FolderOpen size={14} />}
                  label={t('Open')}
                  labelAt="xl"
                  onClick={() => void load(selectedBucket, '')}
                />
                <ToolButton
                  icon={isPinned(selectedBucket, '') ? <PinOff size={14} /> : <Pin size={14} />}
                  label={isPinned(selectedBucket, '') ? t('Unpin') : t('Pin to sidebar')}
                  labelAt="3xl"
                  testId="s3-pin-bucket"
                  onClick={() => {
                    togglePin(selectedBucket, '')
                  }}
                />
              </>
            )}
            <ToolButton
              icon={<Plus size={14} />}
              label={t('New bucket')}
              labelAt="md"
              primary
              testId="s3-new-bucket"
              disabled={!ready}
              onClick={() => {
                setDialog({ kind: 'bucket' })
              }}
            />
          </>
        ) : (
          <>
            <ToolButton
              icon={<FolderUp size={14} />}
              label={t('Upload folder')}
              labelAt="5xl"
              onClick={() =>
                void window.shellhouse
                  .pickFolder(t('Choose a folder to upload'), 'downloads')
                  .then((dir) => upload(dir ? [dir] : []))
              }
            />
            <ToolButton
              icon={<FolderPlus size={14} />}
              label={t('New folder')}
              labelAt="xl"
              testId="s3-mkdir"
              onClick={() => {
                setDialog({ kind: 'mkdir' })
              }}
            />
            <ToolButton
              icon={<ArrowLeftRight size={14} />}
              label={t('Sync…')}
              labelAt="5xl"
              testId="s3-sync-here"
              onClick={() => {
                // Một thư mục đang chọn → đồng bộ thư mục đó; không thì cả chỗ đang xem.
                const folder = one?.isFolder ? one.key : prefix
                setTool({ kind: 'sync', source: { bucket, prefix: folder } })
              }}
            />
            <span className="mx-1 h-4 w-px shrink-0 bg-line" />
            <ToolButton
              icon={<History size={14} />}
              label={t('Versions')}
              labelAt="4xl"
              title={t('Show every version and delete marker')}
              pressed={versionsMode}
              testId="s3-show-versions"
              onClick={() => {
                setVersionsMode(!versionsMode)
                setSelected(new Set())
                setDetailsVersion(null)
              }}
            />
            <ToolButton
              icon={<Settings2 size={14} />}
              label={t('Bucket settings')}
              labelAt="5xl"
              title={t('Bucket settings: versioning, lifecycle, CORS')}
              testId="s3-open-bucket-settings"
              onClick={() => {
                setSettings({ bucket, tab: 'versioning' })
              }}
            />
            <span className="flex-1" />
            {chosen.length > 0 && !versionsMode && (
              <>
                <span
                  className="flex shrink-0 items-center gap-0.5 rounded-md bg-accent-soft py-0.5 pr-0.5 pl-2 text-xs font-medium text-accent"
                  data-testid="s3-selection"
                >
                  {tn(chosen.length, '{n} selected', '{n} selected')}
                  <button
                    type="button"
                    aria-label={t('Clear selection')}
                    title={t('Clear selection (Esc)')}
                    className="rounded p-0.5 hover:bg-hover"
                    onClick={() => {
                      setSelected(new Set())
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
                {one && !one.isFolder && (
                  <ToolButton
                    icon={<FilePen size={14} />}
                    label={opening ? t('Opening…') : t('Edit')}
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
                  label={
                    chosen.length > 1
                      ? t('Download {n}', { n: formatNumber(chosen.length) })
                      : t('Download')
                  }
                  labelAt="xl"
                  testId="s3-download"
                  onClick={() => void download(chosen)}
                />
                {one && !one.isFolder && (
                  <ToolButton
                    icon={<Link size={14} />}
                    label={t('Share link')}
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
                    label={t('Rename')}
                    labelAt="5xl"
                    testId="s3-rename"
                    onClick={() => {
                      setDialog({ kind: 'rename', entry: one })
                    }}
                  />
                )}
                <ToolButton
                  icon={<Copy size={14} />}
                  label={t('Copy to…')}
                  labelAt="5xl"
                  testId="s3-copy"
                  onClick={() => {
                    setDialog({ kind: 'copy', entries: chosen, move: false })
                  }}
                />
                <ToolButton
                  icon={<FolderInput size={14} />}
                  label={t('Move to…')}
                  labelAt="5xl"
                  testId="s3-move"
                  onClick={() => {
                    setDialog({ kind: 'copy', entries: chosen, move: true })
                  }}
                />
                <span className="mx-1 h-4 w-px shrink-0 bg-line" />
                <ToolButton
                  icon={<Trash2 size={14} />}
                  label={t('Delete')}
                  labelAt="3xl"
                  testId="s3-delete"
                  danger
                  onClick={() => {
                    setDialog({ kind: 'delete', entries: chosen })
                  }}
                />
              </>
            )}
            <ToolButton
              icon={<Info size={14} />}
              label={t('Details')}
              labelAt="5xl"
              title={t('Show details (Space)')}
              pressed={detailsOpen}
              testId="s3-details-toggle"
              onClick={() => {
                toggleDetails()
              }}
            />
            <ToolButton
              icon={<Upload size={14} />}
              label={t('Upload')}
              labelAt="md"
              primary
              testId="s3-upload"
              onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
            />
          </>
        )}
      </div>

      {error && (bucket === null || listing !== null) && (
        <div className="flex shrink-0 items-start gap-1 border-b border-line p-2">
          <div className="min-w-0 flex-1">
            <Notice tone="danger" testId="s3-error">
              {error}
            </Notice>
          </div>
          <IconButton
            label={t('Dismiss')}
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
              <RefreshCw size={12} className="animate-spin" /> {t('Connecting…')}
            </p>
          )
        ) : buckets.length === 0 && !error ? (
          <Empty
            icon={<Cloud size={20} />}
            title={t('No buckets yet')}
            text={t('Create a bucket to start storing files.')}
            action={
              <Button
                size="sm"
                icon={<Plus size={13} />}
                disabled={!ready}
                onClick={() => {
                  setDialog({ kind: 'bucket' })
                }}
              >
                {t('New bucket')}
              </Button>
            }
          />
        ) : buckets.length === 0 ? null : (
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
        <div className="flex min-h-0 flex-1">
          {versionsMode ? (
            <S3VersionList
              key={`${bucket}/${prefix}`}
              run={run}
              bucket={bucket}
              prefix={prefix}
              filter={filter}
              sort={sort}
              onSort={setSort}
              reloadKey={reloadKey}
              onOpenFolder={(key) => void load(bucket, key)}
              onDetails={(v) => {
                setDetailsVersion(
                  v.isLatest
                    ? { key: v.key, name: v.name }
                    : { key: v.key, name: v.name, versionId: v.versionId }
                )
                toggleDetails(true)
              }}
              onDeleteVersions={deleteVersions}
              onChanged={() => {
                void load(bucket, prefix, { refresh: true })
              }}
            />
          ) : (
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Đang tải thư mục khác: thanh mảnh trên đầu danh sách (giữ danh sách cũ, không nháy). */}
              {loading && listing && (
                <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-accent-soft">
                  <div className="h-full w-full animate-pulse bg-info/70" />
                </div>
              )}
              <div
                ref={listRef}
                className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
                role="grid"
                aria-label={t('Objects')}
                aria-multiselectable
                aria-busy={loading}
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
                  {sortHeader('name', t('Name'))}
                  {sortHeader('size', t('Size'))}
                  {sortHeader('modified', t('Modified'), 'hidden @xl:flex')}
                  <span role="columnheader" className="hidden @3xl:block">
                    {t('Class')}
                  </span>
                </div>
                {!listing && error && !loading && (
                  <Empty
                    icon={<FolderOpen size={20} />}
                    title={t('Could not open this folder')}
                    text={error}
                    action={
                      <Button
                        size="sm"
                        icon={<RefreshCw size={13} />}
                        data-testid="s3-retry"
                        onClick={() => void load(bucket, prefix)}
                      >
                        {t('Try again')}
                      </Button>
                    }
                  />
                )}
                {listing && entries.length === 0 && (
                  <Empty
                    icon={<FolderOpen size={20} />}
                    title={filter ? t('No matches') : t('This folder is empty')}
                    text={
                      filter
                        ? t('Nothing in this folder matches “{filter}”.', { filter })
                        : t('Drop files here, or upload from your computer.')
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
                          {t('Clear filter')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          icon={<Upload size={13} />}
                          onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
                        >
                          {t('Upload files')}
                        </Button>
                      )
                    }
                  />
                )}
                {entries.map((entry) => (
                  <ObjectRow
                    key={entry.key}
                    entry={entry}
                    selected={selected.has(entry.key)}
                    pinned={entry.isFolder && isPinned(bucket, entry.key)}
                    handlers={rowHandlers}
                  />
                ))}
                {listing?.truncated && (
                  <div className="flex items-center gap-3 p-3 text-xs text-faint">
                    <span className="min-w-0 flex-1">
                      {t(
                        'Showing the first {n} items. The filter only searches items that are loaded.',
                        { n: formatNumber(listing.entries.length) }
                      )}
                    </span>
                    {listing.nextToken && (
                      <Button
                        size="sm"
                        disabled={loadingMore}
                        data-testid="s3-load-more"
                        onClick={() => void loadMore()}
                      >
                        {loadingMore
                          ? t('Loading…')
                          : t('Load {n} more', { n: formatNumber(S3_LIST_PAGE) })}
                      </Button>
                    )}
                  </div>
                )}
                {!listing && loading && (
                  <div className="flex flex-col gap-2 p-3" aria-hidden>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <div key={i} className="flex h-5 items-center gap-2">
                        <span className="size-4 shrink-0 animate-pulse rounded bg-subtle" />
                        <span
                          className="h-3 animate-pulse rounded bg-subtle"
                          style={{ width: `${String(30 + ((i * 17) % 45))}%` }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Thanh trạng thái */}
              {listing && (
                <div
                  className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-3 text-xs whitespace-nowrap text-faint"
                  data-testid="s3-status"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {tn(folderCount, '{n} folder', '{n} folders')},{' '}
                    {tn(fileCount, '{n} file', '{n} files')} · {formatSize(filesSize)}
                    {listing.truncated ? '+' : ''}
                    {chosen.length > 0
                      ? ` · ${tn(chosen.length, '{n} selected', '{n} selected')}`
                      : ''}
                  </span>
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg"
                    title={t('Count every object in this folder and its subfolders')}
                    data-testid="s3-folder-stats"
                    onClick={() => {
                      folderStats([])
                    }}
                  >
                    <BarChart3 size={12} />
                    <span className="hidden @md:inline">{t('Folder size…')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {showDetails && (
            <S3DetailsPanel
              // Đổi object / phiên bản = state mới (không lẫn phần đang sửa, link của mục trước).
              key={
                detailsTarget ? `${detailsTarget.key}\u0000${detailsTarget.versionId ?? ''}` : ''
              }
              run={run}
              account={account}
              bucket={bucket}
              bucketRegion={bucketRegion(bucket)}
              target={detailsTarget}
              reloadKey={reloadKey}
              onClose={() => {
                toggleDetails(false)
              }}
              onChanged={() => {
                void load(bucket, prefix, { refresh: true })
                setReloadKey((k) => k + 1)
              }}
              onSelectVersion={(target) => {
                setDetailsVersion(target.versionId ? target : null)
              }}
              onDeleteVersions={deleteVersions}
              onOpenSettings={() => {
                setSettings({ bucket, tab: 'versioning' })
              }}
            />
          )}
        </div>
      )}

      {bucket === null && buckets && buckets.length > 0 && (
        <div
          className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-3 text-xs whitespace-nowrap text-faint"
          data-testid="s3-status"
        >
          <span className="min-w-0 flex-1 truncate">
            {tn(buckets.length, '{n} bucket', '{n} buckets')}
            {selectedBucket ? ` · ${t('1 selected')}` : ''}
          </span>
          <span className="hidden @xl:inline">{t('Sizes are counted on demand')}</span>
        </div>
      )}

      <JobsPanel jobs={bulk.jobs} onStop={bulk.stop} />
      <TransferList
        transfers={transfers}
        testId="s3-transfers"
        rowTestId="s3-transfer"
        onCancel={(id) => {
          clientRef.current?.cancel(id)
        }}
        onClear={() => void act({ op: 'clearDone' })}
      />

      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <CloudUpload size={18} className="text-accent" />
            {t('Drop to upload to {where}', { where: location || bucket || '' })}
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
      {settings && (
        <S3BucketSettingsDialog
          run={run}
          bucket={settings.bucket}
          initialTab={settings.tab}
          onClose={() => {
            setSettings(null)
          }}
          onVersioningChanged={() => {
            setReloadKey((k) => k + 1)
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
            if (bucket !== null) void load(bucket, prefix, { refresh: true })
          }}
        />
      )}
      {dialog && (
        <S3Dialog
          dialog={dialog}
          typeName={
            dialog.kind === 'delete' && env?.confirm === 'type'
              ? dialog.entries.length === 1
                ? dialog.entries[0]?.name
                : tn(dialog.entries.length, '{n} item', '{n} items')
              : undefined
          }
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
            else if (bucket !== null) {
              if (kind === 'deleteVersions') {
                setReloadKey((k) => k + 1)
                setDetailsVersion(null)
              }
              await load(bucket, prefix, { refresh: true })
            }
          }}
          onJob={startJob}
        />
      )}
    </div>
  )
}

/** Nhãn của từng lệnh AWS CLI (dịch lúc vẽ). */
function awsCommandLabel(id: string): string {
  switch (id) {
    case 'list':
      return t('List')
    case 'download':
      return t('Download')
    case 'sync':
      return t('Sync to a local folder')
    case 'head':
      return t('Metadata')
    case 'presign':
      return t('Share link (1 hour)')
    case 'remove':
      return t('Delete')
    default:
      return id
  }
}
