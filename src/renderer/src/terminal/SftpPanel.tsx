import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from 'react'
import {
  ArrowUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FilePen,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import {
  baseName,
  FOLDER_EXISTS,
  formatMode,
  joinRemote,
  parentRemote,
  type SftpEntry,
  type SftpListing,
  type SftpOp,
  type TransferStatus
} from '@shared/sftp'
import { Button, cx, IconButton, Input, Modal, Notice } from '../components/ui'
import { replaceUnsafeFileChars } from '@shared/file-names'
import { DRAG_LOCAL, DRAG_REMOTE, joinLocal } from '@shared/local-files'
import { useSettings } from '../stores/settings'
import { useContextMenu, type MenuEntry } from '../components/ContextMenu'
import { SortMenu, usePersistentSort } from '../components/SortMenu'
import { FileTable, type FileColumn } from '../components/files/FileTable'
import { Empty, ToolButton } from '../components/files/parts'
import { TransferList } from '../components/files/TransferList'
import { cleanError, dateFormat, formatSize } from '../lib/format'
import { FILE_SORT_KEYS, FILE_SORT_OPTIONS, nameOrder, type FileSort } from './file-sort'

/** Sửa file lớn hơn thế này qua editor thường là nhầm (log, file nhị phân) — gợi ý tải về. */
const MAX_EDIT_BYTES = 50 * 1024 * 1024

type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: SftpEntry }
  | { kind: 'chmod'; entry: SftpEntry }
  | { kind: 'delete'; entries: SftpEntry[] }
  | null

/** Thao tác khung Local (SFTP hai cột) gọi sang khung Remote. */
export interface SftpActions {
  /** Tải lên thư mục remote đang mở. */
  upload(localPaths: string[]): Promise<void>
  /** Tải các mục của thư mục remote đang mở về thư mục local đang mở. */
  downloadByNames(names: string[]): Promise<void>
}

/** Thư mục local đang mở ở khung bên cạnh (SFTP hai cột): tải về thẳng vào đây, không hỏi chỗ lưu. */
export interface LocalTarget {
  dir: string
  sep: string
  names: ReadonlySet<string>
}

const [NAME_SORT, SIZE_SORT, MTIME_SORT] = FILE_SORT_OPTIONS

/** Cột: Size luôn có; Modified / Permissions hiện khi khung đủ rộng. */
const GRID =
  'grid-cols-[minmax(0,1fr)_4.5rem] @md:grid-cols-[minmax(0,1fr)_4.5rem_8.5rem] @2xl:grid-cols-[minmax(0,1fr)_4.5rem_8.5rem_5.5rem]'

const COLUMNS: FileColumn<SftpEntry, FileSort>[] = [
  {
    id: 'size',
    label: 'Size',
    sort: SIZE_SORT,
    align: 'right',
    render: (e) => (e.isDirLike ? '' : formatSize(e.size))
  },
  {
    id: 'mtime',
    label: 'Modified',
    sort: MTIME_SORT,
    className: 'hidden @md:block',
    render: (e) => (e.mtime ? dateFormat.format(new Date(e.mtime)) : '')
  },
  {
    id: 'mode',
    label: 'Permissions',
    className: 'hidden @2xl:block font-mono',
    render: (e) => formatMode(e.mode)
  }
]

