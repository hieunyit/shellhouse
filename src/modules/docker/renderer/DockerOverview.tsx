import { useEffect, useState } from 'react'
import { Heading, StatCard } from '../../../renderer/src/components/panels'
import { Button, cx, Notice } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { formatBytes, formatPercent, t, tn } from '../../registry/renderer-kit'
import type { ContainerRow, DiskUsage, DockerOp, EngineInfo, PruneTarget } from '../shared/ops'

type Category = 'images' | 'containers' | 'volumes' | 'buildCache'

/**
 * Màu phân loại (thứ tự cố định — xanh dương, cam, xanh ngọc, vàng; kiểm bằng validator của
 * dataviz cho nền sáng / tối). Không dùng màu trạng thái (đỏ / vàng cảnh báo) cho loại dữ liệu.
 * Phần "dọn được" là cùng màu, nhạt hơn — tên + số luôn có chữ bên cạnh (không chỉ dựa vào màu).
 */
const COLORS: Record<Category, string> = {
  images: 'bg-[#2a78d6] dark:bg-[#3987e5]',
  containers: 'bg-[#eb6834] dark:bg-[#d95926]',
  volumes: 'bg-[#1baf7a] dark:bg-[#199e70]',
  buildCache: 'bg-[#eda100] dark:bg-[#c98500]'
}

export interface DiskRow {
  id: Category
  label: string
  count: number
  size: number
  reclaimable: number
  /** Phần dọn được tính theo số mục (container dừng có thể 0 B). */
  reclaimableCount: number
}

/** Tỉ lệ chiều dài thanh: phần của tổng dung lượng (không phải tỉ lệ dọn được trong loại). */
export function shares(rows: readonly DiskRow[]): { used: number; free: number }[] {
  const total = rows.reduce((n, r) => n + r.size, 0)
  return rows.map((r) => {
    if (total <= 0) return { used: 0, free: 0 }
    const size = r.size / total
    const free = Math.min(size, Math.max(0, r.reclaimable) / total)
    return { used: size - free, free }
  })
}

