import { useState } from 'react'
import {
  Ban,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  RotateCcw,
  Upload,
  X
} from 'lucide-react'
import type { TransferStatus } from '@shared/sftp'
import { cx, IconButton } from '../ui'
import { formatSize } from '../../lib/format'

/**
 * Danh sách truyền file (S3 và SFTP): gọn, thu lại được; chỉ lượt đang chạy mới có thanh tiến độ.
 * `onRetry` (SFTP): thử lại lượt lỗi / huỷ, tiếp tục từ chỗ dừng.
 */
export function TransferList({
  transfers,
  onCancel,
  onClear,
  onRetry,
  testId,
  rowTestId
}: {
  transfers: TransferStatus[]
  onCancel: (id: string) => void
  onClear: () => void
  onRetry?: (id: string) => void
  testId: string
  rowTestId: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  if (transfers.length === 0) return null

  const active = transfers.filter((t) => t.state === 'running' || t.state === 'queued')
  const done = transfers.filter((t) => t.state === 'done').length
  const failed = transfers.filter((t) => t.state === 'error').length
  const total = active.reduce((n, t) => n + t.size, 0)
  const moved = active.reduce((n, t) => n + t.transferred, 0)
  const speed = active.reduce((n, t) => n + (t.state === 'running' ? t.bytesPerSecond : 0), 0)
  const remaining = speed > 0 ? (total - moved) / speed : null
  const summary = [
    active.length > 0 &&
      `${active.length} active${total > 0 ? ` · ${Math.floor((moved / total) * 100)}%` : ''}${
        speed > 0 ? ` · ${formatSize(speed)}/s` : ''
      }${remaining !== null && remaining > 1 ? ` · ${duration(remaining)} left` : ''}`,
    done > 0 && `${done} done`,
    failed > 0 && `${failed} failed`
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="shrink-0 border-t border-line bg-surface" data-testid={testId}>
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
        {failed > 0 && onRetry && (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-fg"
            data-testid="transfers-retry-failed"
            onClick={() => {
              for (const t of transfers) if (t.state === 'error') onRetry(t.id)
            }}
          >
            Retry failed
          </button>
        )}
        {active.length > 1 && (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-danger"
            data-testid="transfers-cancel-all"
            onClick={() => {
              for (const t of active) onCancel(t.id)
            }}
          >
            Cancel all
          </button>
        )}
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
                data-testid={rowTestId}
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
                    <span className="shrink-0 rounded bg-subtle px-1 text-[11px] text-faint">
                      edit
                    </span>
                  )}
                  <span className="shrink-0 text-faint tabular-nums">
                    {t.state === 'running' &&
                      [
                        t.size > 0
                          ? `${formatSize(t.transferred)} of ${formatSize(t.size)}`
                          : `${pct}%`,
                        t.bytesPerSecond > 0 && `${formatSize(t.bytesPerSecond)}/s`,
                        t.bytesPerSecond > 0 &&
                          t.size > t.transferred &&
                          `${duration((t.size - t.transferred) / t.bytesPerSecond)} left`
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    {t.state === 'queued' && 'Queued'}
                    {t.state === 'done' &&
                      (t.edit
                        ? 'Saved to server'
                        : `${formatSize(t.size)}${t.resumedFrom > 0 ? ' (resumed)' : ''}`)}
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
                  ) : onRetry && (t.state === 'error' || t.state === 'cancelled') ? (
                    <IconButton
                      label="Retry (resumes where it stopped)"
                      size="sm"
                      className="size-5"
                      onClick={() => {
                        onRetry(t.id)
                      }}
                    >
                      <RotateCcw size={12} />
                    </IconButton>
                  ) : (
                    <span className="size-5 shrink-0" />
                  )}
                </div>
                {t.state === 'running' && (
                  <div className="mt-1 ml-5 h-1 overflow-hidden rounded-full bg-subtle">
                    <div
                      className="h-1 rounded-full bg-accent-solid transition-[width] duration-200"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                {t.error && (
                  <p className="mt-0.5 ml-5 truncate text-xs text-danger" title={t.error}>
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

/** "8s", "1:05", "1:02:05" — thời gian còn lại. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${String(s)}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${String(h)}:${String(m).padStart(2, '0')}:${sec}` : `${String(m)}:${sec}`
}
