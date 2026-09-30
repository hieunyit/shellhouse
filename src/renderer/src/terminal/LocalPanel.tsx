import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
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
  RefreshCw,
  X
} from 'lucide-react'
import { DRAG_LOCAL, DRAG_REMOTE, joinLocal, type LocalListing } from '@shared/local-files'
import type { TransferStatus } from '@shared/sftp'
import { IconButton, Input, Notice } from '../components/ui'
import type { LocalTarget, SftpActions } from './SftpPanel'
import { useContextMenu } from '../components/ContextMenu'
import { SortMenu, usePersistentSort } from '../components/SortMenu'
import { FileTable, type FileColumn } from '../components/files/FileTable'
import { Empty, ToolButton } from '../components/files/parts'
import { cleanError, dateFormat, formatSize } from '../lib/format'
import { FILE_SORT_KEYS, FILE_SORT_OPTIONS, nameOrder, type FileSort } from './file-sort'

type LocalEntry = LocalListing['entries'][number]

const [NAME_SORT, SIZE_SORT, MTIME_SORT] = FILE_SORT_OPTIONS
const GRID = 'grid-cols-[minmax(0,1fr)_4.5rem] @md:grid-cols-[minmax(0,1fr)_4.5rem_8.5rem]'
const COLUMNS: FileColumn<LocalEntry, FileSort>[] = [
  {
    id: 'size',
    label: 'Size',
    sort: SIZE_SORT,
    align: 'right',
    render: (e) => (e.isDir ? '' : formatSize(e.size))
  },
  {
    id: 'mtime',
    label: 'Modified',
    sort: MTIME_SORT,
    className: 'hidden @md:block',
    render: (e) => (e.mtime ? dateFormat.format(new Date(e.mtime)) : '')
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

  const load = useCallback(
    async (path: string | null) => {
      setLoading(true)
      setError(null)
      try {
        apply(await window.shellhouse.listLocal(path))
      } catch (e) {
        setError(cleanError(e))
      } finally {
        setLoading(false)
      }
    },
    [apply]
  )

  // Lần đầu: thư mục home.
  useEffect(() => {
    void window.shellhouse.listLocal(null).then(apply, (e: unknown) => {
      setError(cleanError(e))
    })
  }, [apply])

  // Tải về xong → hiện file mới.
  const doneDownloads = transfers.filter(
    (t) => t.direction === 'download' && t.state === 'done'
  ).length
  useEffect(() => {
    if (doneDownloads > lastDone.current && listing) void load(listing.path)
    lastDone.current = doneDownloads
  }, [doneDownloads, listing, load])

  const entries = (listing?.entries ?? [])
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      const by =
        sort.key === 'size' && !a.isDir
          ? a.size - b.size
          : sort.key === 'mtime'
            ? a.mtime - b.mtime
            : 0
      return (by || nameOrder.compare(a.name, b.name)) * (sort.dir === 'asc' ? 1 : -1)
    })
  const pathsOf = (names: Iterable<string>): string[] =>
    listing ? [...names].map((n) => joinLocal(listing.path, n, listing.sep)) : []
  const chosen = entries.filter((e) => selected.has(e.name))
  const fileCount = entries.filter((e) => !e.isDir).length
  const folderCount = entries.length - fileCount
  const filesSize = entries.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0)

  const uploadNames = (names: Iterable<string>): void => {
    void actionsRef.current?.upload(pathsOf(names))
  }
  const open = (entry: LocalEntry): void => {
    if (listing && entry.isDir) void load(joinLocal(listing.path, entry.name, listing.sep))
    else uploadNames([entry.name])
  }

  return (
    <section
      className="@container relative flex min-w-0 flex-1 flex-col border-r border-line bg-surface"
      data-testid="local-panel"
      aria-label="Local files"
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
          <Laptop size={14} /> <span className="hidden @md:inline">Local</span>
        </span>
        <IconButton
          label="Parent folder (Backspace)"
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
            aria-label="Local path"
            data-testid="local-path"
            spellCheck={false}
            value={pathInput}
            onChange={(e) => {
              setPathInput(e.target.value)
            }}
          />
        </form>
        <IconButton
          label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
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
        <SortMenu options={FILE_SORT_OPTIONS} sort={sort} onChange={setSort} testId="local-sort" />
        <IconButton label="Refresh" onClick={() => listing && void load(listing.path)}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>
      <div
        className="flex h-10 shrink-0 items-center gap-0.5 overflow-hidden border-b border-line px-2"
        role="toolbar"
        aria-label="Local actions"
      >
        <ToolButton
          icon={<ArrowRight size={14} />}
          label={selected.size > 1 ? `Upload ${selected.size}` : 'Upload'}
          labelAt="md"
          testId="local-upload"
          disabled={selected.size === 0}
          onClick={() => {
            uploadNames(selected)
          }}
        />
        <span className="flex-1" />
        <span className="hidden truncate pr-1 text-xs text-faint @xl:inline">
          Drag files to the remote side to upload
        </span>
      </div>
      {error && (
        <div className="flex shrink-0 items-start gap-1 border-b border-line p-2">
          <div className="min-w-0 flex-1">
            <Notice tone="danger" testId="local-error">
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
        columns={COLUMNS}
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
        onContextMenu={(e, list) => {
          const single = list.length === 1 ? list[0] : undefined
          openMenu(e, [
            ...(single?.isDir
              ? [
                  {
                    id: 'local-open',
                    label: 'Open',
                    icon: <FolderOpen size={14} />,
                    onSelect: () => {
                      open(single)
                    }
                  }
                ]
              : []),
            {
              id: 'local-upload',
              label: list.length > 1 ? `Upload ${list.length} items` : 'Upload',
              icon: <ArrowRight size={14} />,
              onSelect: () => {
                uploadNames(list.map((x) => x.name))
              }
            },
            ...(single
              ? [
                  {
                    id: 'local-copy-path',
                    label: 'Copy path',
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
        ariaLabel="Local files"
        rowTestId="local-entry"
      >
        {listing && entries.length === 0 && (
          <Empty
            icon={<FolderOpen size={20} />}
            title="This folder is empty"
            text="Drop files from the remote side here to download them."
            action={null}
          />
        )}
        {listing?.truncated && (
          <p className="p-3 text-xs text-faint">Only the first 5,000 items are shown.</p>
        )}
      </FileTable>
      {listing && (
        <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-3 text-xs whitespace-nowrap text-faint">
          <span className="min-w-0 flex-1 truncate">
            {folderCount} folder{folderCount === 1 ? '' : 's'}, {fileCount} file
            {fileCount === 1 ? '' : 's'} · {formatSize(filesSize)}
            {chosen.length > 0 ? ` · ${chosen.length} selected` : ''}
          </span>
        </div>
      )}
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80">
          <p className="text-sm font-medium text-fg">Drop to download here</p>
        </div>
      )}
      {menu}
    </section>
  )
}
