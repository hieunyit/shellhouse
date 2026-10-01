import { useMemo } from 'react'
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { Heading, Sparkline } from '../../../renderer/src/components/panels'
import type { K8sOp } from '../shared/ops'
import type { K8sObject } from '../shared/resources'
import {
  BANDS,
  WORKLOAD_KIND_ID,
  bandOf,
  formatRate,
  type TrafficPeer,
  type TrafficRate
} from '../shared/traffic'
import { useTraffic } from './useTraffic'

type Request = <T>(op: K8sOp) => Promise<T>

/** Loại có tab Traffic. */
export const TRAFFIC_KINDS = new Set(Object.values(WORKLOAD_KIND_ID))

const isSelf = (kindId: string, obj: K8sObject, p: TrafficPeer): boolean =>
  WORKLOAD_KIND_ID[p.kind] === kindId &&
  p.ns === (obj.metadata.namespace ?? '') &&
  p.name === obj.metadata.name

const sum = (rates: readonly TrafficRate[]): number => rates.reduce((n, r) => n + r.rate, 0)

/**
 * Traffic live của workload (Caretta): tổng, vào, ra, theo đối tác và port. Trạng thái rõ ràng:
 * connecting (đang lấy mẫu), live, empty (không có traffic — không phải lỗi), unavailable (không có
 * Caretta / không được đọc).
 */
export function TrafficOf({
  kindId,
  obj,
  request,
  onNavigate
}: {
  kindId: string
  obj: K8sObject
  request: Request
  onNavigate?: (kind: string, name: string, namespace?: string) => void
}): React.JSX.Element {
  const traffic = useTraffic(request, true)
  const mine = useMemo(() => {
    const incoming = traffic.rates.filter((r) => isSelf(kindId, obj, r.server))
    const outgoing = traffic.rates.filter((r) => isSelf(kindId, obj, r.client))
    return {
      incoming: incoming.sort((a, b) => b.rate - a.rate),
      outgoing: outgoing.sort((a, b) => b.rate - a.rate)
    }
  }, [traffic.rates, kindId, obj])
  const history = traffic.history.map((h) => ({
    in: sum(h.rates.filter((r) => isSelf(kindId, obj, r.server))),
    out: sum(h.rates.filter((r) => isSelf(kindId, obj, r.client)))
  }))
  const totalIn = sum(mine.incoming)
  const totalOut = sum(mine.outgoing)
  const status =
    traffic.status === 'live' && !mine.incoming.length && !mine.outgoing.length
      ? 'empty'
      : traffic.status

  return (
    <div className="flex flex-col gap-4" data-testid="k8s-traffic" data-status={status}>
      <div className="flex items-center gap-2 text-xs">
        <span
          className={cx(
            'size-2 rounded-full',
            status === 'live'
              ? 'bg-success'
              : status === 'connecting'
                ? 'animate-pulse bg-warning'
                : 'bg-line-strong'
          )}
        />
        <span className="font-medium text-fg" data-testid="k8s-traffic-status">
          {status === 'live'
            ? 'Live'
            : status === 'connecting'
              ? 'Connecting…'
              : status === 'empty'
                ? 'No traffic'
                : 'Unavailable'}
        </span>
        <span className="text-faint">
          {status === 'live' &&
            `from ${String(traffic.agents)} Caretta agent${traffic.agents === 1 ? '' : 's'} · every 15 s`}
          {status === 'connecting' && 'taking the first two samples to measure throughput'}
          {status === 'empty' &&
            'Caretta is running but saw no connections to or from this workload in the last interval.'}
          {status === 'unavailable' && (traffic.reason ?? 'Caretta is not available')}
        </span>
      </div>
      {status === 'unavailable' && (
        <p className="rounded-md border border-line bg-subtle px-3 py-2 text-xs text-muted">
          Live traffic comes from <span className="font-mono text-fg">Caretta</span> (eBPF, by
          groundcover), read directly from its agents through the API server — no Prometheus needed.
          Install it with{' '}
          <span className="font-mono text-fg">
            helm install caretta groundcover/caretta -n caretta --create-namespace
          </span>
          . Reading its metrics needs permission to{' '}
          <span className="font-mono">get pods/proxy</span> in its namespace.
        </p>
      )}
      {(status === 'live' || status === 'empty') && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2">
            <Total
              label="Total"
              value={totalIn + totalOut}
              series={history.map((h) => h.in + h.out)}
            />
            <Total
              label="Incoming"
              value={totalIn}
              series={history.map((h) => h.in)}
              icon={<ArrowDownLeft size={12} />}
            />
            <Total
              label="Outgoing"
              value={totalOut}
              series={history.map((h) => h.out)}
              icon={<ArrowUpRight size={12} />}
            />
          </div>
          <Peers
            title="Incoming from"
            rates={mine.incoming}
            peer={(r) => r.client}
            {...(onNavigate ? { onNavigate } : {})}
          />
          <Peers
            title="Outgoing to"
            rates={mine.outgoing}
            peer={(r) => r.server}
            {...(onNavigate ? { onNavigate } : {})}
          />
          <p className="text-[11px] text-faint">
            Bands are absolute ({BANDS.map((b) => b.label).join(' · ')}) so traffic is comparable
            across clusters. Traffic sent to a Service is counted for the workloads behind it.
          </p>
        </>
      )}
    </div>
  )
}

