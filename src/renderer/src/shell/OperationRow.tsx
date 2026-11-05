import { ArrowLeftRight, FolderOpen, Trash2, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { formatDateTime, formatNumber } from '@shared/i18n/format'
import type { TransferStatus } from '@shared/sftp'
import type { TransferSource } from '../stores/transfers'
import { IconButton } from '../ds'
import { ICON_SM } from '../ds/utils'

export function OperationRow({
  src,
  x
}: {
  src: TransferSource
  x: TransferStatus
}): React.JSX.Element | null {
  const op = x.operation
  if (!op) return null
  const active = x.state === 'running' || x.state === 'queued'
  const status = active
    ? t('Working…')
    : x.state === 'done'
      ? t('Completed')
      : x.state === 'cancelled'
        ? t('Stopped')
        : t('Failed')
  const count =
    active && op.checking
      ? t('Checking files: {n} of {total}', {
          n: formatNumber(op.checking.done),
          total: formatNumber(op.checking.total)
        })
      : op.total === null
        ? t('{n} objects processed', { n: formatNumber(op.completed) })
        : t('{n} of {total} objects', {
            n: formatNumber(op.completed),
            total: formatNumber(op.total)
          })
  const ratio = op.total ? Math.min(1, op.completed / op.total) : x.state === 'done' ? 1 : 0
  const route = [op.source, op.destination].filter(Boolean).join(' → ')
  const times = [
    formatDateTime(op.startedAt),
    op.finishedAt !== null ? formatDateTime(op.finishedAt) : ''
  ]
    .filter(Boolean)
    .join(' → ')
  return (
    <li
      className="group grid min-h-13 grid-cols-[20px_minmax(0,1.3fr)_minmax(0,1.4fr)_160px_150px_64px] items-center gap-3 border-b border-ds-border-subtle px-4 py-2 hover:bg-ds-hover"
      data-testid="transfers-center-row"
      data-state={x.state}
      data-operation={op.kind}
    >
      <ArrowLeftRight {...ICON_SM} className="text-ds-fg-3" />
      <div className="min-w-0">
        <div className="truncate text-ds-base font-medium text-ds-fg" title={op.label}>
          {op.label}
        </div>
        <div className="truncate text-ds-sm text-ds-fg-3" title={times}>
          S3 · {op.accountName ?? src.label} · {times}
        </div>
        {x.error && (
          <div className="truncate text-ds-sm text-ds-danger" title={x.error}>
            {x.error}
          </div>
        )}
      </div>
      <div className="truncate font-mono text-ds-sm text-ds-fg-2" title={route}>
        {route}
      </div>
      <div className="text-ds-sm text-ds-fg-2">
        {status}
        {active && op.total !== null && (
          <div
            role="progressbar"
            aria-label={op.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(ratio * 100)}
            className="mt-1 h-1 overflow-hidden rounded-full bg-ds-surface-3"
          >
            <div className="h-full bg-ds-info" style={{ width: `${ratio * 100}%` }} />
          </div>
        )}
      </div>
      <div className="text-right text-ds-sm text-ds-fg-2 tabular-nums">
        <div>{count}</div>
        {op.failed > 0 && (
          <div className="text-ds-danger">{t('{n} failed', { n: formatNumber(op.failed) })}</div>
        )}
      </div>
      <div className="flex items-center justify-end gap-0.5">
        {src.canRevealTransfer?.(x.id) && (
          <IconButton
            size="sm"
            label={t('Open')}
            onClick={() => {
              src.revealTransfer?.(x.id)
            }}
          >
            <FolderOpen {...ICON_SM} />
          </IconButton>
        )}
        {active ? (
          <IconButton
            size="sm"
            label={t('Stop')}
            onClick={() => {
              src.cancel(x.id)
            }}
          >
            <X {...ICON_SM} />
          </IconButton>
        ) : (
          src.discard && (
            <IconButton
              size="sm"
              label={t('Remove from list')}
              data-testid="transfer-discard"
              onClick={() => {
                src.discard?.(x.id)
              }}
            >
              <Trash2 {...ICON_SM} />
            </IconButton>
          )
        )}
      </div>
    </li>
  )
}
