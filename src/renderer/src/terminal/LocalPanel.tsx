import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  ArrowRight,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  Laptop,
  MoveRight,
  Play,
  RefreshCw,
  Trash2,
  X,
  Download,
  FileClock
} from 'lucide-react'
import { DRAG_LOCAL, DRAG_REMOTE, joinLocal, type LocalListing } from '@shared/local-files'
import { isPartFile, PART_SUFFIX, type LocalPartInfo, type TransferStatus } from '@shared/sftp'
import { t, tn } from '@shared/i18n'
import { formatDateTime, formatNumber } from '@shared/i18n/format'
import { Button, IconButton, Input, Notice } from '../components/ui'
import { confirmAction } from '../stores/confirm'
import { statusLine, type LocalTarget, type SftpActions } from './SftpPanel'
import { useContextMenu } from '../components/ContextMenu'
import { SortMenu, usePersistentSort } from '../components/SortMenu'
import { FileTable, type FileColumn } from '../components/files/FileTable'
import { Empty, ToolButton } from '../components/files/parts'
import { cleanError, formatSize } from '../lib/format'
import { toast } from '../stores/toasts'
import { settleTransfers } from '@shared/sftp-move'
import {
  FILE_SORT_KEYS,
  FILE_SORT_OPTIONS,
  fileSortOptions,
  nameOrder,
  type FileSort
} from './file-sort'

type LocalEntry = LocalListing['entries'][number]

const [NAME_SORT, SIZE_SORT, MTIME_SORT] = FILE_SORT_OPTIONS
const GRID = 'grid-cols-[minmax(0,1fr)_4.5rem] @md:grid-cols-[minmax(0,1fr)_4.5rem_8.5rem]'
/** Cột phụ — hàm (không phải hằng) để nhãn dịch lúc render. */
const columns = (): FileColumn<LocalEntry, FileSort>[] => [
  {
    id: 'size',
    label: t('Size'),
    sort: SIZE_SORT,
    align: 'right',
    render: (e) => (e.isDir ? '' : formatSize(e.size))
  },
  {
    id: 'mtime',
    label: t('Modified'),
    sort: MTIME_SORT,
    className: 'hidden @md:block',
    render: (e) => (e.mtime ? formatDateTime(e.mtime) : '')
  }
]

/** Tên kéo từ khung Remote: mảng JSON (nhiều mục) hoặc một tên (bản cũ). */
function remoteNames(data: string): string[] {
  try {
    const parsed: unknown = JSON.parse(data)
    if (Array.isArray(parsed)) return parsed.filter((n): n is string => typeof n === 'string')
  } catch {
    // Không phải JSON: một tên.
  }
  return data ? [data] : []
}

/**
 * Khung "Local" của trình quản lý file hai cột (như WinSCP / MobaXterm): thư mục trên máy. Kéo
 * sang khung Remote (hoặc nút "Upload") để tải lên; thả mục từ khung Remote vào đây để tải về.
 */
