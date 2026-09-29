import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import {
  ArrowUp,
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
  RotateCcw,
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
import { Button, cx, IconButton, Input, Modal, Notice, Select } from '../components/ui'
import { useSettings } from '../stores/settings'

/** Sửa file lớn hơn thế này qua editor thường là nhầm (log, file nhị phân) — gợi ý tải về. */
const MAX_EDIT_BYTES = 50 * 1024 * 1024

/** Bỏ tiền tố "Error invoking remote method '…': Error: " của Electron. */
function cleanError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

type Sort = 'name' | 'size' | 'mtime'

type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: SftpEntry }
  | { kind: 'chmod'; entry: SftpEntry }
  | { kind: 'delete'; entry: SftpEntry }
  | null

export function SftpPanel({
  run,
  transfers,
  connected
}: {
  run: (op: SftpOp) => Promise<unknown>
  transfers: TransferStatus[]
  connected: boolean
}): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [listing, setListing] = useState<SftpListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<Sort>('name')
  const [selected, setSelected] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dragOver, setDragOver] = useState(false)
  /** Tên file đang tải về để mở trong editor. */
  const [opening, setOpening] = useState<string | null>(null)
  const doubleClick = useSettings((s) => s.settings.files.doubleClick)
  const lastDone = useRef(0)

  const load = useCallback(
    async (target: string) => {
      setLoading(true)
      setError(null)
      try {
        const result = (await run({ op: 'list', path: target })) as SftpListing
        setListing(result)
        setPath(result.path)
        setPathInput(result.path)
        setSelected(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
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
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
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
      setError(e instanceof Error ? e.message : String(e))
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

  /** Tải cả thư mục về máy; đích đã có thư mục cùng tên → hỏi gộp. */
  const downloadFolder = async (entry: SftpEntry): Promise<void> => {
    if (!path) return
    const parent = await window.shellhouse.pickFolder(
      'Choose where to save the folder',
      'downloads'
    )
    if (!parent) return
    const remotePath = joinRemote(path, entry.name)
    setError(null)
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

  const download = async (entry: SftpEntry): Promise<void> => {
    if (!path) return
    if (entry.isDirLike) {
      await downloadFolder(entry)
      return
    }
    const target = await window.shellhouse.pickSaveLocation(entry.name)
    if (!target) return
    // The system save dialog already asked about overwriting.
    await act({
      op: 'download',
      remotePath: joinRemote(path, entry.name),
      localPath: target,
      overwrite: true
    })
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

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(false)
    const paths = [...event.dataTransfer.files]
      .map((f) => window.shellhouse.pathForFile(f))
      .filter(Boolean)
    void upload(paths)
  }

  const entries = (listing?.entries ?? [])
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirLike !== b.isDirLike) return a.isDirLike ? -1 : 1
      if (sort === 'size') return b.size - a.size
      if (sort === 'mtime') return b.mtime - a.mtime
      return a.name.localeCompare(b.name)
    })
  const selectedEntry = entries.find((e) => e.name === selected) ?? null

  return (
    <aside
      className={cx(
        'animate-slide-in-right flex w-96 shrink-0 flex-col border-l border-line bg-surface',
        dragOver && 'ring-2 ring-accent ring-inset'
      )}
      data-testid="sftp-panel"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => {
        setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1 border-b border-line p-2">
        <IconButton
          label="Parent folder"
          disabled={!path}
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
            data-testid="sftp-path"
            spellCheck={false}
            value={pathInput}
            onChange={(e) => {
              setPathInput(e.target.value)
            }}
          />
        </form>
        <IconButton label="Refresh" onClick={() => path && void load(path)}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          icon={<Upload size={13} />}
          data-testid="sftp-upload"
          disabled={!path}
          onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
        >
          Upload
        </Button>
        <IconButton
          label="Upload a folder"
          size="sm"
          className="size-7"
          data-testid="sftp-upload-folder"
          disabled={!path}
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
          data-testid="sftp-mkdir"
          disabled={!path}
          onClick={() => {
            setDialog({ kind: 'mkdir' })
          }}
        >
          New folder
        </Button>
        <div className="flex-1" />
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
        <Select
          className="h-7 w-28 text-xs"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as Sort)
          }}
          aria-label="Sort by"
        >
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="mtime">Modified</option>
        </Select>
      </div>

      {error && (
        <div className="border-b border-line p-2">
          <Notice tone="danger" testId="sftp-error">
            {error}
          </Notice>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto" role="listbox" aria-label="Files">
        {!connected && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <FolderOpen size={20} className="text-faint" />
            <p className="text-xs text-muted">Waiting for the connection…</p>
          </div>
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
          <p className="px-4 py-10 text-center text-xs text-faint">This folder is empty.</p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.name}
            role="option"
            aria-selected={selected === entry.name}
            data-testid="sftp-entry"
            data-name={entry.name}
            className={cx(
              'flex h-8 cursor-default items-center gap-2.5 px-3 text-[13px] transition-colors duration-75',
              selected === entry.name ? 'bg-accent-soft' : 'hover:bg-hover'
            )}
            onClick={() => {
              setSelected(entry.name)
            }}
            onDoubleClick={() => {
              if (entry.isDirLike && path) void load(joinRemote(path, entry.name))
              else if (doubleClick === 'edit') void edit(entry)
              else void download(entry)
            }}
          >
            <span className="text-muted">
              {entry.isDirLike ? (
                <Folder size={15} className="text-accent" />
              ) : entry.type === 'link' ? (
                <Link2 size={15} />
              ) : (
                <File size={15} />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {opening === entry.name && (
              <Loader2 size={13} className="animate-spin text-muted" aria-label="Opening" />
            )}
            <span className="w-16 text-right text-xs text-faint tabular-nums">
              {entry.isDirLike ? '' : formatSize(entry.size)}
            </span>
            <span className="hidden w-20 font-mono text-[11px] text-faint lg:inline">
              {formatMode(entry.mode)}
            </span>
          </div>
        ))}
      </div>

      {selectedEntry && (
        <div className="flex items-center gap-1 border-t border-line px-2 py-1.5">
          {!selectedEntry.isDirLike && (
            <Button
              size="sm"
              variant="ghost"
              icon={<FilePen size={13} />}
              data-testid="sftp-edit"
              title="Open in your editor — every save is uploaded to the server"
              disabled={opening !== null}
              onClick={() => void edit(selectedEntry)}
            >
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Download size={13} />}
            data-testid="sftp-download"
            title={selectedEntry.isDirLike ? 'Download the whole folder' : undefined}
            onClick={() => void download(selectedEntry)}
          >
            Download
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Pencil size={13} />}
            onClick={() => {
              setDialog({ kind: 'rename', entry: selectedEntry })
            }}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<ShieldCheck size={13} />}
            onClick={() => {
              setDialog({ kind: 'chmod', entry: selectedEntry })
            }}
          >
            Permissions
          </Button>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="danger-ghost"
            icon={<Trash2 size={13} />}
            data-testid="sftp-delete"
            onClick={() => {
              setDialog({ kind: 'delete', entry: selectedEntry })
            }}
          >
            Delete
          </Button>
        </div>
      )}

      {transfers.length > 0 && (
        <div
          className="max-h-52 overflow-auto border-t border-line p-2.5"
          data-testid="sftp-transfers"
        >
          <div className="mb-1.5 flex items-center text-xs font-medium text-muted">
            <span className="flex-1">Transfers</span>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-fg"
              onClick={() => void act({ op: 'clearDone' })}
            >
              Clear finished
            </button>
          </div>
          {transfers.map((t) => {
            const pct =
              t.size > 0 ? Math.floor((t.transferred / t.size) * 100) : t.state === 'done' ? 100 : 0
            return (
              <div
                key={t.id}
                className="mb-2 text-xs"
                data-testid="transfer-row"
                data-state={t.state}
              >
                <div className="flex items-center gap-1.5">
                  {t.direction === 'upload' ? (
                    <Upload size={12} className="text-muted" />
                  ) : (
                    <Download size={12} className="text-muted" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{baseName(t.remotePath)}</span>
                  <span className="text-faint">
                    {t.state === 'running' && `${pct}% · ${formatSize(t.bytesPerSecond)}/s`}
                    {t.state === 'queued' && 'Queued'}
                    {t.state === 'done' &&
                      (t.edit ? 'Saved to server' : `Done${t.resumedFrom > 0 ? ' (resumed)' : ''}`)}
                    {t.state === 'cancelled' && 'Cancelled'}
                    {t.state === 'error' && 'Failed'}
                  </span>
                  {(t.state === 'running' || t.state === 'queued') && (
                    <IconButton
                      label="Cancel"
                      size="sm"
                      onClick={() => void act({ op: 'cancel', transferId: t.id })}
                    >
                      <X size={12} />
                    </IconButton>
                  )}
                  {(t.state === 'error' || t.state === 'cancelled') && (
                    <IconButton
                      label="Retry (resumes where it stopped)"
                      size="sm"
                      onClick={() => void act({ op: 'retry', transferId: t.id })}
                    >
                      <RotateCcw size={12} />
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
      )}

      {dialog && path && (
        <EntryDialog
          dialog={dialog}
          onClose={() => {
            setDialog(null)
          }}
          onSubmit={async (value) => {
            let ok = false
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
              ok = await act({
                op: 'remove',
                path: joinRemote(path, dialog.entry.name),
                recursive: dialog.entry.type === 'dir'
              })
            if (ok) {
              setDialog(null)
              await load(path)
            }
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
    if (!invalid) void onSubmit(value.trim())
  }
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
            disabled={invalid}
            data-testid="sftp-dialog-submit"
            onClick={submit}
          >
            {dialog.kind === 'delete' ? 'Delete' : 'OK'}
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
          <p className="text-[13px]">
            Delete <strong>{dialog.entry.name}</strong>
            {dialog.entry.type === 'dir' ? ' and EVERYTHING inside it' : ''}? This cannot be undone.
          </p>
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
