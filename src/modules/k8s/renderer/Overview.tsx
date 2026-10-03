import { useEffect, useState } from 'react'
import { CheckCircle2, ChevronRight, RefreshCw } from 'lucide-react'
import { Heading, Meter, StatCard } from '../../../renderer/src/components/panels'
import { cx, Notice } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import type { K8sOp, OverviewProblem, OverviewResult, ProblemGroup } from '../shared/ops'
import { formatCpu, formatMemory } from '../shared/resources'
import { TY } from './typography'
import { formatDateTime, formatNumber, formatRelative, t, tn } from '../../registry/renderer-kit'

/** Loại trong sự kiện ("Pod", "Deployment"…) → id loại để mở. */
const KIND_IDS: Record<string, string> = {
  pod: 'pods',
  node: 'nodes',
  service: 'services',
  deployment: 'deployments.apps',
  statefulset: 'statefulsets.apps',
  daemonset: 'daemonsets.apps',
  replicaset: 'replicasets.apps',
  job: 'jobs.batch',
  cronjob: 'cronjobs.batch',
  persistentvolumeclaim: 'persistentvolumeclaims',
  persistentvolume: 'persistentvolumes',
  ingress: 'ingresses.networking.k8s.io',
  horizontalpodautoscaler: 'horizontalpodautoscalers.autoscaling',
  configmap: 'configmaps',
  secret: 'secrets',
  namespace: 'namespaces'
}

const GROUP_ORDER: ProblemGroup[] = ['nodes', 'failing', 'imagePull', 'pending', 'pvcs']

function groupTitle(g: ProblemGroup): string {
  switch (g) {
    case 'nodes':
      return t('Nodes not ready')
    case 'failing':
      return t('Failing pods')
    case 'imagePull':
      return t('Image pull errors')
    case 'pending':
      return t('Pending pods')
    case 'pvcs':
      return t('Unbound volume claims')
  }
}

const relative = (iso: string): string => {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? formatRelative(ms) : ''
}

