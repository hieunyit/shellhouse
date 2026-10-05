import { useMemo, useState } from 'react'
import {
  ArrowLeftRight,
  CircleAlert,
  Download,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { t } from '@shared/i18n'
import { formatBytes, formatDuration, formatPercent, formatRate } from '@shared/i18n/format'
import type { TransferStatus } from '@shared/sftp'
import { Button, EmptyState, IconButton, Select } from '../ds'
import { cx, ICON, ICON_SM } from '../ds/utils'
import { AreaHeader } from '../components/AreaHeader'
import { useTransfers, type TransferSource } from '../stores/transfers'
import { TRANSFER_FILTERS, matchesFilter, useTransfersFilter } from './transfers-filter'

interface Item {
  src: TransferSource
  x: TransferStatus
}

type Group = 'failed' | 'active' | 'queued' | 'done'

const GROUPS: readonly { id: Group; title: () => string }[] = [
  { id: 'failed', title: () => t('Failed') },
  { id: 'active', title: () => t('Active') },
  { id: 'queued', title: () => t('Queued') },
  { id: 'done', title: () => t('Completed') }
]

function groupOf(x: TransferStatus): Group {
  if (x.state === 'running') return 'active'
  if (x.state === 'queued') return 'queued'
  if (x.state === 'done') return 'done'
  return 'failed'
}

const baseName = (p: string): string =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) ?? p
const dirName = (p: string): string => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i + 1) : p
}

/** "~/build/ → prod-web-01:/srv/shop/releases/" (thư mục, không lặp tên file). */
function route({ src, x }: Item): string {
  const remote = `${src.label}:${dirName(x.remotePath)}`
  const local = dirName(x.localPath)
  return x.direction === 'upload' ? `${local} → ${remote}` : `${remote} → ${local}`
}

/**
 * Trung tâm truyền file (thiết kế v0.5): mọi lượt SFTP / S3 đang có, chia nhóm Failed · Active ·
 * Queued · Completed; lọc theo tên, nguồn, chiều; trạng thái chọn ở Explorer. Thao tác (huỷ, thử
 * lại / tiếp tục, bỏ, dọn) gọi ngược về nguồn như danh sách trong panel của từng nguồn.
 */