/** Tổng quan engine (kiểu Docker Desktop): số lượng, dung lượng đĩa, dọn dẹp. */
export function DockerOverview({
  info,
  containers,
  request,
  readOnly,
  reloadKey,
  onNavigate,
  onPrune
}: {
  info: EngineInfo | null
  containers: ContainerRow[] | null
  request: <T>(op: DockerOp) => Promise<T>
  readOnly: boolean
  reloadKey: number
  onNavigate: (
    section: 'containers' | 'images' | 'volumes' | 'networks' | 'compose',
    filter?: string
  ) => void
  /** `all` = image không dùng / volume có tên (mặc định: phần dọn được an toàn). */
  onPrune: (what: PruneTarget, all?: boolean) => void
}): React.JSX.Element {
  const [df, setDf] = useState<DiskUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    request<DiskUsage>({ op: 'df' }).then(
      (d) => {
        if (!cancelled) {
          setDf(d)
          setError(null)
        }
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, reloadKey])
  const running = containers?.filter((c) => c.state === 'running').length ?? 0
  const stopped = (containers?.length ?? 0) - running
  const unhealthy =
    containers?.filter(
      (c) => c.health === 'unhealthy' || c.state === 'restarting' || c.state === 'dead'
    ).length ?? 0
  const projects = new Set(containers?.map((c) => c.project).filter(Boolean)).size
  const rows: DiskRow[] = df
    ? [
        {
          id: 'images',
          label: t('Images'),
          count: df.images.count,
          size: df.images.size,
          reclaimable: df.images.reclaimable,
          reclaimableCount: df.images.reclaimable > 0 ? 1 : 0
        },
        {
          id: 'containers',
          label: t('Containers'),
          count: df.containers.count,
          size: df.containers.size,
          reclaimable: df.containers.reclaimable,
          reclaimableCount: stopped
        },
        {
          id: 'volumes',
          label: t('Volumes'),
          count: df.volumes.count,
          size: df.volumes.size,
          reclaimable: df.volumes.reclaimable,
          reclaimableCount: df.volumes.reclaimable > 0 ? 1 : 0
        },
        {
          id: 'buildCache',
          label: t('Build cache'),
          count: df.buildCache.count,
          size: df.buildCache.size,
          reclaimable: df.buildCache.reclaimable,
          reclaimableCount: df.buildCache.reclaimable > 0 ? 1 : 0
        }
      ]
    : []
  const total = rows.reduce((n, r) => n + r.size, 0)
  const totalReclaimable = rows.reduce((n, r) => n + r.reclaimable, 0)
  const parts = shares(rows)
  const unusedImages = df && df.images.unused.size > df.images.reclaimable ? df.images.unused : null
  const namedVolumes = df?.volumes.namedUnused?.count ? df.volumes.namedUnused : null
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="docker-overview">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">{info?.version ?? 'Docker'}</h3>
        <span className="text-xs text-faint">
          {info?.os}
          {info?.via === 'cli' ? ` · ${t('via docker CLI')}` : ''}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-5">
        <StatCard
          label={t('Running')}
          value={running}
          tone={running ? 'ok' : 'muted'}
          onClick={() => {
            onNavigate('containers', 'running')
          }}
          testId="docker-ov-running"
        />
        <StatCard
          label={t('Stopped')}
          value={stopped}
          onClick={() => {
            onNavigate('containers', 'stopped')
          }}
        />
        <StatCard
          label={t('Unhealthy')}
          value={unhealthy}
          tone={unhealthy ? 'bad' : 'muted'}
          sub={unhealthy ? t('Failing health checks or restarting') : undefined}
          testId="docker-ov-unhealthy"
          onClick={() => {
            onNavigate('containers', unhealthy ? 'unhealthy' : undefined)
          }}
        />
        <StatCard
          label={t('Images')}
          value={df?.images.count ?? info?.images ?? '—'}
          onClick={() => {
            onNavigate('images')
          }}
        />
        <StatCard
          label={t('Compose projects')}
          value={projects}
          onClick={() => {
            onNavigate('compose')
          }}
        />
      </div>
      <div className="mt-4 rounded-lg border border-line p-3" data-testid="docker-ov-disk">
        <div className="flex items-baseline justify-between gap-2">
          <Heading>{t('Disk usage')}</Heading>
          {df && (
            <span className="text-xs text-muted tabular-nums" data-testid="docker-ov-total">
              {t('{used} used · {free} reclaimable', {
                used: formatBytes(total),
                free: formatBytes(totalReclaimable)
              })}
            </span>
          )}
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {!df && !error && <p className="text-xs text-faint">{t('Calculating…')}</p>}
        {df && (
          <>
            {/* Một thanh xếp chồng: mỗi loại một đoạn theo phần của tổng; phần dọn được nhạt hơn. */}
            <div
              className="mt-1 mb-1 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-subtle"
              role="img"
              aria-label={rows.map((r) => `${r.label}: ${formatBytes(r.size)}`).join(', ')}
              data-testid="docker-ov-stack"
            >
              {rows.map((r, i) => {
                const p = parts[i] ?? { used: 0, free: 0 }
                if (p.used + p.free <= 0) return null
                return (
                  <div
                    key={r.id}
                    className="flex h-full min-w-[3px]"
                    style={{ width: `${(p.used + p.free) * 100}%` }}
                    title={`${r.label}: ${t('{used} used · {free} reclaimable', {
                      used: formatBytes(r.size),
                      free: formatBytes(r.reclaimable)
                    })} (${formatPercent(p.used + p.free)})`}
                  >
                    <div className={cx('h-full', COLORS[r.id])} style={{ flexGrow: p.used }} />
                    <div
                      className={cx('h-full opacity-40', COLORS[r.id])}
                      style={{ flexGrow: p.free }}
                    />
                  </div>
                )
              })}
            </div>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
              {rows.map((r) => (
                <span key={r.id} className="inline-flex items-center gap-1.5">
                  <span className={cx('size-2 rounded-sm', COLORS[r.id])} />
                  {r.label}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-sm bg-muted opacity-40" />
                {t('lighter = reclaimable')}
              </span>
            </div>
            <div className="flex flex-col gap-3">
              {rows.map((r, i) => {
                const p = parts[i] ?? { used: 0, free: 0 }
                const what: PruneTarget = r.id
                const canClean = r.reclaimable > 0 || r.reclaimableCount > 0
                return (
                  <div
                    key={r.id}
                    className="flex items-center gap-3"
                    data-testid={`docker-ov-row-${r.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="flex items-center gap-1.5 text-fg">
                          <span className={cx('size-2 rounded-sm', COLORS[r.id])} />
                          {r.label}
                          <span className="text-faint tabular-nums">{r.count}</span>
                        </span>
                        <span
                          className="text-muted tabular-nums"
                          data-testid={`docker-ov-size-${r.id}`}
                        >
                          {t('{used} used · {free} reclaimable', {
                            used: formatBytes(r.size),
                            free: formatBytes(r.reclaimable)
                          })}
                        </span>
                      </div>
                      <div className="mt-1 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-subtle">
                        {p.used > 0 && (
                          <div
                            className={cx('h-full', COLORS[r.id])}
                            style={{ width: `${p.used * 100}%` }}
                          />
                        )}
                        {p.free > 0 && (
                          <div
                            className={cx('h-full opacity-40', COLORS[r.id])}
                            style={{ width: `${p.free * 100}%` }}
                          />
                        )}
                      </div>
                      {r.id === 'images' && (
                        <p className="mt-1 text-[11px] text-faint">
                          {t('Reclaimable = dangling images.')}
                          {unusedImages && (
                            <>
                              {' '}
                              {t('Images no container uses: {size}.', {
                                size: formatBytes(unusedImages.size)
                              })}{' '}
                              {!readOnly && (
                                <button
                                  type="button"
                                  className="text-accent hover:underline"
                                  data-testid="docker-ov-review-images"
                                  onClick={() => {
                                    onPrune('images', true)
                                  }}
                                >
                                  {t('Review…')}
                                </button>
                              )}
                            </>
                          )}
                        </p>
                      )}
                      {r.id === 'volumes' && (
                        <p
                          className="mt-1 text-[11px] text-faint"
                          data-testid="docker-ov-named-volumes"
                        >
                          {t('Reclaimable = anonymous volumes no container uses.')}
                          {namedVolumes && (
                            <>
                              {' '}
                              {tn(
                                namedVolumes.count,
                                'A named volume ({size}) is unused and kept.',
                                '{n} named volumes ({size}) are unused and kept.',
                                { size: formatBytes(namedVolumes.size) }
                              )}{' '}
                              {!readOnly && (
                                <button
                                  type="button"
                                  className="text-accent hover:underline"
                                  data-testid="docker-ov-review-volumes"
                                  onClick={() => {
                                    onPrune('volumes', true)
                                  }}
                                >
                                  {t('Review…')}
                                </button>
                              )}
                            </>
                          )}
                        </p>
                      )}
                    </div>
                    {!readOnly && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="w-24"
                        disabled={!canClean}
                        title={
                          canClean
                            ? t('Preview and remove {size}', { size: formatBytes(r.reclaimable) })
                            : t('Nothing to clean up')
                        }
                        data-testid={`docker-ov-prune-${what}`}
                        onClick={() => {
                          onPrune(what)
                        }}
                      >
                        {t('Clean up')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