export function LocalPanel({
  transfers,
  actionsRef,
  onTargetChange
}: {
  transfers: TransferStatus[]
  actionsRef: RefObject<SftpActions | null>
  /** Báo thư mục đang mở cho khung Remote (tải về thẳng vào đây). */
  onTargetChange: (target: LocalTarget) => void
}): React.JSX.Element {
  const [listing, setListing] = useState<LocalListing | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = usePersistentSort<FileSort>('sftp-local', FILE_SORT_KEYS, {
    key: 'name',
    dir: 'asc'
  })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [dragOver, setDragOver] = useState(false)
  const lastDone = useRef(0)
  const { menu, open: openMenu } = useContextMenu()

  const apply = useCallback(
    (result: LocalListing) => {
      setListing(result)
      setPathInput(result.path)
      setSelected(new Set())
      onTargetChange({
        dir: result.path,
        sep: result.sep,
        names: new Set(result.entries.map((e) => e.name))
      })
    },
    [onTargetChange]
  )

  /** Lần nạp mới nhất — kết quả của lần cũ (bấm nhanh qua nhiều thư mục) bị bỏ. */
  const loadSeq = useRef(0)
  const load = useCallback(
    async (path: string | null) => {
      const seq = ++loadSeq.current
      setLoading(true)
      setError(null)
      try {
        const result = await window.shellhouse.listLocal(path)
        if (seq === loadSeq.current) apply(result)
      } catch (e) {
        if (seq === loadSeq.current) setError(cleanError(e))
      } finally {
        if (seq === loadSeq.current) setLoading(false)
      }
    },
    [apply]
  )

  // Lần đầu: thư mục home.
  useEffect(() => {
    const seq = ++loadSeq.current
    void window.shellhouse.listLocal(null).then(
      (result) => {
        if (seq === loadSeq.current) apply(result)
      },
      (e: unknown) => {
        if (seq === loadSeq.current) setError(cleanError(e))
      }
    )
  }, [apply])

  // Tải về xong → hiện file mới.
  const doneDownloads = transfers.filter(
    (t) => t.direction === 'download' && t.state === 'done'
  ).length
  useEffect(() => {
    if (doneDownloads > lastDone.current && listing) void load(listing.path)
    lastDone.current = doneDownloads
  }, [doneDownloads, listing, load])

  // Lọc + sắp xếp chỉ khi danh sách / cách sắp đổi (không làm lại mỗi lần tiến độ truyền đổi).
  const entries = useMemo(
    () =>
      (listing?.entries ?? [])
        .filter((e) => showHidden || (!e.name.startsWith('.') && !isPartFile(e.name)))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          const by =
            sort.key === 'size' && !a.isDir
              ? a.size - b.size
              : sort.key === 'mtime'
                ? a.mtime - b.mtime
                : 0
          return (by || nameOrder.compare(a.name, b.name)) * (sort.dir === 'asc' ? 1 : -1)
        }),
    [listing, showHidden, sort.key, sort.dir]
  )
  const pathsOf = (names: Iterable<string>): string[] =>
    listing ? [...names].map((n) => joinLocal(listing.path, n, listing.sep)) : []
  const chosen = entries.filter((e) => selected.has(e.name))
  const sortOptions = useMemo(() => fileSortOptions(), [])

  // ——— File tải dở bị bỏ lại (`*.shellhouse-part`) trong thư mục đang mở ———
  // Chỉ xét những gì danh sách thư mục đã có (không quét thêm); lượt đang nằm trong danh sách
  // truyền thì do danh sách truyền lo (Resume / Discard ở đó).
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [partInfo, setPartInfo] = useState<{ key: string; parts: LocalPartInfo[] } | null>(null)
  const tracked = useMemo(
    () => new Set(transfers.filter((x) => x.direction === 'download').map((x) => x.localPath)),
    [transfers]
  )
  const orphanKey = useMemo(() => {
    if (!listing) return ''
    const names = listing.entries
      .filter((e) => !e.isDir && e.name.endsWith(PART_SUFFIX))
      .map((e) => e.name.slice(0, -PART_SUFFIX.length))
      .filter((n) => n && !tracked.has(joinLocal(listing.path, n, listing.sep)))
    return names.length > 0 ? JSON.stringify([listing.path, names]) : ''
  }, [listing, tracked])
  useEffect(() => {
    if (!orphanKey) return
    const [dir, names] = JSON.parse(orphanKey) as [string, string[]]
    let cancelled = false
    const actions = actionsRef.current
    void (actions ? actions.localParts(dir, names) : Promise.reject(new Error('not ready'))).then(
      (parts) => {
        if (!cancelled) setPartInfo({ key: orphanKey, parts })
      },
      () => {
        // Chưa có khung Remote / lỗi đọc: vẫn báo (chỉ xoá được, không tiếp tục).
        if (cancelled) return
        const sizes = new Map(listing?.entries.map((e) => [e.name, e.size]))
        setPartInfo({
          key: orphanKey,
          parts: names.map((name) => ({
            name,
            partBytes: sizes.get(name + PART_SUFFIX) ?? 0,
            totalBytes: null,
            remotePath: null,
            resumable: false
          }))
        })
      }
    )
    return () => {
      cancelled = true
    }
    // listing đọc trong nhánh lỗi chỉ để lấy kích thước — orphanKey đã đổi theo listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphanKey, actionsRef])
  const incomplete =
    listing &&
    orphanKey &&
    partInfo?.key === orphanKey &&
    partInfo.parts.length > 0 &&
    !dismissed.has(listing.path)
      ? partInfo.parts
      : null

  const resumeParts = async (parts: LocalPartInfo[]): Promise<void> => {
    if (!listing) return
    await actionsRef.current?.resumeLocalParts(
      listing.path,
      listing.sep,
      parts.filter((p) => p.resumable)
    )
  }
  const deleteParts = async (parts: LocalPartInfo[]): Promise<void> => {
    if (!listing) return
    const bytes = parts.reduce((n, p) => n + p.partBytes, 0)
    const ok = await confirmAction({
      title: tn(
        parts.length,
        'Delete {n} incomplete download?',
        'Delete {n} incomplete downloads?'
      ),
      message: t(
        'The partial files ({size}) will be deleted. Downloading the same files again will start from the beginning.',
        { size: formatSize(bytes) }
      ),
      confirmLabel: t('Delete'),
      danger: true,
      testId: 'local-parts-delete-dialog'
    })
    if (!ok) return
    try {
      await actionsRef.current?.discardLocalParts(
        listing.path,
        parts.map((p) => p.name)
      )
    } catch (e) {
      setError(cleanError(e))
    }
    void load(listing.path)
  }
  const { fileCount, folderCount, filesSize } = useMemo(() => {
    let files = 0
    let size = 0
    for (const e of entries)
      if (!e.isDir) {
        files++
        size += e.size
      }
    return { fileCount: files, folderCount: entries.length - files, filesSize: size }
  }, [entries])

  const uploadNames = (names: Iterable<string>): void => {
    void actionsRef.current?.upload(pathsOf(names))
  }

  // Trạng thái truyền mới nhất (chờ F6 xong mà không phụ thuộc lần render).
  const transfersRef = useRef(transfers)
  useEffect(() => {
    transfersRef.current = transfers
  })

  /** F6: tải lên rồi đưa bản trên máy vào Thùng rác — chỉ những mục đã tải lên xong. */
  const moveNames = async (names: string[]): Promise<void> => {
    if (!listing || names.length === 0) return
    const paths = pathsOf(names)
    const label =
      names.length === 1
        ? t('“{name}”', { name: names[0] ?? '' })
        : tn(names.length, '{n} item', '{n} items')
    const before = new Set(transfersRef.current.map((x) => x.id))
    toast.loading(t('Moving {label} to the server…', { label }), {
      group: 'sftp-move',
      duration: 0
    })
    try {
      await actionsRef.current?.upload(paths)
      const { moved, kept } = await settleTransfers({
        read: () => transfersRef.current,
        before,
        roots: paths,
        side: 'local',
        sep: listing.sep
      })
      if (moved.length) await window.shellhouse.trashLocal(moved)
      void load(listing.path)
      if (kept.length === 0)
        toast.success(t('Moved {label} to the server', { label }), { group: 'sftp-move' })
      else
        toast.warning(
          t('Moved {moved}, kept {kept} on this computer', {
            moved: moved.length,
            kept: kept.length
          }),
          {
            group: 'sftp-move',
            description: t('Items that were not uploaded completely stay where they are.')
          }
        )
    } catch (e) {
      toast.error(t('Could not move {label}', { label }), {
        group: 'sftp-move',
        description: cleanError(e)
      })
    }
  }
  const open = (entry: LocalEntry): void => {
    if (listing && entry.isDir) void load(joinLocal(listing.path, entry.name, listing.sep))
    else uploadNames([entry.name])
  }

  return (
    <section
      className="@container relative flex min-w-0 flex-1 flex-col border-r border-line bg-surface"
      data-testid="local-panel"
      aria-label={t('Local files')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_REMOTE)) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={(e) => {
        setDragOver(false)
        const names = remoteNames(e.dataTransfer.getData(DRAG_REMOTE))
        if (names.length === 0) return
        e.preventDefault()
        void actionsRef.current?.downloadByNames(names)
      }}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs font-medium text-muted">
          <Laptop size={14} /> <span className="hidden @md:inline">{t('Local')}</span>
        </span>
        <IconButton
          label={t('Parent folder (Backspace)')}
          disabled={!listing?.parent}
          onClick={() => listing?.parent && void load(listing.parent)}
        >
          <ArrowUp size={15} />
        </IconButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            void load(pathInput)
          }}
        >
          <Input
            mono
            className="h-7"
            aria-label={t('Local path')}
            data-testid="local-path"
            spellCheck={false}
            value={pathInput}
            onChange={(e) => {
              setPathInput(e.target.value)
            }}
          />
        </form>
        <IconButton
          label={showHidden ? t('Hide hidden files') : t('Show hidden files')}
          size="sm"
          active={showHidden}
          aria-pressed={showHidden}
          className="size-7"
          onClick={() => {
            setShowHidden(!showHidden)
          }}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <SortMenu options={sortOptions} sort={sort} onChange={setSort} testId="local-sort" />
        <IconButton
          label={t('Refresh')}
          disabled={!listing}
          onClick={() => listing && void load(listing.path)}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>
      <div
        className="flex h-10 shrink-0 items-center gap-0.5 overflow-hidden border-b border-line px-2"
        role="toolbar"
        aria-label={t('Local actions')}
      >
        <ToolButton
          icon={<ArrowRight size={14} />}
          label={selected.size > 1 ? t('Upload {n}', { n: selected.size }) : t('Upload')}
          labelAt="md"
          testId="local-upload"
          disabled={selected.size === 0}
          onClick={() => {
            uploadNames(selected)
          }}
        />
        <span className="flex-1" />
        <span className="hidden truncate pr-1 text-xs text-faint @xl:inline">
          {t('Drag files to the remote side to upload')}
        </span>
      </div>
      {incomplete && (
        <IncompleteBanner
          parts={incomplete}
          onResume={() => void resumeParts(incomplete)}
          onDelete={() => void deleteParts(incomplete)}
          onDismiss={() => {
            if (listing) setDismissed((d) => new Set(d).add(listing.path))
          }}
        />
      )}
      {error && (
        <div className="flex shrink-0 items-start gap-1 border-b border-line p-2">
          <div className="min-w-0 flex-1">
            <Notice tone="danger" testId="local-error">
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
      <FileTable
        items={entries}
        getKey={(e) => e.name}
        icon={(e) =>
          e.isDir ? (
            <Folder size={15} className="shrink-0 text-accent" />
          ) : (
            <File size={15} className="shrink-0 text-muted" />
          )
        }
        columns={columns()}
        gridClass={GRID}
        nameSort={NAME_SORT}
        sort={sort}
        onSort={setSort}
        selected={selected}
        onSelect={setSelected}
        onOpen={open}
        onUp={() => {
          if (listing?.parent) void load(listing.parent)
        }}
        onCopy={(list) => {
          uploadNames(list.map((x) => x.name))
        }}
        onMove={(list) => void moveNames(list.map((x) => x.name))}
        onContextMenu={(e, list) => {
          const single = list.length === 1 ? list[0] : undefined
          openMenu(e, [
            ...(single?.isDir
              ? [
                  {
                    id: 'local-open',
                    label: t('Open'),
                    icon: <FolderOpen size={14} />,
                    onSelect: () => {
                      open(single)
                    }
                  }
                ]
              : []),
            {
              id: 'local-upload',
              label: list.length > 1 ? t('Upload {n} items', { n: list.length }) : t('Upload'),
              icon: <ArrowRight size={14} />,
              hint: 'F5',
              onSelect: () => {
                uploadNames(list.map((x) => x.name))
              }
            },
            {
              id: 'local-move',
              label: t('Move to server'),
              icon: <MoveRight size={14} />,
              hint: 'F6',
              onSelect: () => void moveNames(list.map((x) => x.name))
            },
            ...(single
              ? [
                  {
                    id: 'local-copy-path',
                    label: t('Copy path'),
                    icon: <Copy size={14} />,
                    onSelect: () =>
                      void window.shellhouse.writeClipboard(pathsOf([single.name])[0] ?? '')
                  }
                ]
              : [])
          ])
        }}
        rowProps={(entry) => ({
          draggable: true,
          onDragStart: (e) => {
            const names = selected.has(entry.name) ? selected : [entry.name]
            e.dataTransfer.setData(DRAG_LOCAL, JSON.stringify(pathsOf(names)))
            e.dataTransfer.effectAllowed = 'copy'
          }
        })}
        ariaLabel={t('Local files')}
        rowTestId="local-entry"
      >
        {!listing && !error && (
          <div aria-label={t('Loading…')} aria-busy className="space-y-1 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex animate-pulse items-center gap-2.5 py-1">
                <span className="size-4 rounded bg-subtle" />
                <span
                  className="h-3 rounded bg-subtle"
                  style={{ width: `${String(40 + ((i * 37) % 45))}%` }}
                />
              </div>
            ))}
          </div>
        )}
        {listing && entries.length === 0 && (
          <Empty
            icon={<FolderOpen size={20} />}
            title={t('This folder is empty')}
            text={t('Drop files from the remote side here to download them.')}
            action={null}
          />
        )}
        {listing?.truncated && (
          <p className="p-3 text-xs text-faint">
            {t('Only the first {n} items are shown.', { n: formatNumber(5000) })}
          </p>
        )}
      </FileTable>
      {listing && (
        <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-3 text-xs whitespace-nowrap text-faint">
          <span className="min-w-0 flex-1 truncate">
            {statusLine(folderCount, fileCount, filesSize, chosen.length)}
          </span>
        </div>
      )}
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80">
          <p className="flex max-w-[90%] flex-col items-center gap-1 text-center text-sm font-medium text-fg">
            <span className="flex items-center gap-2">
              <Download size={16} className="text-accent" />
              {t('Drop to download')}
            </span>
            {listing && (
              <span className="max-w-full truncate font-mono text-xs font-normal text-muted">
                {t('to {path}', { path: listing.path })}
              </span>
            )}
          </p>
        </div>
      )}
      {menu}
    </section>
  )
}

