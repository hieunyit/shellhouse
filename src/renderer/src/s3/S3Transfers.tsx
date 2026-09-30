import { useState } from 'react'
import { Ban, ChevronRight, CircleAlert, CircleCheck, Download, Upload, X } from 'lucide-react'
import type { TransferStatus } from '@shared/sftp'
import { cx, IconButton } from '../components/ui'
import { formatSize } from './format'

/** Danh sách truyền file của tab S3: gọn, thu lại được; chỉ lượt đang chạy mới có thanh tiến độ. */
export function S3Transfers({
  transfers,
  onCancel,
  onClear
}: {
  transfers: TransferStatus[]
  onCancel: (id: string) => void
  onClear: () => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  if (transfers.length === 0) return null

  const active = transfers.filter((t) => t.state === 'running' || t.state === 'queued')
  const done = transfers.filter((t) => t.state === 'done').length
  const failed = transfers.filter((t) => t.state === 'error').length
  const total = active.reduce((n, t) => n + t.size, 0)
  const moved = active.reduce((n, t) => n + t.transferred, 0)
  const summary = [
    active.length > 0 &&
      `${active.length} active${total > 0 ? ` · ${Math.floor((moved / total) * 100)}%` : ''}`,
    done > 0 && `${done} done`,
    failed > 0 && `${failed} failed`
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="shrink-0 border-t border-line bg-surface" data-testid="s3-transfers">
      <div className="flex h-8 items-center gap-2 pr-2 pl-2.5 text-xs">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium text-muted hover:text-fg"
          onClick={() => {
            setOpen(!open)
          }}
        >
          <ChevronRight
            size={13}
            className={cx('shrink-0 transition-transform duration-150', open && 'rotate-90')}
          />
          <span className="shrink-0">Transfers</span>
          <span className={cx('truncate font-normal', failed > 0 ? 'text-danger' : 'text-faint')}>
            {summary}
          </span>
        </button>
        {active.length < transfers.length && (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-fg"
            onClick={onClear}
          >
            Clear finished
          </button>
        )}
      </div>
      {open && (
        <ul className="max-h-36 overflow-auto px-1.5 pb-1.5">
          {transfers.map((t) => {
            const pct =
              t.size > 0
                ? Math.min(100, Math.floor((t.transferred / t.size) * 100))
                : t.state === 'done'
                  ? 100
                  : 0
            const name = t.remotePath.split('/').at(-1) ?? t.remotePath
            const DirIcon = t.direction === 'upload' ? Upload : Download
            return (
              <li
                key={t.id}
                className="rounded-md px-1.5 py-1 hover:bg-hover"
                data-testid="s3-transfer"
                data-state={t.state}
              >
                <div className="flex items-center gap-2 text-xs">
                  {t.state === 'done' ? (
                    <CircleCheck size={13} className="shrink-0 text-success" />
                  ) : t.state === 'error' ? (
                    <CircleAlert size={13} className="shrink-0 text-danger" />
                  ) : t.state === 'cancelled' ? (
                    <Ban size={13} className="shrink-0 text-faint" />
                  ) : (
                    <DirIcon size={13} className="shrink-0 text-accent" />
                  )}
                  <span
                    className={cx(
                      'min-w-0 flex-1 truncate',
                      t.state === 'cancelled' && 'text-faint'
                    )}
                    title={`${t.direction === 'upload' ? t.localPath : t.remotePath} → ${
                      t.direction === 'upload' ? t.remotePath : t.localPath
                    }`}
                  >
                    {name}
                  </span>
                  {t.edit && (
                    <span className="shrink-0 rounded bg-subtle px-1 text-[10px] text-faint">
                      edit
                    </span>
                  )}
                  <span className="shrink-0 text-faint tabular-nums">
                    {t.state === 'running' && `${pct}% · ${formatSize(t.bytesPerSecond)}/s`}
                    {t.state === 'queued' && 'Queued'}
                    {t.state === 'done' && formatSize(t.size)}
                    {t.state === 'cancelled' && 'Cancelled'}
                    {t.state === 'error' && 'Failed'}
                  </span>
                  {t.state === 'running' || t.state === 'queued' ? (
                    <IconButton
                      label="Cancel"
                      size="sm"
                      className="size-5"
                      onClick={() => {
                        onCancel(t.id)
                      }}
                    >
                      <X size={12} />
                    </IconButton>
                  ) : (
                    <span className="size-5 shrink-0" />
                  )}
                </div>
                {t.state === 'running' && (
                  <div className="mt-1 ml-5 h-0.5 overflow-hidden rounded-full bg-subtle">
                    <div
                      className="h-0.5 rounded-full bg-accent transition-[width] duration-200"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                {t.error && (
                  <p className="mt-0.5 ml-5 truncate text-[11px] text-danger" title={t.error}>
                    {t.error}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