export function TransfersPage(): React.JSX.Element {
  const sources = useTransfers((s) => s.sources)
  const filter = useTransfersFilter((s) => s.filter)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'any' | TransferSource['kind']>('any')
  const [direction, setDirection] = useState<'any' | TransferStatus['direction']>('any')
  const all = useMemo(
    () => Object.values(sources).flatMap((src) => src.transfers.map((x) => ({ src, x }))),
    [sources]
  )
  const q = query.trim().toLowerCase()
  const visible = all.filter(
    ({ src, x }) =>
      matchesFilter(x, filter) &&
      (kind === 'any' || src.kind === kind) &&
      (direction === 'any' || x.direction === direction) &&
      (!q ||
        x.remotePath.toLowerCase().includes(q) ||
        x.localPath.toLowerCase().includes(q) ||
        src.label.toLowerCase().includes(q))
  )
  const running = all.filter(({ x }) => x.state === 'running')
  const speed = running.reduce((n, { x }) => n + x.bytesPerSecond, 0)
  const finished = all.some(({ x }) => x.state !== 'running' && x.state !== 'queued')
  // Tạm dừng = huỷ nhưng giữ file part (nguồn tiếp tục được — SFTP); tiếp tục = thử lại từ chỗ dừng.
  const pausable = all.filter(
    ({ src, x }) => src.retry && (x.state === 'running' || x.state === 'queued')
  )
  const paused = all.filter(
    ({ src, x }) => src.retry && x.state === 'cancelled' && x.resumable === true
  )
  const failed = all.filter(({ x }) => x.state === 'error')
  const filterTitle = TRANSFER_FILTERS.find((f) => f.id === filter)?.title() ?? ''

  return (
    <div className="flex h-full min-h-0 flex-col bg-ds-surface-0" data-testid="transfers-page">
      <AreaHeader icon={<ArrowLeftRight {...ICON_SM} />} title={t('Transfers')}>
        {filter !== 'all' && <span className="text-ds-base text-ds-fg-3">/ {filterTitle}</span>}
      </AreaHeader>
      {all.length > 0 && (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ds-border-subtle px-3">
          <label className="flex h-ds-ctl w-60 items-center gap-2 rounded-ds-md border border-ds-border-control bg-ds-surface-1 px-2 text-ds-sm focus-within:border-ds-accent">
            <Search {...ICON_SM} className="shrink-0 text-ds-fg-3" />
            <input
              className="min-w-0 flex-1 bg-transparent text-ds-fg outline-none placeholder:text-ds-fg-3"
              placeholder={t('Filter…')}
              aria-label={t('Filter transfers')}
              data-testid="transfers-search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
              }}
            />
          </label>
          <Select
            label={t('Source')}
            className="w-auto"
            value={kind}
            onValueChange={(v) => {
              setKind(v)
            }}
            options={[
              { value: 'any', label: `${t('Source')}: ${t('Any')}` },
              { value: 'sftp', label: `${t('Source')}: SFTP` },
              { value: 's3', label: `${t('Source')}: S3` }
            ]}
          />
          <Select
            label={t('Direction')}
            className="w-auto"
            value={direction}
            onValueChange={(v) => {
              setDirection(v)
            }}
            options={[
              { value: 'any', label: `${t('Direction')}: ${t('Any')}` },
              { value: 'upload', label: `${t('Direction')}: ${t('Upload')}` },
              { value: 'download', label: `${t('Direction')}: ${t('Download')}` }
            ]}
          />
          <div className="flex-1" />
          {running.length > 0 && (
            <span className="text-ds-sm text-ds-fg-3 tabular-nums">
              {[t('{n} running', { n: running.length }), speed > 0 && formatRate(speed)]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          {pausable.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Pause {...ICON_SM} />}
              data-testid="transfers-pause-all"
              onClick={() => {
                for (const { src, x } of pausable) src.cancel(x.id)
              }}
            >
              {t('Pause all')}
            </Button>
          )}
          {paused.length > 0 && pausable.length === 0 && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Play {...ICON_SM} />}
              data-testid="transfers-resume-all"
              onClick={() => {
                for (const { src, x } of paused) src.retry?.(x.id)
              }}
            >
              {t('Resume all')}
            </Button>
          )}
          {finished && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="transfers-clear-finished"
              onClick={() => {
                for (const src of Object.values(sources)) src.clear()
              }}
            >
              {t('Clear finished')}
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <EmptyState
            className="mt-16"
            icon={<ArrowLeftRight {...ICON} />}
            title={all.length === 0 ? t('No transfers') : t('Nothing here')}
            description={t(
              'Uploads and downloads from SFTP and S3 show up here while their tab is open.'
            )}
          />
        ) : (
          GROUPS.map((g) => {
            const items = visible.filter(({ x }) => groupOf(x) === g.id)
            if (items.length === 0) return null
            return (
              <section key={g.id} data-testid={`transfers-group-${g.id}`}>
                <div className="flex h-10 items-center gap-2 border-b border-ds-border-subtle px-4 pt-1">
                  <span className="text-ds-sm font-medium text-ds-fg-2">{g.title()}</span>
                  <span className="text-ds-sm text-ds-fg-3 tabular-nums">{items.length}</span>
                  <div className="flex-1" />
                  {g.id === 'failed' && failed.some(({ src }) => src.retry) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="transfers-retry-failed"
                      onClick={() => {
                        for (const { src, x } of failed) src.retry?.(x.id)
                      }}
                    >
                      {t('Retry failed')}
                    </Button>
                  )}
                </div>
                <ul data-testid="transfers-center-list">
                  {items.map((item) => (
                    <Row key={`${item.src.id}:${item.x.id}`} item={item} />
                  ))}
                </ul>
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}

function Row({ item }: { item: Item }): React.JSX.Element {
  const { src, x } = item
  const ratio = x.size > 0 ? Math.min(1, x.transferred / x.size) : x.state === 'done' ? 1 : 0
  const name = baseName(x.direction === 'upload' ? x.localPath : x.remotePath)
  const partial = (x.state === 'error' || x.state === 'cancelled') && x.resumable === true
  const failed = x.state === 'error' || x.state === 'cancelled'
  const Dir = x.direction === 'upload' ? Upload : Download

  let right: string
  let sub: string | null = null
  if (x.state === 'running') {
    right = [formatPercent(ratio), x.bytesPerSecond > 0 && formatRate(x.bytesPerSecond)]
      .filter(Boolean)
      .join(' · ')
    sub = [
      x.bytesPerSecond > 0 &&
        x.size > x.transferred &&
        t('{time} left', {
          time: formatDuration(((x.size - x.transferred) / x.bytesPerSecond) * 1000)
        }),
      x.size > 0 && formatBytes(x.size)
    ]
      .filter(Boolean)
      .join(' · ')
  } else if (x.state === 'queued') right = x.size > 0 ? formatBytes(x.size) : ''
  else if (x.state === 'done') right = formatBytes(x.size)
  else
    right = t('{percent} of {total}', {
      percent: formatPercent(ratio),
      total: formatBytes(x.size)
    })
  const status =
    x.state === 'queued'
      ? t('Queued')
      : x.state === 'done'
        ? x.edit
          ? t('Saved to server')
          : x.direction === 'upload'
            ? x.resumedFrom > 0
              ? t('Uploaded (resumed)')
              : t('Uploaded')
            : x.resumedFrom > 0
              ? t('Downloaded (resumed)')
              : t('Downloaded')
        : null

  return (
    <li
      className="group grid min-h-13 grid-cols-[20px_minmax(0,1.3fr)_minmax(0,1.4fr)_160px_150px_64px] items-center gap-3 border-b border-ds-border-subtle px-4 py-2 hover:bg-ds-hover"
      data-testid="transfers-center-row"
      data-state={x.state}
    >
      {failed ? (
        <CircleAlert {...ICON_SM} className="text-ds-danger" aria-label={t('Failed')} />
      ) : (
        <Dir
          {...ICON_SM}
          className="text-ds-fg-3"
          aria-label={x.direction === 'upload' ? t('Upload') : t('Download')}
        />
      )}
      <div className="min-w-0">
        <div className="truncate text-ds-base font-medium text-ds-fg" title={name}>
          {name}
        </div>
        <div className="truncate text-ds-sm text-ds-fg-3">
          {src.kind.toUpperCase()} · {x.direction === 'upload' ? t('upload') : t('download')}
          {x.error && failed && <span className="text-ds-danger"> · {x.error}</span>}
        </div>
      </div>
      <div className="truncate font-mono text-ds-sm text-ds-fg-2" title={route(item)}>
        {route(item)}
      </div>
      <div>
        {x.state === 'running' || partial ? (
          <div
            className="h-1 overflow-hidden rounded-full bg-ds-surface-3"
            role="progressbar"
            aria-label={name}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(ratio * 100)}
          >
            <div
              className={cx('h-full rounded-full', failed ? 'bg-ds-danger' : 'bg-ds-info')}
              style={{ width: `${String(ratio * 100)}%` }}
            />
          </div>
        ) : (
          status && <span className="text-ds-sm text-ds-fg-2">{status}</span>
        )}
      </div>
      <div className="text-right text-ds-sm tabular-nums">
        <div className="text-ds-fg-2">{right}</div>
        {sub && <div className="text-ds-fg-3">{sub}</div>}
      </div>
      <div className="flex items-center justify-end gap-0.5">
        {x.state === 'running' || x.state === 'queued' ? (
          <IconButton
            label={t('Cancel')}
            size="sm"
            onClick={() => {
              src.cancel(x.id)
            }}
          >
            <X {...ICON_SM} />
          </IconButton>
        ) : failed ? (
          <>
            {src.retry && (
              <IconButton
                label={partial ? t('Resume') : t('Retry')}
                size="sm"
                data-testid={partial ? 'transfer-resume' : 'transfer-retry'}
                onClick={() => {
                  src.retry?.(x.id)
                }}
              >
                {partial ? <Play {...ICON_SM} /> : <RotateCcw {...ICON_SM} />}
              </IconButton>
            )}
            {src.discard && (
              <IconButton
                label={partial ? t('Discard (delete the partial file)') : t('Remove from list')}
                size="sm"
                data-testid="transfer-discard"
                onClick={() => {
                  src.discard?.(x.id)
                }}
              >
                <Trash2 {...ICON_SM} />
              </IconButton>
            )}
          </>
        ) : (
          src.reveal && (
            <IconButton
              label={t('Open')}
              size="sm"
              onClick={() => {
                src.reveal?.()
              }}
            >
              <FolderOpen {...ICON_SM} />
            </IconButton>
          )
        )}
      </div>
    </li>
  )
}