/** Dải báo file tải dở bị bỏ lại trong thư mục: tiếp tục (nếu server của tab còn nguồn) / xoá. */
function IncompleteBanner({
  parts,
  onResume,
  onDelete,
  onDismiss
}: {
  parts: LocalPartInfo[]
  onResume: () => void
  onDelete: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const bytes = parts.reduce((n, p) => n + p.partBytes, 0)
  const resumable = parts.filter((p) => p.resumable).length
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-line bg-warning-soft/40 py-1.5 pr-1.5 pl-3 text-xs"
      role="status"
      data-testid="local-incomplete"
    >
      <FileClock size={14} className="shrink-0 text-warning" />
      <span
        className="min-w-0 flex-1 truncate text-fg"
        title={parts.map((p) => p.name + PART_SUFFIX).join('\n')}
      >
        {tn(parts.length, '{n} incomplete download ({size})', '{n} incomplete downloads ({size})', {
          size: formatSize(bytes)
        })}
        {resumable === 0 && (
          <span className="text-muted">
            {' · '}
            {t('download the same file again to resume')}
          </span>
        )}
      </span>
      {resumable > 0 && (
        <Button
          size="sm"
          icon={<Play size={12} />}
          data-testid="local-incomplete-resume"
          onClick={onResume}
        >
          {resumable === parts.length ? t('Resume') : t('Resume {n}', { n: resumable })}
        </Button>
      )}
      <Button
        size="sm"
        variant="danger-ghost"
        icon={<Trash2 size={12} />}
        data-testid="local-incomplete-delete"
        onClick={onDelete}
      >
        {t('Delete')}
      </Button>
      <IconButton label={t('Dismiss')} size="sm" onClick={onDismiss}>
        <X size={13} />
      </IconButton>
    </div>
  )
}