/** Một dòng có thể bấm để mở tài nguyên. */
function OpenRow({
  onOpen,
  children,
  testId
}: {
  onOpen: (() => void) | null
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  const cls = 'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-1.5 text-left'
  return onOpen ? (
    <button
      type="button"
      className={`${cls} group hover:bg-hover`}
      onClick={onOpen}
      data-testid={testId}
    >
      {children}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {children}
    </div>
  )
}

/** Vấn đề cần xem, theo nhóm — bấm một dòng để mở tài nguyên. */
function Problems({
  problems,
  onOpen
}: {
  problems: NonNullable<OverviewResult['problems']>
  onOpen: (kind: string, ns: string | undefined, name: string) => void
}): React.JSX.Element {
  const groups = GROUP_ORDER.filter((g) => problems[g].total > 0)
  if (groups.length === 0)
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-xs text-muted"
        data-testid="k8s-ov-problems"
      >
        <CheckCircle2 size={14} className="text-success" />
        {t('No problems found — pods, nodes and volume claims look healthy.')}
      </div>
    )
  return (
    <div className="rounded-lg border border-line" data-testid="k8s-ov-problems">
      <div className="border-b border-line px-3 py-2">
        <Heading>{t('Needs attention')}</Heading>
      </div>
      <div className="max-h-[28rem] divide-y divide-line overflow-auto">
        {groups.map((g) => {
          const { total, items } = problems[g]
          return (
            <section key={g} data-testid={`k8s-ov-problem-${g}`}>
              <div className="flex items-center gap-2 bg-subtle px-3 py-1 text-xs font-medium">
                <span className={g === 'pending' || g === 'pvcs' ? 'text-warning' : 'text-danger'}>
                  {groupTitle(g)}
                </span>
                <span className="text-faint tabular-nums">{formatNumber(total)}</span>
              </div>
              {items.map((it: OverviewProblem) => (
                <OpenRow
                  key={`${it.namespace ?? ''}/${it.name}`}
                  onOpen={() => {
                    onOpen(it.kind, it.namespace, it.name)
                  }}
                  testId="k8s-ov-problem"
                >
                  <span className="min-w-0 truncate text-xs">
                    <span className={cx('text-fg', TY.id)}>
                      {it.namespace ? `${it.namespace}/` : ''}
                      {it.name}
                    </span>
                    <span
                      className={`ml-2 font-medium ${g === 'pending' || g === 'pvcs' ? 'text-warning' : 'text-danger'}`}
                    >
                      {it.reason}
                    </span>
                    {it.restarts ? (
                      <span className="ml-2 text-faint">
                        {tn(it.restarts, '{n} restart', '{n} restarts')}
                      </span>
                    ) : null}
                    {it.message && (
                      <span className="ml-2 text-muted" title={it.message}>
                        {it.message}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-faint">
                    <span title={it.since ? formatDateTime(it.since) : undefined}>
                      {it.since ? relative(it.since) : ''}
                    </span>
                    <ChevronRight size={12} className="opacity-0 group-hover:opacity-100" />
                  </span>
                </OpenRow>
              ))}
              {total > items.length && (
                <p className="px-3 py-1 text-[11px] text-faint">
                  {tn(total - items.length, 'and {n} more', 'and {n} more')}
                </p>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/** Trang tổng quan cluster: node, pod, workload, tài nguyên (requests / dùng thật), cảnh báo. */
export function ClusterOverview({
  request,
  namespaces,
  active,
  onNavigate,
  onOpen
}: {
  request: <T>(op: K8sOp) => Promise<T>
  namespaces: readonly string[]
  /** Tab đang hiện — tab ẩn không tự làm mới (op overview liệt kê cả cluster). */
  active: boolean
  onNavigate: (view: string, filter?: string) => void
  /** Mở một tài nguyên (bảng của loại đó + chi tiết). */
  onOpen: (kind: string, ns: string | undefined, name: string) => void
}): React.JSX.Element {
  const [data, setData] = useState<OverviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const key = namespaces.join(',')
  useEffect(() => {
    if (!active) return
    let cancelled = false
    request<OverviewResult>({ op: 'overview', namespaces: key ? key.split(',') : [] }).then(
      (r) => {
        if (!cancelled) {
          setData(r)
          setError(null)
        }
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    // Tự làm mới mỗi 30 giây khi tab đang hiện; quay lại tab → làm mới ngay.
    const timer = setTimeout(() => {
      setTick((n) => n + 1)
    }, 30_000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [request, key, tick, active])

  if (error && !data)
    return (
      <div className="p-4">
        <Notice tone="danger">{error}</Notice>
      </div>
    )
  if (!data)
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-faint">
        {t('Loading cluster overview…')}
      </div>
    )
  const p = data.pods
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="k8s-overview">
      {error && (
        <div className="mb-3">
          <Notice tone="danger">
            {t('Could not refresh — showing the last data. {error}', { error })}
          </Notice>
        </div>
      )}
      {data.truncated && (
        <div className="mb-3">
          <Notice tone="info" testId="k8s-ov-truncated">
            {t(
              'This cluster is very large — the numbers below are counted on the first part of it only. Pick a namespace for exact numbers.'
            )}
          </Notice>
        </div>
      )}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">{t('Cluster overview')}</h3>
        <span className="text-xs text-faint">
          Kubernetes {data.version} ·{' '}
          {namespaces.length === 0 ? t('all namespaces') : namespaces.join(', ')}
        </span>
        <button
          type="button"
          aria-label={t('Refresh')}
          className="ml-auto rounded p-1 text-faint hover:bg-hover hover:text-fg"
          onClick={() => {
            setTick((n) => n + 1)
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {/* auto-fit: mọi thẻ cùng một hàng khi đủ rộng — không để thẻ lẻ một mình một hàng. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2">
        <StatCard
          label={t('Nodes')}
          value={`${formatNumber(data.nodes.ready)}/${formatNumber(data.nodes.total)}`}
          sub={
            data.nodes.cordoned
              ? t('{n} cordoned', { n: formatNumber(data.nodes.cordoned) })
              : t('ready')
          }
          tone={data.nodes.ready < data.nodes.total ? 'warn' : 'ok'}
          onClick={() => {
            onNavigate('nodes')
          }}
          testId="k8s-ov-nodes"
        />
        <StatCard
          label={t('Running pods')}
          value={formatNumber(p.running)}
          tone="ok"
          onClick={() => {
            onNavigate('pods', 'Running')
          }}
          testId="k8s-ov-running"
        />
        <StatCard
          label={t('Pending')}
          value={formatNumber(p.pending)}
          tone={p.pending ? 'warn' : 'muted'}
          onClick={() => {
            onNavigate('pods', 'Pending')
          }}
        />
        <StatCard
          label={t('Failing')}
          value={formatNumber(p.failed + p.restarting)}
          sub={p.restarting ? t('{n} crash-looping', { n: formatNumber(p.restarting) }) : undefined}
          tone={p.failed + p.restarting ? 'bad' : 'muted'}
          onClick={() => {
            onNavigate('pods', p.restarting ? 'CrashLoopBackOff' : 'Failed')
          }}
          testId="k8s-ov-failing"
        />
        {/* Loại không có đối tượng nào (0/0) → không chiếm thẻ; ghi gọn ở dòng dưới. */}
        {data.workloads
          .filter((w) => w.total > 0)
          .map((w) => (
            <StatCard
              key={w.kind}
              label={w.kind}
              value={`${formatNumber(w.ready)}/${formatNumber(w.total)}`}
              sub={t('ready')}
              tone={w.total === 0 ? 'muted' : w.ready < w.total ? 'warn' : 'ok'}
              onClick={() => {
                onNavigate(
                  w.kind === 'Deployments'
                    ? 'deployments.apps'
                    : w.kind === 'StatefulSets'
                      ? 'statefulsets.apps'
                      : 'daemonsets.apps'
                )
              }}
            />
          ))}
      </div>
      {data.workloads.some((w) => w.total === 0) && (
        <p className="mt-1.5 text-[11px] text-faint" data-testid="k8s-ov-empty-workloads">
          {t('None in view: {kinds}', {
            kinds: data.workloads
              .filter((w) => w.total === 0)
              .map((w) => w.kind)
              .join(', ')
          })}
        </p>
      )}

      {data.problems && (
        <div className="mt-4">
          <Problems problems={data.problems} onOpen={onOpen} />
        </div>
      )}

      <div className="mt-4 grid gap-4 @3xl:grid-cols-2">
        <div className="rounded-lg border border-line p-3" data-testid="k8s-ov-cpu">
          <Heading>CPU</Heading>
          <div className="flex flex-col gap-2">
            {data.usage && (
              <Meter
                value={data.usage.cpu}
                max={data.capacity.cpu}
                label={t('Used')}
                detail={t('{used} of {total}', {
                  used: formatCpu(data.usage.cpu),
                  total: formatCpu(data.capacity.cpu)
                })}
              />
            )}
            <Meter
              value={data.requests.cpu}
              max={data.capacity.cpu}
              label={t('Requested')}
              detail={t('{used} of {total}', {
                used: formatCpu(data.requests.cpu),
                total: formatCpu(data.capacity.cpu)
              })}
            />
          </div>
        </div>
        <div className="rounded-lg border border-line p-3" data-testid="k8s-ov-memory">
          <Heading>{t('Memory')}</Heading>
          <div className="flex flex-col gap-2">
            {data.usage && (
              <Meter
                value={data.usage.memory}
                max={data.capacity.memory}
                label={t('Used')}
                detail={t('{used} of {total}', {
                  used: formatMemory(data.usage.memory),
                  total: formatMemory(data.capacity.memory)
                })}
              />
            )}
            <Meter
              value={data.requests.memory}
              max={data.capacity.memory}
              label={t('Requested')}
              detail={t('{used} of {total}', {
                used: formatMemory(data.requests.memory),
                total: formatMemory(data.capacity.memory)
              })}
            />
          </div>
        </div>
      </div>
      {!data.usage && (
        <p className="mt-2 text-xs text-faint">
          {t('Live usage needs metrics-server in the cluster; requests are shown instead.')}
        </p>
      )}

      <div className="mt-4 rounded-lg border border-line">
        <div className="border-b border-line px-3 py-2">
          <Heading>
            {t('Recent warning events ({n})', { n: formatNumber(data.warnings.length) })}
          </Heading>
        </div>
        {data.warnings.length === 0 ? (
          <p className="p-3 text-xs text-faint">{t('No warning events.')}</p>
        ) : (
          <div
            className="max-h-80 divide-y divide-line overflow-auto text-xs"
            data-testid="k8s-ov-warnings"
          >
            {data.warnings.map((w) => {
              const [kindName = '', name = ''] = w.object.split('/')
              const kindId = KIND_IDS[kindName]
              return (
                <OpenRow
                  key={`${w.namespace}${w.object}${w.reason}${w.last}`}
                  onOpen={
                    kindId && name
                      ? () => {
                          onOpen(
                            kindId,
                            kindId === 'nodes' ? undefined : w.namespace || undefined,
                            name
                          )
                        }
                      : null
                  }
                >
                  <span className="grid min-w-0 grid-cols-[8rem_1fr] gap-3 text-xs">
                    <span className="truncate font-medium text-warning" title={w.reason}>
                      {w.reason}
                    </span>
                    <span className="min-w-0 truncate" title={w.message}>
                      <span className={cx('text-muted', TY.id)}>
                        {w.namespace ? `${w.namespace}/` : ''}
                        {w.object}
                      </span>
                      <span className="ml-2 text-fg">{w.message}</span>
                    </span>
                  </span>
                  <span
                    className="text-right text-[11px] text-faint tabular-nums"
                    title={w.last ? formatDateTime(w.last) : undefined}
                  >
                    {w.last ? relative(w.last) : ''}
                    {w.count > 1 ? ` ×${formatNumber(w.count)}` : ''}
                  </span>
                </OpenRow>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
