import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowRight, ArrowUp, Eye, EyeOff, File, Folder, Laptop, RefreshCw } from 'lucide-react'
import { DRAG_LOCAL, DRAG_REMOTE, joinLocal, type LocalListing } from '@shared/local-files'
import type { TransferStatus } from '@shared/sftp'
import { Button, cx, IconButton, Input, Notice } from '../components/ui'
import type { LocalTarget, SftpActions } from './SftpPanel'

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function cleanError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
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
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [dragOver, setDragOver] = useState(false)
  const lastDone = useRef(0)

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

  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith('.'))
  const pathsOf = (names: Iterable<string>): string[] =>
    listing ? [...names].map((n) => joinLocal(listing.path, n, listing.sep)) : []

  const uploadSelected = (): void => {
    void actionsRef.current?.upload(pathsOf(selected))
  }

  return (
    <section
      className={cx(
        'flex min-w-0 flex-1 flex-col border-r border-line bg-surface',
        dragOver && 'ring-2 ring-accent ring-inset'
      )}
      data-testid="local-panel"
      aria-label="Local files"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_REMOTE)) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => {
        setDragOver(false)
      }}
      onDrop={(e) => {
        setDragOver(false)
        const name = e.dataTransfer.getData(DRAG_REMOTE)
        if (!name) return
        e.preventDefault()
        void actionsRef.current?.downloadByName(name)
      }}
    >
      <div className="flex items-center gap-1 border-b border-line p-2">
        <span className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted">
          <Laptop size={14} /> Local
        </span>
        <IconButton
          label="Parent folder"
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
            data-testid="local-path"
            spellCheck={false}
            value={pathInput}
            onChange={(e) => {
              setPathInput(e.target.value)
            }}
          />
        </form>
        <IconButton label="Refresh" onClick={() => listing && void load(listing.path)}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowRight size={13} />}
          data-testid="local-upload"
          disabled={selected.size === 0}
          title="Upload the selected items to the remote folder"
          onClick={uploadSelected}
        >
          Upload{selected.size > 1 ? ` ${selected.size}` : ''}
        </Button>
        <div className="flex-1" />
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
      </div>
      {error && (
        <div className="border-b border-line p-2">
          <Notice tone="danger" testId="local-error">
            {error}
          </Notice>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto" role="listbox" aria-label="Local files">
        {listing && entries.length === 0 && (
          <p className="px-4 py-10 text-center text-xs text-faint">This folder is empty.</p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.name}
            role="option"
            aria-selected={selected.has(entry.name)}
            data-testid="local-entry"
            data-name={entry.name}
            draggable
            className={cx(
              'flex h-8 cursor-default items-center gap-2.5 px-3 text-[13px] transition-colors duration-75',
              selected.has(entry.name) ? 'bg-accent-soft' : 'hover:bg-hover'
            )}
            onClick={(e) => {
              // Ctrl/⌘ + click: chọn nhiều.
              if (e.ctrlKey || e.metaKey) {
                const next = new Set(selected)
                if (next.has(entry.name)) next.delete(entry.name)
                else next.add(entry.name)
                setSelected(next)
              } else setSelected(new Set([entry.name]))
            }}
            onDoubleClick={() => {
              if (listing && entry.isDir)
                void load(joinLocal(listing.path, entry.name, listing.sep))
              else void actionsRef.current?.upload(pathsOf([entry.name]))
            }}
            onDragStart={(e) => {
              const names = selected.has(entry.name) ? selected : [entry.name]
              e.dataTransfer.setData(DRAG_LOCAL, JSON.stringify(pathsOf(names)))
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            {entry.isDir ? (
              <Folder size={15} className="shrink-0 text-accent" />
            ) : (
              <File size={15} className="shrink-0 text-muted" />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="w-16 text-right text-xs text-faint tabular-nums">
              {entry.isDir ? '' : formatSize(entry.size)}
            </span>
          </div>
        ))}
        {listing?.truncated && (
          <p className="p-3 text-xs text-faint">Only the first 5000 items are shown.</p>
        )}
      </div>
    </section>
  )
}