function Total({
  label,
  value,
  series,
  icon
}: {
  label: string
  value: number
  series: number[]
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-line p-2" data-testid="k8s-traffic-total">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-muted">
          {icon}
          {label}
        </span>
        <span className="text-sm font-semibold text-fg tabular-nums">{formatRate(value)}</span>
      </div>
      <Sparkline
        values={series.length > 1 ? series : [value, value]}
        max={Math.max(...series, value, 1)}
      />
    </div>
  )
}

function Peers({
  title,
  rates,
  peer,
  onNavigate
}: {
  title: string
  rates: TrafficRate[]
  peer: (r: TrafficRate) => TrafficPeer
  onNavigate?: (kind: string, name: string, namespace?: string) => void
}): React.JSX.Element {
  const max = Math.max(...rates.map((r) => r.rate), 1)
  return (
    <section>
      <Heading>
        {title} <span className="ml-1 font-normal text-faint">{rates.length}</span>
      </Heading>
      {rates.length === 0 && <p className="text-xs text-faint">None</p>}
      <div className="flex flex-col gap-1">
        {rates.map((r) => {
          const p = peer(r)
          const kindId = WORKLOAD_KIND_ID[p.kind] ?? (p.kind === 'Pod' ? 'pods' : '')
          const band = bandOf(r.rate)
          return (
            <div
              key={`${p.kind}|${p.ns}|${p.name}|${r.port}`}
              className="grid grid-cols-[minmax(0,1fr)_3.5rem_6rem_4.5rem] items-center gap-2 text-xs"
              data-testid="k8s-traffic-peer"
              data-name={p.name}
            >
              {kindId && onNavigate ? (
                <button
                  type="button"
                  className="truncate text-left font-mono text-fg hover:text-accent hover:underline"
                  onClick={() => {
                    onNavigate(kindId, p.name, p.ns)
                  }}
                >
                  {p.ns ? `${p.ns}/` : ''}
                  {p.name}
                </button>
              ) : (
                <span className="truncate font-mono text-fg" title={p.name}>
                  {p.name} <span className="text-faint">({p.kind || 'external'})</span>
                </span>
              )}
              <span className="text-right text-faint tabular-nums">
                {r.port ? `:${r.port}` : ''}
              </span>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-subtle"
                title={BANDS[band]?.label}
              >
                <div
                  className={cx(
                    'h-full rounded-full',
                    band >= 4 ? 'bg-warning' : 'bg-accent-solid'
                  )}
                  style={{ width: `${Math.max(4, (r.rate / max) * 100)}%` }}
                />
              </div>
              <span className="text-right text-fg tabular-nums">{formatRate(r.rate)}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
