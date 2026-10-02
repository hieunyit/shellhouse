import { useEffect, useState } from 'react'
import { Heading, Meter, StatCard } from '../../../renderer/src/components/panels'
import { Button, Notice } from '../../../renderer/src/components/ui'
import { cleanError, formatSize } from '../../../renderer/src/lib/format'
import type { ContainerRow, DiskUsage, DockerOp, EngineInfo, PruneTarget } from '../shared/ops'

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
  onPrune: (what: PruneTarget) => void
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
    containers?.filter((c) => /unhealthy|restarting/i.test(c.status) || c.state === 'dead')
      .length ?? 0
  const projects = new Set(containers?.map((c) => c.project).filter(Boolean)).size
  const total = df ? df.images.size + df.containers.size + df.volumes.size + df.buildCache.size : 0
  const rows: { label: string; what: PruneTarget | null; d: DiskUsage['images'] | undefined }[] = [
    { label: 'Images', what: 'images', d: df?.images },
    { label: 'Containers', what: 'containers', d: df?.containers },
    { label: 'Volumes', what: 'volumes', d: df?.volumes },
    { label: 'Build cache', what: null, d: df?.buildCache }
  ]
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="docker-overview">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">{info?.version ?? 'Docker'}</h3>
        <span className="text-xs text-faint">
          {info?.os}
          {info?.via === 'cli' ? ' · via docker CLI' : ''}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-5">
        <StatCard
          label="Running"
          value={running}
          tone={running ? 'ok' : 'muted'}
          onClick={() => {
            onNavigate('containers', 'running')
          }}
          testId="docker-ov-running"
        />
        <StatCard
          label="Stopped"
          value={stopped}
          onClick={() => {
            onNavigate('containers', 'stopped')
          }}
        />
        <StatCard
          label="Unhealthy"
          value={unhealthy}
          tone={unhealthy ? 'bad' : 'muted'}
          onClick={() => {
            onNavigate('containers')
          }}
        />
        <StatCard
          label="Images"
          value={df?.images.count ?? info?.images ?? '—'}
          onClick={() => {
            onNavigate('images')
          }}
        />
        <StatCard
          label="Compose projects"
          value={projects}
          onClick={() => {
            onNavigate('compose')
          }}
        />
      </div>
      <div className="mt-4 rounded-lg border border-line p-3" data-testid="docker-ov-disk">
        <Heading>Disk usage {df ? `— ${formatSize(total)}` : ''}</Heading>
        {error && <Notice tone="danger">{error}</Notice>}
        {!df && !error && <p className="text-xs text-faint">Calculating…</p>}
        {df && (
          <div className="flex flex-col gap-3">
            {rows.map((r) => (
              <div key={r.label} className="flex items-end gap-3">
                <div className="min-w-0 flex-1">
                  <Meter
                    value={r.d?.reclaimable ?? 0}
                    max={Math.max(r.d?.size ?? 0, 1)}
                    neutral
                    label={`${r.label} (${r.d?.count ?? 0})`}
                    detail={`${formatSize(r.d?.size ?? 0)} · ${formatSize(r.d?.reclaimable ?? 0)} reclaimable`}
                  />
                </div>
                {!readOnly && r.what && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!r.d?.reclaimable && r.what !== 'containers'}
                    data-testid={`docker-ov-prune-${r.what}`}
                    onClick={() => {
                      if (r.what) onPrune(r.what)
                    }}
                  >
                    Clean up
                  </Button>
                )}
                {/* Giữ chỗ cột nút → mọi thanh cùng độ dài. */}
                {!readOnly && !r.what && (
                  <span aria-hidden className="invisible">
                    <Button size="sm" variant="ghost" tabIndex={-1}>
                      Clean up
                    </Button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