export function SftpPanel({
  run,
  transfers,
  connected,
  layout = 'side',
  localTarget,
  actionsRef
}: {
  run: (op: SftpOp) => Promise<unknown>
  transfers: TransferStatus[]
  connected: boolean
  /** 'side' = cột bên phải terminal; 'pane' = một nửa của trình quản lý file hai cột. */
  layout?: 'side' | 'pane'
  localTarget?: LocalTarget | undefined
  actionsRef?: RefObject<SftpActions | null>
}): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [listing, setListing] = useState<SftpListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = usePersistentSort<FileSort>('sftp-remote', FILE_SORT_KEYS, {
    key: 'name',
    dir: 'asc'
  })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dragOver, setDragOver] = useState(false)
  /** Tên file đang tải về để mở trong editor. */
  const [opening, setOpening] = useState<string | null>(null)
  const doubleClick = useSettings((s) => s.settings.files.doubleClick)
  const lastDone = useRef(0)
  const { menu, open: openMenu } = useContextMenu()

  const load = useCallback(
    async (target: string) => {
      setLoading(true)
      setError(null)
      try {
        const result = (await run({ op: 'list', path: target })) as SftpListing
        setListing(result)
        setPath(result.path)
        setPathInput(result.path)
        setSelected(new Set())
      } catch (e) {
        setError(cleanError(e))
      } finally {
        setLoading(false)
      }
    },
    [run]
  )

  // Open the home directory once connected.
  useEffect(() => {
    if (!connected || path !== null) return
    let cancelled = false
    void run({ op: 'realpath', path: '.' }).then(
      (home) => {
        if (!cancelled) void load(home as string)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [connected, path, run, load])

  // Refresh after an upload finishes.
  const doneUploads = transfers.filter((t) => t.direction === 'upload' && t.state === 'done').length
  useEffect(() => {
    if (doneUploads > lastDone.current && path) void load(path)
    lastDone.current = doneUploads
  }, [doneUploads, path, load])

  const act = async (op: SftpOp): Promise<boolean> => {
    try {
      await run(op)
      return true
    } catch (e) {
      setError(cleanError(e))
      return false
    }
  }

  const upload = async (localPaths: string[]): Promise<void> => {
    if (!path) return
    const names = new Set(listing?.entries.map((e) => e.name))
    for (const local of localPaths) {
      const name = baseName(local)
      const overwrite =
        names.has(name) && window.confirm(`“${name}” already exists on the server. Overwrite it?`)
      if (names.has(name) && !overwrite) continue
      await act({ op: 'upload', localPath: local, remotePath: joinRemote(path, name), overwrite })
    }
    // Thư mục được tạo ngay (file thì chờ tải xong) → hiện luôn.
    if (localPaths.length > 0) await load(path)
  }

  /** Tải cả thư mục về `parent`; đích đã có thư mục cùng tên → hỏi gộp. */
  const downloadFolder = async (entry: SftpEntry, parent: string): Promise<void> => {
    if (!path) return
    const remotePath = joinRemote(path, entry.name)
    try {
      await run({ op: 'downloadFolder', remotePath, localParent: parent, overwrite: false })
    } catch (e) {
      const message = cleanError(e)
      if (message !== FOLDER_EXISTS) {
        setError(message)
        return
      }
      if (window.confirm(`“${entry.name}” already exists there. Merge and overwrite files?`))
        await act({ op: 'downloadFolder', remotePath, localParent: parent, overwrite: true })
    }
  }

  /**
   * Tải về: hai cột → thẳng vào thư mục local đang mở; một file → hỏi chỗ lưu; nhiều mục / thư
   * mục → hỏi thư mục đích một lần.
   */
  const download = async (list: SftpEntry[]): Promise<void> => {
    if (!path || list.length === 0) return
    setError(null)
    const only = list[0]
    if (!localTarget && list.length === 1 && only && !only.isDirLike) {
      const target = await window.shellhouse.pickSaveLocation(only.name)
      // The system save dialog already asked about overwriting.
      if (target)
        await act({
          op: 'download',
          remotePath: joinRemote(path, only.name),
          localPath: target,
          overwrite: true
        })
      return
    }
    const dir =
      localTarget?.dir ?? (await window.shellhouse.pickFolder('Choose where to save', 'downloads'))
    if (!dir) return
    const sep = localTarget?.sep ?? (await window.shellhouse.listLocal(dir)).sep
    const existing = localTarget?.names ?? new Set<string>()
    for (const entry of list) {
      if (entry.isDirLike) {
        await downloadFolder(entry, dir)
        continue
      }
      const safe = replaceUnsafeFileChars(entry.name)
      if (
        existing.has(safe) &&
        !window.confirm(`“${entry.name}” already exists in ${dir}. Overwrite it?`)
      )
        continue
      await act({
        op: 'download',
        remotePath: joinRemote(path, entry.name),
        localPath: joinLocal(dir, safe, sep),
        overwrite: true
      })
    }
  }

  /** Mở bằng editor trên máy; mỗi lần lưu, session host tự tải lên (xem session-host/sftp/edit.ts). */
  const edit = async (entry: SftpEntry): Promise<void> => {
    if (!path) return
    if (entry.size > MAX_EDIT_BYTES) {
      setError(
        `“${entry.name}” is too large to edit (${formatSize(entry.size)}). Download it instead.`
      )
      return
    }
    setError(null)
    setOpening(entry.name)
    try {
      const localPath = await window.shellhouse.prepareRemoteEdit(entry.name)
      await run({ op: 'edit', remotePath: joinRemote(path, entry.name), localPath })
      await window.shellhouse.openInEditor(localPath)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setOpening(null)
    }
  }

  const open = (entry: SftpEntry): void => {
    if (entry.isDirLike && path) void load(joinRemote(path, entry.name))
    else if (doubleClick === 'edit') void edit(entry)
    else void download([entry])
  }

  // Khung Local gọi sang (nút "Upload →", kéo thả, bấm đúp).
  const actions: SftpActions = {
    upload,
    downloadByNames: async (names) => {
      const wanted = new Set(names)
      await download((listing?.entries ?? []).filter((e) => wanted.has(e.name)))
    }
  }
  useEffect(() => {
    if (actionsRef) actionsRef.current = actions
  })

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(false)
    const fromLocal = event.dataTransfer.getData(DRAG_LOCAL)
    if (fromLocal) {
      void upload(JSON.parse(fromLocal) as string[])
      return
    }
    const paths = [...event.dataTransfer.files]
      .map((f) => window.shellhouse.pathForFile(f))
      .filter(Boolean)
    void upload(paths)
  }

  const entries = (listing?.entries ?? [])
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirLike !== b.isDirLike) return a.isDirLike ? -1 : 1
      const by =
        sort.key === 'size' && !a.isDirLike
          ? a.size - b.size
          : sort.key === 'mtime'
            ? a.mtime - b.mtime
            : 0
      return (by || nameOrder.compare(a.name, b.name)) * (sort.dir === 'asc' ? 1 : -1)
    })
  const chosen = entries.filter((e) => selected.has(e.name))
  const one = chosen.length === 1 ? chosen[0] : undefined
  const fileCount = entries.filter((e) => !e.isDirLike).length
  const folderCount = entries.length - fileCount
  const filesSize = entries.reduce((n, e) => n + (e.isDirLike ? 0 : e.size), 0)

  const entryMenu = (list: SftpEntry[]): MenuEntry[] => {
    const single = list.length === 1 ? list[0] : undefined
    const items: MenuEntry[] = []
    if (single?.isDirLike)
      items.push({
        id: 'sftp-open',
        label: 'Open',
        icon: <FolderOpen size={14} />,
        onSelect: () => {
          open(single)
        }
      })
    if (single && !single.isDirLike)
      items.push({
        id: 'sftp-edit',
        label: 'Edit in local editor',
        icon: <FilePen size={14} />,
        onSelect: () => void edit(single)
      })
    items.push(
      {
        id: 'sftp-download',
        label: list.length > 1 ? `Download ${list.length} items…` : 'Download…',
        icon: <Download size={14} />,
        onSelect: () => void download(list)
      },
      'separator'
    )
    if (single && path)
      items.push(
        {
          id: 'sftp-rename',
          label: 'Rename…',
          icon: <Pencil size={14} />,
          hint: 'F2',
          onSelect: () => {
            setDialog({ kind: 'rename', entry: single })
          }
        },
        {
          id: 'sftp-chmod',
          label: 'Permissions…',
          icon: <ShieldCheck size={14} />,
          onSelect: () => {
            setDialog({ kind: 'chmod', entry: single })
          }
        },
        {
          id: 'sftp-copy-path',
          label: 'Copy path',
          icon: <Copy size={14} />,
          onSelect: () => void window.shellhouse.writeClipboard(joinRemote(path, single.name))
        }
      )
    items.push('separator', {
      id: 'sftp-delete',
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

  return (
    <aside
      className={cx(
        '@container relative flex min-w-0 flex-col bg-surface',
        layout === 'side'
          ? 'animate-slide-in-right w-96 shrink-0 border-l border-line'
          : 'min-w-0 flex-1'
      )}
      data-testid="sftp-panel"
      aria-label="Remote files"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DRAG_LOCAL)) {
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
        {layout === 'pane' && (
          <span className="flex shrink-0 items-center gap-1.5 px-1 text-xs font-medium text-muted">
            <Server size={14} /> <span className="hidden @md:inline">Remote</span>
          </span>
        )}
        <IconButton
          label="Parent folder (Backspace)"
          disabled={!path || path === '/'}
          onClick={() => path && void load(parentRemote(path))}
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
            aria-label="Remote path"
            data-testid="sftp-path"
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
          data-testid="sftp-toggle-hidden"
          className="size-7"
          onClick={() => {
            setShowHidden(!showHidden)
          }}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>
        <SortMenu options={FILE_SORT_OPTIONS} sort={sort} onChange={setSort} testId="sftp-sort" />
        <IconButton label="Refresh" onClick={() => path && void load(path)}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>

      <div
        className="flex h-10 shrink-0 items-center gap-0.5 overflow-hidden border-b border-line px-2"
        role="toolbar"
        aria-label="Remote actions"
      >
        <ToolButton
          icon={<Upload size={14} />}
          label="Upload"
          labelAt="md"
          testId="sftp-upload"
          disabled={!path}
          onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
        />
        <ToolButton
          icon={<FolderUp size={14} />}
          label="Upload folder"
          labelAt="5xl"
          testId="sftp-upload-folder"
          disabled={!path}
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
          testId="sftp-mkdir"
          disabled={!path}
          onClick={() => {
            setDialog({ kind: 'mkdir' })
          }}
        />
        <span className="flex-1" />
        {chosen.length > 0 && (
          <>
            {one && !one.isDirLike && (
              <ToolButton
                icon={
                  opening === one.name ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <FilePen size={14} />
                  )
                }
                label={opening ? 'Opening…' : 'Edit'}
                labelAt="3xl"
                testId="sftp-edit"
                disabled={opening !== null}
                onClick={() => void edit(one)}
              />
            )}
            <ToolButton
              icon={<Download size={14} />}
              label={chosen.length > 1 ? `Download ${chosen.length}` : 'Download'}
              labelAt="xl"
              testId="sftp-download"
              onClick={() => void download(chosen)}
            />
            {one && (
              <>
                <ToolButton
                  icon={<Pencil size={14} />}
                  label="Rename"
                  labelAt="5xl"
                  testId="sftp-rename"
                  onClick={() => {
                    setDialog({ kind: 'rename', entry: one })
                  }}
                />
                <ToolButton
                  icon={<ShieldCheck size={14} />}
                  label="Permissions"
                  labelAt="5xl"
                  testId="sftp-chmod"
                  onClick={() => {
                    setDialog({ kind: 'chmod', entry: one })
                  }}
                />
              </>
            )}
            <span className="mx-1 h-4 w-px shrink-0 bg-line" />
            <ToolButton
              icon={<Trash2 size={14} />}
              label="Delete"
              labelAt="3xl"
              testId="sftp-delete"
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
            <Notice tone="danger" testId="sftp-error">
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
          e.isDirLike ? (
            <Folder size={15} className="shrink-0 text-accent" />
          ) : e.type === 'link' ? (
            <Link2 size={15} className="shrink-0 text-muted" />
          ) : (
            <File size={15} className="shrink-0 text-muted" />
          )
        }
        badge={(e) =>
          opening === e.name ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-muted" aria-label="Opening" />
          ) : null
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
          if (path && path !== '/') void load(parentRemote(path))
        }}
        onRename={(e) => {
          setDialog({ kind: 'rename', entry: e })
        }}
        onDelete={(list) => {
          setDialog({ kind: 'delete', entries: list })
        }}
        onContextMenu={(e, list) => {
          openMenu(e, entryMenu(list))
        }}
        rowProps={(entry) =>
          layout === 'pane'
            ? {
                draggable: true,
                onDragStart: (e) => {
                  // Kéo nhiều mục đang chọn sang khung Local.
                  const names = selected.has(entry.name) ? [...selected] : [entry.name]
                  e.dataTransfer.setData(DRAG_REMOTE, JSON.stringify(names))
                  e.dataTransfer.effectAllowed = 'copy'
                }
              }
            : {}
        }
        ariaLabel="Remote files"
        rowTestId="sftp-entry"
      >
        {!connected && (
          <Empty
            icon={<Server size={20} />}
            title="Waiting for the connection…"
            text="Files appear as soon as the server is connected."
            action={null}
          />
        )}
        {connected && loading && !listing && (
          <div aria-label="Loading" className="space-y-1 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex animate-pulse items-center gap-2.5 py-1">
                <span className="size-4 rounded bg-subtle" />
                <span
                  className="h-3 rounded bg-subtle"
                  style={{ width: `${40 + ((i * 37) % 45)}%` }}
                />
              </div>
            ))}
          </div>
        )}
        {connected && listing && entries.length === 0 && (
          <Empty
            icon={<FolderOpen size={20} />}
            title="This folder is empty"
            text="Drop files here, or upload from your computer."
            action={
              <Button
                size="sm"
                icon={<Upload size={13} />}
                onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
              >
                Upload files
              </Button>
            }
          />
        )}
      </FileTable>

      {listing && (
        <div
          className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-line px-3 text-xs whitespace-nowrap text-faint"
          data-testid="sftp-status"
        >
          <span className="min-w-0 flex-1 truncate">
            {folderCount} folder{folderCount === 1 ? '' : 's'}, {fileCount} file
            {fileCount === 1 ? '' : 's'} · {formatSize(filesSize)}
            {chosen.length > 0 ? ` · ${chosen.length} selected` : ''}
          </span>
        </div>
      )}

      <TransferList
        transfers={transfers}
        testId="sftp-transfers"
        rowTestId="transfer-row"
        onCancel={(id) => void act({ op: 'cancel', transferId: id })}
        onRetry={(id) => void act({ op: 'retry', transferId: id })}
        onClear={() => void act({ op: 'clearDone' })}
      />

      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            <Upload size={16} className="text-accent" />
            Drop to upload
          </p>
        </div>
      )}

      {menu}
      {dialog && path && (
        <EntryDialog
          dialog={dialog}
          onClose={() => {
            setDialog(null)
          }}
          onSubmit={async (value) => {
            let ok = true
            if (dialog.kind === 'mkdir')
              ok = await act({ op: 'mkdir', path: joinRemote(path, value) })
            if (dialog.kind === 'rename')
              ok = await act({
                op: 'rename',
                from: joinRemote(path, dialog.entry.name),
                to: joinRemote(path, value)
              })
            if (dialog.kind === 'chmod')
              ok = await act({
                op: 'chmod',
                path: joinRemote(path, dialog.entry.name),
                mode: parseInt(value, 8)
              })
            if (dialog.kind === 'delete')
              for (const entry of dialog.entries) {
                ok = await act({
                  op: 'remove',
                  path: joinRemote(path, entry.name),
                  recursive: entry.type === 'dir'
                })
                if (!ok) break
              }
            if (ok) setDialog(null)
            await load(path)
          }}
        />
      )}
    </aside>
  )
}

