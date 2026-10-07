import { useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Search, Server } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { Pill } from '../../../renderer/src/components/panels'
import type { MapData, MapPod, MapTone } from '../shared/map'
import { ALLOC_BAD, ALLOC_WARN, summarizeNodes, type NodeView } from '../shared/nodes'
import { formatCpu, formatMemory } from '../shared/resources'
import { WORKLOAD_KIND_ID } from '../shared/traffic'
import { formatNumber, t, tn } from '../../registry/renderer-kit'
import type { MapRef } from './mapModel'

/**
 * Bản đồ theo node (góc nhìn hạ tầng): mỗi máy một thẻ — CPU / RAM đã cấp (requests) so với
 * allocatable kèm mức dùng thật, pod đang chạy (chấm màu), taint, áp lực, và cảnh báo workload
 * dồn hết replica vào một máy.
 */

type Sort = 'name' | 'cpu' | 'memory' | 'pods' | 'problems'

const SEVERITY: Record<MapTone, number> = { bad: 3, warn: 2, muted: 1, ok: 0 }

const DOT: Record<MapTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger-solid',
  muted: 'bg-line-strong'
}

const ratio = (v: number, max: number): number => (max > 0 ? v / max : 0)

export function NodesView({
  data,
  shown,
  onOpen
}: {
  /** Toàn bộ dữ liệu (tính cấp phát). */
  data: MapData
  /** Sau bộ lọc nhãn — pod không khớp được làm mờ. */
  shown: MapData
  onOpen: (ref: MapRef) => void
}): React.JSX.Element {
  const summary = useMemo(() => summarizeNodes(data), [data])
  const [sort, setSort] = useState<Sort>('problems')
  const [query, setQuery] = useState('')
  const [risksOpen, setRisksOpen] = useState(false)
  const visible = useMemo(() => new Set(shown.pods.map((p) => `${p.ns}/${p.name}`)), [shown])
  const filtering = shown !== data

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    const key = (n: NodeView): number =>
      sort === 'cpu'
        ? ratio(n.requested.cpu, n.info.allocatable.cpu)
        : sort === 'memory'
          ? ratio(n.requested.memory, n.info.allocatable.memory)
          : sort === 'pods'
            ? n.active
            : sort === 'problems'
              ? SEVERITY[n.tone] * 10 + ratio(n.requested.memory, n.info.allocatable.memory)
              : 0
    return summary.nodes
      .filter(
        (n) =>
          !q ||
          n.info.name.toLowerCase().includes(q) ||
          n.info.roles.some((r) => r.includes(q)) ||
          n.info.zone.toLowerCase().includes(q) ||
          n.info.instance.toLowerCase().includes(q)
      )
      .sort((a, b) => key(b) - key(a) || a.info.name.localeCompare(b.info.name))
  }, [summary, sort, query])

  const totals = useMemo(() => {
    const sum = { cpu: 0, cpuCap: 0, mem: 0, memCap: 0, ready: 0, cordoned: 0 }
    for (const n of summary.nodes) {
      sum.cpu += n.requested.cpu
      sum.cpuCap += n.info.allocatable.cpu
      sum.mem += n.requested.memory
      sum.memCap += n.info.allocatable.memory
      if (n.info.ready) sum.ready++
      if (n.info.unschedulable) sum.cordoned++
    }
    return sum
  }, [summary])

  const risksByNode = useMemo(() => {
    const m = new Map<string, typeof summary.risks>()
    for (const r of summary.risks) m.set(r.node, [...(m.get(r.node) ?? []), r])
    return m
  }, [summary])

  if (!data.nodeList) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-faint">
        {t('Node details are not available — your account may not be allowed to list nodes.')}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="k8s-nodes">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-3 py-2 text-xs">
        <span className="font-medium text-fg" data-testid="k8s-nodes-summary">
          {tn(summary.nodes.length, '{n} node', '{n} nodes')} ·{' '}
          {t('{n} ready', { n: formatNumber(totals.ready) })}
          {totals.cordoned ? ` · ${t('{n} cordoned', { n: formatNumber(totals.cordoned) })}` : ''}
        </span>
        <span className="text-faint tabular-nums">
          {t('CPU requested {used} / {total} ({percent})', {
            used: formatCpu(totals.cpu),
            total: formatCpu(totals.cpuCap),
            percent: `${Math.round(ratio(totals.cpu, totals.cpuCap) * 100)}%`
          })}
        </span>
        <span className="text-faint tabular-nums">
          {t('Memory requested {used} / {total} ({percent})', {
            used: formatMemory(totals.mem),
            total: formatMemory(totals.memCap),
            percent: `${Math.round(ratio(totals.mem, totals.memCap) * 100)}%`
          })}
        </span>
        <div className="flex-1" />
        <div className="flex h-7 w-48 items-center gap-1.5 rounded-md border border-line bg-subtle px-2 focus-within:border-accent">
          <Search size={12} className="text-faint" />
          <input
            type="search"
            placeholder={t('Filter nodes…')}
            aria-label={t('Filter nodes')}
            data-testid="k8s-nodes-filter"
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
        </div>
        <label className="flex h-7 items-center gap-1 rounded-md border border-line pl-2 text-muted">
          <span className="text-faint">{t('Sort')}</span>
          <select
            data-testid="k8s-nodes-sort"
            className="h-full cursor-pointer bg-transparent pr-1 font-medium text-fg outline-none"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort)
            }}
          >
            <option value="problems">{t('problems first')}</option>
            <option value="cpu">{t('CPU requested')}</option>
            <option value="memory">{t('memory requested')}</option>
            <option value="pods">{t('pod count')}</option>
            <option value="name">{t('name')}</option>
          </select>
        </label>
      </div>
      {summary.risks.length > 0 && (
        <div className="shrink-0 border-b border-line bg-warning-soft/40 px-3 py-1.5 text-xs">
          <button
            type="button"
            className="flex items-center gap-1.5 font-medium text-warning"
            data-testid="k8s-nodes-risks"
            aria-expanded={risksOpen}
            onClick={() => {
              setRisksOpen(!risksOpen)
            }}
          >
            {risksOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <AlertTriangle size={13} />
            {tn(
              summary.risks.length,
              '{n} workload has every replica on a single node — losing that node takes it down',
              '{n} workloads have every replica on a single node — losing that node takes them down'
            )}
          </button>
          {risksOpen && (
            <div className="mt-1 flex flex-col pl-6">
              {summary.risks.map((r) => (
                <button
                  key={`${r.ns}/${r.kind}/${r.name}`}
                  type="button"
                  className="flex h-6 items-center gap-2 rounded px-1 text-left hover:bg-hover"
                  data-testid="k8s-nodes-risk"
                  onClick={() => {
                    const kind = WORKLOAD_KIND_ID[r.kind]
                    if (kind) onOpen({ kind, ns: r.ns, name: r.name })
                  }}
                >
                  <span className="font-mono text-fg">
                    {r.ns}/{r.name}
                  </span>
                  <span className="text-faint">
                    {r.kind} ·{' '}
                    {t('{n} replicas on {node}', { n: formatNumber(r.replicas), node: r.node })}
                  </span>
                </button>
              ))}
              <p className="mt-1 text-faint">
                {t('Add a podAntiAffinity or topologySpreadConstraints rule to spread them out.')}
              </p>
            </div>
          )}
        </div>
      )}
      {summary.unscheduled.length > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-xs"
          data-testid="k8s-nodes-unscheduled"
        >
          <Pill tone="warn">
            {tn(
              summary.unscheduled.length,
              '{n} pod waiting for a node',
              '{n} pods waiting for a node'
            )}
          </Pill>
          {summary.unscheduled.slice(0, 8).map((p) => (
            <button
              key={`${p.ns}/${p.name}`}
              type="button"
              className="font-mono text-muted hover:text-accent"
              onClick={() => {
                onOpen({ kind: 'pods', ns: p.ns, name: p.name })
              }}
            >
              {p.ns}/{p.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-3">
        {list.length === 0 ? (
          <p className="p-6 text-center text-xs text-faint">
            {t('No node matches “{query}”.', { query })}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3">
            {list.map((n) => (
              <NodeCard
                key={n.info.name}
                node={n}
                risks={risksByNode.get(n.info.name) ?? []}
                isVisible={(p) => !filtering || visible.has(`${p.ns}/${p.name}`)}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function NodeCard({
  node,
  risks,
  isVisible,
  onOpen
}: {
  node: NodeView
  risks: { ns: string; kind: string; name: string; replicas: number }[]
  isVisible: (p: MapPod) => boolean
  onOpen: (ref: MapRef) => void
}): React.JSX.Element {
  const { info } = node
  return (
    <article
      className={cx(
        'flex flex-col gap-2.5 rounded-xl border bg-surface p-3 shadow-sm',
        node.tone === 'bad'
          ? 'border-danger'
          : node.tone === 'warn'
            ? 'border-warning'
            : 'border-line'
      )}
      data-testid="k8s-node-card"
      data-name={info.name}
      data-tone={node.tone}
    >
      <header className="flex items-start gap-2">
        <Server size={16} className="mt-0.5 shrink-0 text-faint" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cx('size-2 shrink-0 rounded-full', DOT[node.tone])} />
            <button
              type="button"
              className="min-w-0 truncate text-left text-[13px] font-semibold text-fg hover:text-accent"
              title={t('Open {name}', { name: info.name })}
              onClick={() => {
                onOpen({ kind: 'nodes', name: info.name })
              }}
            >
              {info.name}
            </button>
            {info.roles.map((r) => (
              <span
                key={r}
                className="shrink-0 rounded bg-subtle px-1 py-px text-[11px] font-medium text-muted"
              >
                {r}
              </span>
            ))}
            {info.unschedulable && <Pill tone="warn">{t('cordoned')}</Pill>}
          </div>
          <div className="truncate text-[11px] text-faint">
            {[info.zone, info.instance, info.kubelet].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
      </header>
      {node.issues.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="k8s-node-issues">
          {node.issues.map((i) => (
            <Pill key={i.text} tone={i.tone}>
              {i.text}
            </Pill>
          ))}
        </div>
      )}
      <AllocBar
        label="CPU"
        requested={node.requested.cpu}
        used={info.usage?.cpu ?? null}
        capacity={info.allocatable.cpu}
        format={formatCpu}
        testId="k8s-node-cpu"
      />
      <AllocBar
        label={t('Memory')}
        requested={node.requested.memory}
        used={info.usage?.memory ?? null}
        capacity={info.allocatable.memory}
        format={formatMemory}
        testId="k8s-node-memory"
      />
      <div>
        <div className="mb-1 flex justify-between text-[11px]">
          <span className="text-muted">{t('Pods')}</span>
          <span className="text-fg tabular-nums">
            {node.active} / {info.allocatable.pods || '—'}
          </span>
        </div>
        {node.pods.length > 0 ? (
          <div className="flex max-h-28 flex-wrap gap-[3px] overflow-auto">
            {node.pods.map((p) => (
              <button
                key={`${p.ns}/${p.name}`}
                type="button"
                aria-label={`${p.ns}/${p.name}`}
                title={`${p.ns}/${p.name} · ${p.status}${p.restarts ? ` · ${tn(p.restarts, '{n} restart', '{n} restarts')}` : ''}`}
                data-testid="k8s-node-pod"
                data-match={isVisible(p) ? 'true' : 'false'}
                className={cx(
                  'size-2.5 rounded-[3px] transition-transform hover:scale-150',
                  DOT[p.tone],
                  !isVisible(p) && 'opacity-15'
                )}
                onClick={() => {
                  onOpen({ kind: 'pods', ns: p.ns, name: p.name })
                }}
              />
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-faint">{t('No pods.')}</p>
        )}
      </div>
      {info.taints.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="k8s-node-taints">
          {info.taints.map((taint) => (
            <span
              key={`${taint.key}:${taint.effect}`}
              className="rounded border border-line px-1 font-mono text-[11px] text-muted"
              title={t('Taint — only pods that tolerate it are scheduled here')}
            >
              {taint.key}
              {taint.value ? `=${taint.value}` : ''}:{taint.effect}
            </span>
          ))}
        </div>
      )}
      {risks.length > 0 && (
        <div className="text-[11px] text-warning" data-testid="k8s-node-risk">
          {t('All replicas here:')}{' '}
          {risks.map((r, i) => (
            <span key={`${r.ns}/${r.name}`}>
              {i > 0 && ', '}
              <span className="font-mono">{r.name}</span> ({r.replicas})
            </span>
          ))}
        </div>
      )}
    </article>
  )
}

/** Thanh cấp phát: phần đã cấp (requests) tô màu theo ngưỡng, vạch đậm = đang dùng thật. */
function AllocBar({
  label,
  requested,
  used,
  capacity,
  format,
  testId
}: {
  label: string
  requested: number
  used: number | null
  capacity: number
  format: (v: number) => string
  testId: string
}): React.JSX.Element {
  const r = ratio(requested, capacity)
  const u = used === null ? null : ratio(used, capacity)
  const tone = r >= ALLOC_BAD ? 'bg-danger-solid' : r >= ALLOC_WARN ? 'bg-warning' : 'bg-chart'
  return (
    <div data-testid={testId} data-ratio={r.toFixed(2)}>
      <div className="mb-1 flex justify-between gap-2 text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="truncate text-fg tabular-nums">
          {t('{used} / {total} requested', { used: format(requested), total: format(capacity) })}
          <span className="text-faint"> ({Math.round(r * 100)}%)</span>
          {used !== null && (
            <span className="text-faint"> · {t('{value} used', { value: format(used) })}</span>
          )}
        </span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-subtle">
        <div
          className={cx('h-full rounded-full opacity-70', tone)}
          style={{ width: `${Math.min(1, r) * 100}%` }}
        />
        {u !== null && (
          <div
            className="absolute top-0 h-full w-0.5 bg-fg"
            style={{ left: `calc(${Math.min(1, u) * 100}% - 1px)` }}
            title={t('{value} in use', { value: format(used ?? 0) })}
          />
        )}
      </div>
    </div>
  )
}
