import { useState } from 'react'
import {
  Ban,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { t, tn } from '@shared/i18n'
import { formatBytes, formatDuration, formatPercent, formatRate } from '@shared/i18n/format'
import type { TransferStatus } from '@shared/sftp'
import { choose } from '../../stores/confirm'
import { cx, IconButton } from '../ui'

/** Lượt lỗi / huỷ còn giữ file part (tiếp tục được). */
function isPartial(t: TransferStatus): boolean {
  return (t.state === 'error' || t.state === 'cancelled') && t.resumable === true
}

/**
 * Hỏi khi dọn danh sách mà còn lượt dở dang giữ file part: giữ (lần sau tải lại cùng file thì tiếp
 * tục) hay xoá luôn. null = người dùng đóng hộp thoại (không dọn).
 */
async function askKeepParts(partials: TransferStatus[]): Promise<boolean | null> {
  const bytes = partials.reduce((n, p) => n + p.transferred, 0)
  const choice = await choose({
    title: t('Clear finished transfers'),
    message: tn(
      partials.length,
      '{n} incomplete transfer keeps a partial file ({size}) so it can resume later. Delete it too?',
      '{n} incomplete transfers keep partial files ({size}) so they can resume later. Delete them too?',
      { size: formatBytes(bytes) }
    ),
    testId: 'transfers-clear-dialog',
    width: 'max-w-md',
    choices: [
      { value: 'keep', label: t('Keep partial files'), testId: 'transfers-clear-keep' },
      {
        value: 'delete',
        label: t('Delete partial files'),
        variant: 'danger',
        autoFocus: true,
        testId: 'transfers-clear-delete'
      }
    ]
  })
  return choice === null ? null : choice === 'keep'
}

/**
 * Danh sách truyền file (S3 và SFTP): gọn, thu lại được; chỉ lượt đang chạy mới có thanh tiến độ.
 * `onRetry` (SFTP): thử lại lượt lỗi / huỷ — tiếp tục từ chỗ dừng nếu còn file part.
 * `onDiscard` (SFTP): bỏ lượt dở dang + xoá file part; có thì "Clear finished" hỏi xoá file part.
 */
export function TransferList({
  transfers,
  onCancel,
  onClear,
  onRetry,
  onDiscard,
  testId,
  rowTestId
}: {
  transfers: TransferStatus[]
  onCancel: (id: string) => void
  /** `keepParts`: giữ file part của lượt dở dang (chỉ khi có `onDiscard`). */
  onClear: (keepParts?: boolean) => void
  onRetry?: (id: string) => void
  onDiscard?: (id: string) => void
  testId: string
  rowTestId: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  if (transfers.length === 0) return null

  const active = transfers.filter((x) => x.state === 'running' || x.state === 'queued')
  const done = transfers.filter((x) => x.state === 'done').length
  const failed = transfers.filter((x) => x.state === 'error').length
  const total = active.reduce((n, x) => n + x.size, 0)
  const moved = active.reduce((n, x) => n + x.transferred, 0)
  const speed = active.reduce((n, x) => n + (x.state === 'running' ? x.bytesPerSecond : 0), 0)
  const remaining = speed > 0 ? (total - moved) / speed : null
  const summary = [
    active.length > 0 &&
      [
        tn(active.length, '{n} active', '{n} active'),
        total > 0 && formatPercent(Math.min(1, moved / total)),
        speed > 0 && formatRate(speed),
        remaining !== null &&
          remaining > 1 &&
          t('{time} left', { time: formatDuration(remaining * 1000) })
      ]
        .filter(Boolean)
        .join(' · '),
    done > 0 && tn(done, '{n} done', '{n} done'),
    failed > 0 && tn(failed, '{n} failed', '{n} failed')
  ]
    .filter(Boolean)
    .join(' · ')

  const clear = async (): Promise<void> => {
    const partials = onDiscard ? transfers.filter(isPartial) : []
    if (partials.length === 0) {
      onClear()
      return
    }
    const keep = await askKeepParts(partials)
    if (keep !== null) onClear(keep)
  }

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
          <span className="shrink-0">{t('Transfers')}</span>
          <span
            className={cx(
              'truncate font-normal tabular-nums',
              failed > 0 ? 'text-danger' : 'text-faint'
            )}
          >
            {summary}
          </span>
        </button>
        {failed > 0 && onRetry && (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-fg"
            data-testid="transfers-retry-failed"
            onClick={() => {
              for (const x of transfers) if (x.state === 'error') onRetry(x.id)
            }}
          >
            {t('Retry failed')}
          </button>
        )}
        {active.length > 1 && (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-danger"
            data-testid="transfers-cancel-all"
            onClick={() => {
              for (const x of active) onCancel(x.id)
            }}
          >
            {t('Cancel all')}
          </button>
        )}
        {active.length < transfers.length && (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-fg"
            data-testid="transfers-clear"
            onClick={() => void clear()}
          >
            {t('Clear finished')}
          </button>
        )}
      </div>
      {open && (
        <ul className="max-h-36 overflow-auto px-1.5 pb-1.5">
          {transfers.map((x) => (
            <TransferRow
              key={x.id}
              transfer={x}
              rowTestId={rowTestId}
              onCancel={onCancel}
              onRetry={onRetry}
              onDiscard={onDiscard}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function TransferRow({
  transfer: x,
  rowTestId,
  onCancel,
  onRetry,
  onDiscard
}: {
  transfer: TransferStatus
  rowTestId: string
  onCancel: (id: string) => void
  onRetry: ((id: string) => void) | undefined
  onDiscard: ((id: string) => void) | undefined
}): React.JSX.Element {
  const ratio = x.size > 0 ? Math.min(1, x.transferred / x.size) : x.state === 'done' ? 1 : 0
  const name = x.remotePath.split('/').at(-1) ?? x.remotePath
  const DirIcon = x.direction === 'upload' ? Upload : Download
  const partial = isPartial(x)
  const from = x.direction === 'upload' ? x.localPath : x.remotePath
  const to = x.direction === 'upload' ? x.remotePath : x.localPath
  const finished = x.state === 'error' || x.state === 'cancelled'

  let detail: string
  if (x.state === 'running')
    detail = [
      x.size > 0
        ? t('{done} of {total}', { done: formatBytes(x.transferred), total: formatBytes(x.size) })
        : formatPercent(ratio),
      x.bytesPerSecond > 0 && formatRate(x.bytesPerSecond),
      x.bytesPerSecond > 0 &&
        x.size > x.transferred &&
        t('{time} left', {
          time: formatDuration(((x.size - x.transferred) / x.bytesPerSecond) * 1000)
        })
    ]
      .filter(Boolean)
      .join(' · ')
  else if (x.state === 'queued') detail = t('Queued')
  else if (x.state === 'done')
    detail = x.edit
      ? t('Saved to server')
      : x.resumedFrom > 0
        ? t('{size} (resumed)', { size: formatBytes(x.size) })
        : formatBytes(x.size)
  else if (partial)
    detail = t('{state} at {percent}', {
      state: x.state === 'cancelled' ? t('Cancelled') : t('Failed'),
      percent: formatPercent(ratio)
    })
  else detail = x.state === 'cancelled' ? t('Cancelled') : t('Failed')

  return (
    <li
      className="group rounded-md px-1.5 py-1 hover:bg-hover"
      data-testid={rowTestId}
      data-state={x.state}
      {...(partial ? { 'data-resumable': 'true' } : {})}
    >
      <div className="flex items-center gap-2 text-xs">
        {x.state === 'done' ? (
          <CircleCheck size={13} className="shrink-0 text-success" aria-label={t('Done')} />
        ) : x.state === 'error' ? (
          <CircleAlert size={13} className="shrink-0 text-danger" aria-label={t('Failed')} />
        ) : x.state === 'cancelled' ? (
          <Ban size={13} className="shrink-0 text-faint" aria-label={t('Cancelled')} />
        ) : (
          <DirIcon
            size={13}
            className="shrink-0 text-accent"
            aria-label={x.direction === 'upload' ? t('Upload') : t('Download')}
          />
        )}
        <span
          className={cx('min-w-0 flex-1 truncate', x.state === 'cancelled' && 'text-faint')}
          title={`${from} → ${to}`}
        >
          {name}
        </span>
        {x.edit && (
          <span className="shrink-0 rounded bg-subtle px-1 text-[11px] text-faint">
            {t('edit')}
          </span>
        )}
        <span className="shrink-0 text-faint tabular-nums">{detail}</span>
        {x.state === 'running' || x.state === 'queued' ? (
          <IconButton
            label={t('Cancel')}
            size="sm"
            className="size-5"
            onClick={() => {
              onCancel(x.id)
            }}
          >
            <X size={12} />
          </IconButton>
        ) : finished && onRetry ? (
          <>
            <IconButton
              label={
                partial ? t('Resume from {percent}', { percent: formatPercent(ratio) }) : t('Retry')
              }
              size="sm"
              className="size-5"
              data-testid={partial ? 'transfer-resume' : 'transfer-retry'}
              onClick={() => {
                onRetry(x.id)
              }}
            >
              {partial ? <Play size={12} /> : <RotateCcw size={12} />}
            </IconButton>
            {onDiscard && (
              <IconButton
                label={partial ? t('Discard (delete the partial file)') : t('Remove from list')}
                size="sm"
                className="size-5 hover:text-danger"
                data-testid="transfer-discard"
                onClick={() => {
                  onDiscard(x.id)
                }}
              >
                {partial ? <Trash2 size={12} /> : <X size={12} />}
              </IconButton>
            )}
          </>
        ) : (
          <span className="size-5 shrink-0" />
        )}
      </div>
      {x.state === 'running' && (
        <div
          className="mt-1 ml-5 h-1 overflow-hidden rounded-full bg-subtle"
          role="progressbar"
          aria-label={name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(ratio * 100)}
        >
          <div
            className="h-1 rounded-full bg-info transition-[width] duration-200"
            style={{ width: `${String(ratio * 100)}%` }}
          />
        </div>
      )}
      {x.error && (
        <p className="mt-0.5 ml-5 truncate text-xs text-danger" title={x.error}>
          {x.error}
        </p>
      )}
    </li>
  )
}