function EntryDialog({
  dialog,
  onClose,
  onSubmit
}: {
  dialog: NonNullable<Dialog>
  onClose: () => void
  onSubmit: (value: string) => Promise<void>
}): React.JSX.Element {
  const initial =
    dialog.kind === 'rename'
      ? dialog.entry.name
      : dialog.kind === 'chmod'
        ? (dialog.entry.mode & 0o777).toString(8).padStart(3, '0')
        : ''
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const titles = {
    mkdir: 'New folder',
    rename: 'Rename',
    chmod: 'Change permissions',
    delete: 'Delete'
  } as const
  const invalid =
    dialog.kind === 'chmod'
      ? !/^[0-7]{3,4}$/.test(value)
      : dialog.kind !== 'delete' &&
        (!value.trim() || value.includes('/') || value === '.' || value === '..')
  const submit = (): void => {
    if (invalid || busy) return
    setBusy(true)
    void onSubmit(value.trim()).finally(() => {
      setBusy(false)
    })
  }
  const folders = dialog.kind === 'delete' ? dialog.entries.filter((e) => e.type === 'dir') : []
  return (
    <Modal
      title={titles[dialog.kind]}
      onClose={onClose}
      width="max-w-sm"
      testId="sftp-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={dialog.kind === 'delete' ? 'danger' : 'primary'}
            disabled={invalid || busy}
            data-testid="sftp-dialog-submit"
            onClick={submit}
          >
            {dialog.kind === 'delete' ? (busy ? 'Deleting…' : 'Delete') : 'OK'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {dialog.kind === 'delete' ? (
          <>
            <p className="text-[13px]">
              {dialog.entries.length === 1 ? (
                <>
                  Delete <strong className="break-all">{dialog.entries[0]?.name}</strong>
                  {folders.length > 0 ? ' and everything inside it' : ''}?
                </>
              ) : (
                <>
                  Delete these {dialog.entries.length} items
                  {folders.length > 0 ? ', including everything inside the folders' : ''}?
                </>
              )}
            </p>
            {dialog.entries.length > 1 && (
              <ul className="max-h-32 overflow-auto rounded-md border border-line bg-subtle px-2.5 py-1.5 font-mono text-xs text-muted">
                {dialog.entries.slice(0, 50).map((e) => (
                  <li key={e.name} className="flex items-center gap-1.5 truncate py-0.5">
                    {e.isDirLike ? (
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
        ) : (
          <Input
            autoFocus
            mono
            data-testid="sftp-dialog-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
            }}
            placeholder={dialog.kind === 'chmod' ? '755' : 'name'}
          />
        )}
        {dialog.kind === 'chmod' && (
          <p className="text-xs text-faint">Octal, for example 644 or 755.</p>
        )}
      </form>
    </Modal>
  )
}
