import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Download,
  File,
  FileSymlink,
  Folder,
  FolderUp,
  RefreshCw,
  Upload,
  X
} from 'lucide-react'
import { Button, cx, IconButton, Notice } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import {
  formatBytes,
  formatDateTime,
  formatRelative,
  nameCollator,
  t,
  tn,
  toast
} from '../../registry/renderer-kit'
import type {
  ContainerFileEntry,
  ContainerFileList,
  ContainerRow,
  CopyResult,
  DockerOp
} from '../shared/ops'

type Request = <T>(op: DockerOp, signal?: AbortSignal) => Promise<T>

/** "/a/b" + "c" → "/a/b/c"; ".." lên một cấp. */
export function joinPath(dir: string, name: string): string {
  if (name === '..') {
    const parts = dir.split('/').filter(Boolean)
    parts.pop()
    return `/${parts.join('/')}`
  }
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** Đường dẫn người dùng gõ → tuyệt đối, gọn ("a//b/./c/" → "/a/b/c"). */
export function cleanPath(input: string): string {
  const parts: string[] = []
  for (const p of input.trim().split('/')) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}

const isDir = (e: ContainerFileEntry): boolean => e.type === 'dir' || e.linkDir === true

/**
 * Tab "Files" của container: duyệt thư mục, tải file / thư mục về máy này, tải file lên (chọn file
 * hoặc kéo thả). Đọc bằng `sh` trong container; không có shell / đang dừng → đọc archive.
 */
export function FilesPanel({
  container,
  request,
  readOnly
}: {
  container: ContainerRow
  request: Request
  readOnly: boolean
}): React.JSX.Element {
  const [path, setPath] = useState('/')
  const [draft, setDraft] = useState('/')
  const [list, setList] = useState<ContainerFileList | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Lượt tải đã xong (đường dẫn + lần làm mới) — khác lượt hiện tại = đang tải. */
  const [loaded, setLoaded] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ label: string; abort: AbortController } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [tick, setTick] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const key = `${path}#${String(tick)}`
    request<ContainerFileList>({ op: 'files.list', id: container.id, path }).then(
      (r) => {
        if (cancelled) return
        setList(r)
        setError(null)
        setLoaded(key)
      },
      (e: unknown) => {
        if (cancelled) return
        setError(cleanError(e))
        setLoaded(key)
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, container.id, path, tick])

  const loading = loaded !== `${path}#${String(tick)}`

  const go = useCallback((next: string) => {
    const clean = cleanPath(next)
    setPath(clean)
    setDraft(clean)
    setSelected(new Set())
    setCursor(null)
  }, [])

  const entries = useMemo(
    () =>
      [...(list?.path === path ? list.entries : [])].sort(
        (a, b) => Number(isDir(b)) - Number(isDir(a)) || nameCollator().compare(a.name, b.name)
      ),
    [list, path]
  )

  const download = async (names: readonly string[]): Promise<void> => {
    if (names.length === 0 || busy) return
    const dir = await window.shellhouse.pickFolder(t('Choose where to save'), 'downloads')
    if (!dir) return
    const abort = new AbortController()
    setBusy({ label: t('Downloading…'), abort })
    try {
      const r = await request<CopyResult>(
        {
          op: 'files.download',
          id: container.id,
          paths: names.map((n) => joinPath(path, n)),
          localDir: dir
        },
        abort.signal
      )
      toast.success(
        tn(r.files, 'Downloaded {n} file ({size})', 'Downloaded {n} files ({size})', {
          size: formatBytes(r.bytes)
        }),
        {
          description:
            r.skipped > 0
              ? `${dir} · ${tn(r.skipped, '{n} link skipped', '{n} links skipped')}`
              : dir
        }
      )
    } catch (e) {
      if (!abort.signal.aborted) toast.error(t('Download failed'), { description: cleanError(e) })
    } finally {
      setBusy(null)
    }
  }

  const upload = async (localPaths: readonly string[]): Promise<void> => {
    if (localPaths.length === 0 || busy || readOnly) return
    const abort = new AbortController()
    setBusy({ label: t('Uploading…'), abort })
    try {
      const r = await request<CopyResult>(
        { op: 'files.upload', id: container.id, dir: path, localPaths: [...localPaths] },
        abort.signal
      )
      toast.success(
        tn(r.files, 'Uploaded {n} file to {path}', 'Uploaded {n} files to {path}', { path }),
        {
          description:
            r.skipped > 0
              ? `${formatBytes(r.bytes)} · ${tn(r.skipped, '{n} link skipped', '{n} links skipped')}`
              : formatBytes(r.bytes)
        }
      )
      setTick((n) => n + 1)
    } catch (e) {
      if (!abort.signal.aborted) toast.error(t('Upload failed'), { description: cleanError(e) })
    } finally {
      setBusy(null)
    }
  }

  const open = (e: ContainerFileEntry): void => {
    if (isDir(e)) go(joinPath(path, e.name))
  }

  const select = (
    name: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
  ): void => {
    setCursor(name)
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      setSelected(next)
    } else if (event.shiftKey && cursor) {
      const a = entries.findIndex((x) => x.name === cursor)
      const b = entries.findIndex((x) => x.name === name)
      const [from, to] = a < b ? [a, b] : [b, a]
      setSelected(new Set(entries.slice(from, to + 1).map((x) => x.name)))
    } else setSelected(new Set([name]))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const i = entries.findIndex((x) => x.name === cursor)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next =
        entries[Math.max(0, Math.min(entries.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) {
        setCursor(next.name)
        setSelected(new Set([next.name]))
      }
    } else if (e.key === 'Enter' && cursor) {
      const entry = entries[i]
      if (entry) {
        e.preventDefault()
        if (isDir(entry)) open(entry)
        else void download([entry.name])
      }
    } else if (e.key === 'Backspace' && path !== '/') {
      e.preventDefault()
      go(joinPath(path, '..'))
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelected(new Set(entries.map((x) => x.name)))
    }
  }

  const crumbs = path.split('/').filter(Boolean)

  return (
    <div
      className={cx('relative flex min-h-0 flex-1 flex-col text-xs', dragging && 'bg-accent-soft')}
      data-testid="docker-files"
      onDragOver={(e) => {
        if (readOnly || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        if (readOnly) return
        e.preventDefault()
        setDragging(false)
        const paths = [...e.dataTransfer.files]
          .map((f) => window.shellhouse.pathForFile(f))
          .filter(Boolean)
        void upload(paths)
      }}
    >
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <IconButton
          size="sm"
          label={t('Up one folder (Backspace)')}
          disabled={path === '/'}
          data-testid="docker-files-up"
          onClick={() => {
            go(joinPath(path, '..'))
          }}
        >
          <ArrowUp size={13} />
        </IconButton>
        <input
          aria-label={t('Folder in the container')}
          spellCheck={false}
          data-testid="docker-files-path"
          className="h-6 min-w-0 flex-1 rounded border border-line bg-surface px-1.5 font-mono text-[11px] text-fg outline-none focus:border-accent"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(draft)
            if (e.key === 'Escape') setDraft(path)
          }}
          onBlur={() => {
            setDraft(path)
          }}
        />
        <IconButton
          size="sm"
          label={t('Refresh')}
          data-testid="docker-files-refresh"
          onClick={() => {
            setTick((n) => n + 1)
          }}
        >
          <RefreshCw size={12} className={cx(loading && 'animate-spin')} />
        </IconButton>
        {!readOnly && (
          <>
            <IconButton
              size="sm"
              label={t('Upload files here')}
              disabled={busy !== null}
              data-testid="docker-files-upload"
              onClick={() => void window.shellhouse.pickFilesToUpload().then(upload)}
            >
              <Upload size={12} />
            </IconButton>
            <IconButton
              size="sm"
              label={t('Upload a folder here')}
              disabled={busy !== null}
              data-testid="docker-files-upload-folder"
              onClick={() =>
                void window.shellhouse
                  .pickFolder(t('Choose a folder to upload'), 'downloads')
                  .then((dir) => upload(dir ? [dir] : []))
              }
            >
              <FolderUp size={12} />
            </IconButton>
          </>
        )}
        <IconButton
          size="sm"
          label={t('Download selected (Enter)')}
          disabled={selected.size === 0 || busy !== null}
          data-testid="docker-files-download"
          onClick={() => void download([...selected])}
        >
          <Download size={12} />
        </IconButton>
      </div>
      <nav
        aria-label={t('Folder in the container')}
        className="flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1 text-[11px] text-muted"
      >
        <button
          type="button"
          className="hover:text-fg"
          onClick={() => {
            go('/')
          }}
        >
          /
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-0.5">
            {i > 0 && <span className="text-faint">/</span>}
            <button
              type="button"
              className={cx('hover:text-fg', i === crumbs.length - 1 && 'font-medium text-fg')}
              onClick={() => {
                go(`/${crumbs.slice(0, i + 1).join('/')}`)
              }}
            >
              {c}
            </button>
          </span>
        ))}
      </nav>
      {busy && (
        <div
          className="flex items-center gap-2 border-b border-line bg-subtle px-2 py-1"
          data-testid="docker-files-busy"
        >
          <RefreshCw size={12} className="animate-spin text-accent" />
          <span className="flex-1 text-muted">{busy.label}</span>
          <Button
            size="sm"
            variant="ghost"
            icon={<X size={12} />}
            onClick={() => {
              busy.abort.abort()
            }}
          >
            {t('Cancel')}
          </Button>
        </div>
      )}
      {list?.via === 'archive' && list.path === path && (
        <div className="border-b border-line p-2">
          <Notice tone="info" testId="docker-files-archive">
            {list.truncated
              ? t(
                  'This folder is too large to list completely without a shell — only part of it is shown.'
                )
              : container.state === 'running'
                ? t(
                    'This container has no shell, so the list was read from an archive of the folder (slower for large folders).'
                  )
                : t(
                    'The container is not running, so the list was read from an archive of the folder.'
                  )}
          </Notice>
        </div>
      )}
      {error && (
        <div className="border-b border-line p-2">
          <Notice tone="danger" testId="docker-files-error">
            {error}
          </Notice>
        </div>
      )}
      <div
        ref={listRef}
        role="grid"
        aria-label={t('Files in {path}', { path })}
        aria-multiselectable
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-inset"
        onKeyDown={onKeyDown}
      >
        {entries.length === 0 && !loading && !error && (
          <p className="p-4 text-center text-faint">{t('This folder is empty.')}</p>
        )}
        {entries.map((e) => {
          const sel = selected.has(e.name)
          return (
            <div
              key={e.name}
              role="row"
              aria-selected={sel}
              data-testid="docker-file"
              data-name={e.name}
              className={cx(
                'group grid cursor-default grid-cols-[1fr_4.5rem_5.5rem_1.5rem] items-center gap-2 px-2 py-1',
                sel ? 'bg-accent-soft' : 'hover:bg-hover',
                cursor === e.name && 'ring-1 ring-accent/30 ring-inset'
              )}
              onClick={(ev) => {
                select(e.name, ev)
              }}
              onDoubleClick={() => {
                if (isDir(e)) open(e)
                else void download([e.name])
              }}
            >
              <span className="flex min-w-0 items-center gap-1.5" role="gridcell">
                {e.type === 'dir' ? (
                  <Folder size={13} className="shrink-0 text-accent" />
                ) : e.type === 'link' ? (
                  <FileSymlink
                    size={13}
                    className={cx('shrink-0', e.linkDir ? 'text-accent' : 'text-muted')}
                  />
                ) : (
                  <File size={13} className="shrink-0 text-muted" />
                )}
                <span
                  className="truncate text-fg"
                  title={e.mode ? `${e.name} · ${e.mode}` : e.name}
                >
                  {e.name}
                </span>
              </span>
              <span role="gridcell" className="text-right text-muted tabular-nums">
                {e.size !== null ? formatBytes(e.size) : ''}
              </span>
              <span
                role="gridcell"
                className="truncate text-faint"
                title={e.mtime ? formatDateTime(e.mtime) : undefined}
              >
                {e.mtime ? formatRelative(e.mtime) : ''}
              </span>
              <span role="gridcell" className="flex justify-end">
                <button
                  type="button"
                  title={t('Download')}
                  aria-label={t('Download {name}', { name: e.name })}
                  data-testid="docker-file-download"
                  disabled={busy !== null}
                  className="rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 disabled:opacity-30"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void download([e.name])
                  }}
                >
                  <Download size={12} />
                </button>
              </span>
            </div>
          )
        })}
      </div>
      {!readOnly && (
        <div className="border-t border-line px-2 py-1 text-[11px] text-faint">
          {dragging
            ? t('Drop to upload into {path}', { path })
            : t('Drag files here to upload them into this folder.')}
        </div>
      )}
    </div>
  )
}
