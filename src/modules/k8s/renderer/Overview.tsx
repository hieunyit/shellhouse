import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Heading, Meter, StatCard } from '../../../renderer/src/components/panels'
import { Notice } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import type { K8sOp, OverviewResult } from '../shared/ops'
import { age, formatCpu, formatMemory } from '../shared/resources'

/** Trang tổng quan cluster: node, pod, workload, tài nguyên (requests / dùng thật), cảnh báo. */
export function ClusterOverview({
  request,
  namespaces,
  onNavigate
}: {
  request: <T>(op: K8sOp) => Promise<T>
  namespaces: readonly string[]
  onNavigate: (view: string, filter?: string) => void
}): React.JSX.Element {
  const [data, setData] = useState<OverviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const key = namespaces.join(',')
  useEffect(() => {
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
    // Tự làm mới mỗi 30 giây.
    const t = setTimeout(() => {
      setTick((n) => n + 1)
    }, 30_000)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [request, key, tick])

  if (error)
    return (
      <div className="p-4">
        <Notice tone="danger">{error}</Notice>
      </div>
    )
  if (!data)
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-faint">
        Loading cluster overview…
      </div>
    )
  const p = data.pods
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="k8s-overview">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">Cluster overview</h3>
        <span className="text-xs text-faint">
          Kubernetes {data.version} ·{' '}
          {namespaces.length === 0 ? 'all namespaces' : namespaces.join(', ')}
        </span>
        <button
          type="button"
          aria-label="Refresh"
          className="ml-auto rounded p-1 text-faint hover:bg-hover hover:text-fg"
          onClick={() => {
            setTick((n) => n + 1)
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-5">
        <StatCard
          label="Nodes"
          value={`${data.nodes.ready}/${data.nodes.total}`}
          sub={data.nodes.cordoned ? `${data.nodes.cordoned} cordoned` : 'ready'}
          tone={data.nodes.ready < data.nodes.total ? 'warn' : 'ok'}
          onClick={() => {
            onNavigate('nodes')
          }}
          testId="k8s-ov-nodes"
        />
        <StatCard
          label="Running pods"
          value={p.running}
          tone="ok"
          onClick={() => {
            onNavigate('pods', 'Running')
          }}
          testId="k8s-ov-running"
        />
        <StatCard
          label="Pending"
          value={p.pending}
          tone={p.pending ? 'warn' : 'muted'}
          onClick={() => {
            onNavigate('pods', 'Pending')
          }}
        />
        <StatCard
          label="Failing"
          value={p.failed + p.restarting}
          sub={p.restarting ? `${p.restarting} crash-looping` : undefined}
          tone={p.failed + p.restarting ? 'bad' : 'muted'}
          onClick={() => {
            onNavigate('pods', p.restarting ? 'CrashLoopBackOff' : 'Failed')
          }}
          testId="k8s-ov-failing"
        />
        {data.workloads.map((w) => (
          <StatCard
            key={w.kind}
            label={w.kind}
            value={`${w.ready}/${w.total}`}
            sub="ready"
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

      <div className="mt-4 grid gap-4 @3xl:grid-cols-2">
        <div className="rounded-lg border border-line p-3" data-testid="k8s-ov-cpu">
          <Heading>CPU</Heading>
          <div className="flex flex-col gap-2">
            {data.usage && (
              <Meter
                value={data.usage.cpu}
                max={data.capacity.cpu}
                label="Used"
                detail={`${formatCpu(data.usage.cpu)} of ${formatCpu(data.capacity.cpu)}`}
              />
            )}
            <Meter
              value={data.requests.cpu}
              max={data.capacity.cpu}
              label="Requested"
              detail={`${formatCpu(data.requests.cpu)} of ${formatCpu(data.capacity.cpu)}`}
            />
          </div>
        </div>
        <div className="rounded-lg border border-line p-3" data-testid="k8s-ov-memory">
          <Heading>Memory</Heading>
          <div className="flex flex-col gap-2">
            {data.usage && (
              <Meter
                value={data.usage.memory}
                max={data.capacity.memory}
                label="Used"
                detail={`${formatMemory(data.usage.memory)} of ${formatMemory(data.capacity.memory)}`}
              />
            )}
            <Meter
              value={data.requests.memory}
              max={data.capacity.memory}
              label="Requested"
              detail={`${formatMemory(data.requests.memory)} of ${formatMemory(data.capacity.memory)}`}
            />
          </div>
        </div>
      </div>
      {!data.usage && (
        <p className="mt-2 text-xs text-faint">
          Live usage needs metrics-server in the cluster; requests are shown instead.
        </p>
      )}

      <div className="mt-4 rounded-lg border border-line">
        <div className="border-b border-line px-3 py-2">
          <Heading>Warnings ({data.warnings.length})</Heading>
        </div>
        {data.warnings.length === 0 ? (
          <p className="p-3 text-xs text-faint">No warning events.</p>
        ) : (
          <div
            className="max-h-80 divide-y divide-line overflow-auto text-xs"
            data-testid="k8s-ov-warnings"
          >
            {data.warnings.map((w) => (
              <div
                key={`${w.namespace}${w.object}${w.reason}${w.last}`}
                className="grid grid-cols-[8rem_1fr_4rem] gap-3 px-3 py-1.5"
              >
                <span className="truncate font-medium text-warning" title={w.reason}>
                  {w.reason}
                </span>
                <span className="min-w-0">
                  <span className="font-mono text-muted">
                    {w.namespace ? `${w.namespace}/` : ''}
                    {w.object}
                  </span>
                  <span className="ml-2 text-fg">{w.message}</span>
                </span>
                <span className="text-right text-faint">
                  {w.last ? age(Date.parse(w.last)) : ''}
                  {w.count > 1 ? ` ×${w.count}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
