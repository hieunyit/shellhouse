/** Bảng bên phải của bản đồ (mục đang chọn, quan hệ, traffic, thao tác) và thẻ nổi khi rê chuột. */
import { useMemo } from 'react'
import {
  Box,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  FileText,
  Locate,
  SquareTerminal,
  X
} from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { Heading, Pill } from '../../../renderer/src/components/panels'
import { formatRelative, t, tn } from '../../registry/renderer-kit'
import { formatCpu, formatMemory } from '../shared/resources'
import {
  TECH,
  impactOf,
  workloadKindLabel,
  type MapEdge,
  type MapLayout,
  type MapNode
} from '../shared/map'
import { type TrafficPeer, type TrafficRate } from '../shared/traffic'
import { trafficText as formatRate } from './topology/text'
import { TechIcon } from './icons'
import { type TrafficState } from './useTraffic'
import { type MapRef, kindTitle, routeTitle, titleOf, peerLabel, DOT } from './mapModel'

/** "2 pods", "1 service"… — số mục bị ảnh hưởng theo loại. */
function impactText(kind: MapNode['kind'], n: number): string {
  switch (kind) {
    case 'pod':
      return tn(n, '{n} pod', '{n} pods')
    case 'service':
      return tn(n, '{n} service', '{n} services')
    case 'route':
      return tn(n, '{n} route', '{n} routes')
    case 'workload':
      return tn(n, '{n} workload', '{n} workloads')
    case 'pvc':
      return tn(n, '{n} volume', '{n} volumes')
    case 'gateway':
      return tn(n, '{n} gateway', '{n} gateways')
    case 'policy':
      return tn(n, '{n} policy', '{n} policies')
    default:
      return `${String(n)} ${kind}`
  }
}

/** Traffic của workload đang chọn (bảng bên phải). */
function TrafficSection({
  traffic
}: {
  traffic: {
    status: TrafficState['status']
    reason: string | undefined
    incoming: TrafficRate[]
    outgoing: TrafficRate[]
  }
}): React.JSX.Element {
  const row = (r: TrafficRate, peer: TrafficPeer): React.JSX.Element => (
    <div
      key={`${peer.kind}|${peer.ns}|${peer.name}`}
      className="flex h-6 items-center gap-2 text-xs"
      data-testid="k8s-map-traffic-row"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-fg" title={peerLabel(peer)}>
        {peerLabel(peer)}
      </span>
      <span className="shrink-0 text-faint tabular-nums">{formatRate(r.rate)}</span>
    </div>
  )
  return (
    <section data-testid="k8s-map-node-traffic">
      <Heading>{t('Live traffic')}</Heading>
      {traffic.status === 'unavailable' && (
        <p className="text-xs text-faint">
          {t('Unavailable — {reason}.', {
            reason: traffic.reason ?? t('Caretta is not installed')
          })}
        </p>
      )}
      {traffic.status === 'connecting' && (
        <p className="text-xs text-faint">{t('Measuring traffic from Caretta…')}</p>
      )}
      {traffic.status === 'live' && !traffic.incoming.length && !traffic.outgoing.length && (
        <p className="text-xs text-faint">{t('No traffic observed in the last minute.')}</p>
      )}
      {traffic.incoming.length > 0 && (
        <>
          <div className="mt-1 text-[11px] text-faint">{t('Called by')}</div>
          {traffic.incoming.map((r) => row(r, r.client))}
        </>
      )}
      {traffic.outgoing.length > 0 && (
        <>
          <div className="mt-1 text-[11px] text-faint">{t('Calls')}</div>
          {traffic.outgoing.map((r) => row(r, r.server))}
        </>
      )}
    </section>
  )
}

/** Bảng bên phải: mục đang chọn, quan hệ (bấm để bay tới), thao tác. */
export function MapPanel({
  node,
  layout,
  index,
  onClose,
  onGo,
  onOpen,
  onLogs,
  onShell,
  folded,
  onToggleNs,
  impact,
  onImpact,
  traffic
}: {
  node: MapNode
  layout: MapLayout | null
  index: { byId: Map<string, MapNode>; edgesOf: Map<string, MapEdge[]>; ordered: MapNode[] }
  onClose: () => void
  onGo: (n: MapNode) => void
  onOpen: (ref: MapRef) => void
  onLogs: (ref: MapRef) => void
  /** Không có (chỉ đọc) → ẩn nút Shell. */
  onShell?: ((ref: MapRef) => void) | undefined
  /** Namespace: đang gập không (null = không phải namespace). */
  folded: boolean | null
  onToggleNs: (ns: string) => void
  impact: boolean
  onImpact: (on: boolean) => void
  traffic: React.ComponentProps<typeof TrafficSection>['traffic'] | null
}): React.JSX.Element {
  const affected = useMemo(
    () =>
      layout && node.kind !== 'region' && node.kind !== 'namespace'
        ? impactOf(layout, node.id)
        : null,
    [layout, node]
  )
  const affectedCounts = (() => {
    const counts = new Map<string, number>()
    for (const id of affected ?? []) {
      const n = index.byId.get(id)
      if (!n) continue
      counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
    }
    return [...counts.entries()].map(([k, n]) => impactText(k as MapNode['kind'], n))
  })()
  const tech = node.tech ? TECH[node.tech] : undefined
  const typeTitle =
    node.kind === 'route'
      ? routeTitle(node.ref?.kind ?? '')
      : node.kind === 'workload' && node.ref
        ? workloadKindLabel(node.ref.kind)
        : kindTitle(node.kind)
  const edges = index.edgesOf.get(node.id) ?? []
  const linked = (dir: 'in' | 'out'): MapNode[] =>
    edges
      .filter((e) => (dir === 'in' ? e.to === node.id : e.from === node.id))
      .map((e) => index.byId.get(dir === 'in' ? e.from : e.to))
      .filter((n): n is MapNode => Boolean(n))
  const incoming = linked('in')
  // NetworkPolicy có mục riêng — không lẫn vào "Uses".
  const outgoing = linked('out').filter((n) => n.kind !== 'policy')
  const children = index.ordered.filter((n) => n.parent === node.id)
  const parent = node.parent ? index.byId.get(node.parent) : undefined
  const policies = layout?.policies[node.id] ?? []
  const podTones = children.filter((c) => c.kind === 'pod')
  const isWorkload = node.kind === 'workload' && Boolean(node.ref)

  const section = (title: string, list: MapNode[]): React.JSX.Element | null =>
    list.length === 0 ? null : (
      <section>
        <Heading>
          {title} <span className="ml-1 font-normal text-faint">{list.length}</span>
        </Heading>
        <div className="flex flex-col">
          {list.slice(0, 200).map((n) => (
            <button
              key={n.id}
              type="button"
              className="group flex h-7 items-center gap-2 rounded px-1 text-left text-xs hover:bg-hover"
              data-testid="k8s-map-link"
              data-name={n.label}
              onClick={() => {
                onGo(n)
              }}
            >
              <span className={cx('size-1.5 shrink-0 rounded-full', DOT[n.tone])} />
              <span className="min-w-0 flex-1 truncate font-mono text-fg group-hover:text-accent">
                {n.label}
              </span>
              <span className="shrink-0 truncate text-faint">
                {n.kind === 'route'
                  ? routeTitle(n.ref?.kind ?? '')
                  : n.kind === 'workload' && n.ref
                    ? workloadKindLabel(n.ref.kind)
                    : kindTitle(n.kind)}
              </span>
            </button>
          ))}
        </div>
      </section>
    )

  return (
    <>
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg" title={node.label}>
              {node.label}
            </span>
            {node.kind !== 'region' && node.kind !== 'namespace' && (
              <Pill tone={node.tone}>
                {node.tone === 'ok'
                  ? t('healthy')
                  : node.tone === 'bad'
                    ? t('failing')
                    : node.tone === 'warn'
                      ? t('degraded')
                      : '—'}
              </Pill>
            )}
          </div>
          <div className="truncate text-xs text-faint">
            {typeTitle}
            {node.ns && node.kind !== 'namespace' ? ` · ${node.ns}` : ''}
          </div>
        </div>
        <button
          type="button"
          aria-label={t('Close')}
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-line px-2 py-1.5">
        {node.ref && (
          <PanelAction
            icon={<ExternalLink size={13} />}
            label={node.kind === 'namespace' ? t('Show resources') : t('Open details')}
            testId="k8s-map-open"
            onClick={() => {
              if (node.ref) onOpen(node.ref)
            }}
          />
        )}
        {(isWorkload || node.kind === 'pod') && node.ref?.kind !== 'cronjobs.batch' && (
          <PanelAction
            icon={<FileText size={13} />}
            label={t('Logs')}
            onClick={() => {
              if (node.ref) onLogs(node.ref)
            }}
          />
        )}
        {node.kind === 'pod' && onShell && (
          <PanelAction
            icon={<SquareTerminal size={13} />}
            label={t('Shell')}
            onClick={() => {
              if (node.ref) onShell(node.ref)
            }}
          />
        )}
        {folded !== null && (
          <PanelAction
            icon={folded ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
            label={folded ? t('Expand') : t('Collapse')}
            testId="k8s-map-panel-fold"
            onClick={() => {
              if (node.ns) onToggleNs(node.ns)
            }}
          />
        )}
        <PanelAction
          icon={<Locate size={13} />}
          label={t('Center')}
          onClick={() => {
            onGo(node)
          }}
        />
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3"
        data-testid="k8s-map-details"
      >
        {isWorkload && (
          <div
            className="grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line"
            data-testid="k8s-map-stats"
          >
            {(
              [
                [
                  t('Ready'),
                  node.replicas
                    ? `${String(node.replicas.ready)}/${String(node.replicas.desired)}`
                    : String(podTones.length),
                  node.tone === 'bad' ? 'text-danger' : node.tone === 'warn' ? 'text-warning' : ''
                ],
                [
                  t('Restarts'),
                  String(podTones.reduce((n, p) => n + (p.pod?.restarts ?? 0), 0)),
                  podTones.some((p) => (p.pod?.restarts ?? 0) > 0) ? 'text-warning' : ''
                ],
                [
                  t('In / out'),
                  traffic?.status === 'live'
                    ? `${formatRate(traffic.incoming.reduce((n, r) => n + r.rate, 0))} / ${formatRate(traffic.outgoing.reduce((n, r) => n + r.rate, 0))}`
                    : '—',
                  ''
                ],
                [t('Affected'), affected ? String(affected.size) : '—', '']
              ] as const
            ).map(([k, v, tone]) => (
              <div key={k} className="flex flex-col gap-0.5 bg-surface px-2.5 py-1.5">
                <span className="text-[10px] tracking-wide text-faint uppercase">{k}</span>
                <span
                  className={cx('truncate text-[12.5px] font-semibold text-fg tabular-nums', tone)}
                >
                  {v}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-muted">{node.sub}</p>
        {tech && (
          <p className="flex items-center gap-1.5 text-xs text-muted" data-testid="k8s-map-tech">
            {node.tech && <TechIcon tech={node.tech} size={18} />}
            {tech.label}
          </p>
        )}
        {node.techs && node.techs.length > 0 && (
          <p className="text-xs text-muted">
            Runs {node.techs.map((id) => TECH[id]?.label ?? id).join(', ')}
          </p>
        )}
        {affected && (
          <section data-testid="k8s-map-impact">
            <Heading
              action={
                <button
                  type="button"
                  aria-pressed={impact}
                  data-testid="k8s-map-impact-toggle"
                  className={cx(
                    'rounded px-1.5 py-0.5 text-[11px] font-medium',
                    impact ? 'bg-warning-soft text-warning' : 'text-accent hover:bg-hover'
                  )}
                  onClick={() => {
                    onImpact(!impact)
                  }}
                >
                  {impact ? t('Showing') : t('Show on map')}
                </button>
              }
            >
              Blast radius
            </Heading>
            <p className="text-xs text-muted" data-testid="k8s-map-impact-summary">
              {affected.size === 0
                ? t('Nothing else on the map depends on it.')
                : t('If it changes or fails: {list}.', { list: affectedCounts.join(' · ') })}
            </p>
          </section>
        )}
        {node.badges && node.badges.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {node.badges.map((b) => (
              <Pill key={b} tone="info">
                {b}
              </Pill>
            ))}
          </div>
        )}
        {node.stats && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Stat label={t('Workloads')} value={node.stats.workloads} />
            <Stat label={t('Pods')} value={node.stats.pods} />
            <Stat
              label={t('Degraded')}
              value={node.stats.warn}
              tone={node.stats.warn ? 'text-warning' : undefined}
            />
            <Stat
              label={t('Failing')}
              value={node.stats.bad}
              tone={node.stats.bad ? 'text-danger' : undefined}
            />
          </div>
        )}
        {traffic && traffic.status !== 'off' && <TrafficSection traffic={traffic} />}
        {podTones.length > 0 && (
          <section>
            <Heading>
              Pods <span className="ml-1 font-normal text-faint">{podTones.length}</span>
            </Heading>
            <div className="flex flex-wrap gap-1">
              {podTones.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  title={`${p.label} — ${p.sub}`}
                  className={cx(
                    'size-3 rounded-full ring-offset-1 hover:ring-2 hover:ring-accent',
                    DOT[p.tone]
                  )}
                  onClick={() => {
                    onGo(p)
                  }}
                />
              ))}
            </div>
          </section>
        )}
        {section(
          node.kind === 'workload'
            ? t('Receives traffic from')
            : node.kind === 'policy'
              ? t('Applies to')
              : node.kind === 'route'
                ? t('Gateways')
                : t('Linked from'),
          incoming
        )}
        {section(
          node.kind === 'service'
            ? t('Sends traffic to')
            : node.kind === 'route'
              ? t('Routes to')
              : node.kind === 'gateway'
                ? t('Routes attached')
                : t('Uses'),
          outgoing
        )}
        {policies.length > 0 && (
          <section>
            <Heading>{t('Network policies')}</Heading>
            <div className="flex flex-col gap-0.5 text-xs">
              {policies.map((p) => (
                <span key={p} className="flex items-center gap-1.5 font-mono text-fg">
                  <Box size={11} className="text-faint" /> {p}
                </span>
              ))}
            </div>
          </section>
        )}
        {node.kind !== 'workload' &&
          node.kind !== 'pod' &&
          section(
            node.kind === 'region' ? t('Namespaces') : t('Inside'),
            children.filter((c) => c.kind !== 'pod')
          )}
        {parent && parent.kind !== 'region' && (
          <section>
            <Heading>{t('In')}</Heading>
            <button
              type="button"
              className="flex h-7 items-center gap-2 rounded px-1 text-left text-xs hover:bg-hover"
              onClick={() => {
                onGo(parent)
              }}
            >
              <span className={cx('size-1.5 shrink-0 rounded-full', DOT[parent.tone])} />
              <span className="font-mono text-fg">{parent.label}</span>
              <span className="text-faint">{kindTitle(parent.kind)}</span>
            </button>
          </section>
        )}
      </div>
    </>
  )
}

function PanelAction({
  icon,
  label,
  testId,
  onClick
}: {
  icon: React.ReactNode
  label: string
  testId?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap text-muted hover:bg-hover hover:text-fg"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}

function Stat({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone?: string | undefined
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-line px-2 py-1.5">
      <div className="text-[11px] text-faint">{label}</div>
      <div className={cx('text-sm font-semibold tabular-nums', tone ?? 'text-fg')}>{value}</div>
    </div>
  )
}

/** Thanh nhỏ: đang dùng so với request (vượt request → màu cảnh báo). */
function UsageBar({
  label,
  used,
  request,
  format
}: {
  label: string
  used: number
  request: number | undefined
  format: (v: number) => string
}): React.JSX.Element {
  const ratio = request ? used / request : 0
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between gap-3 text-[11px]">
        <span className="text-faint">{label}</span>
        <span className="text-fg tabular-nums">
          {format(used)}
          {request ? (
            <span className="text-faint">
              {' '}
              / {format(request)} {t('requested')}
            </span>
          ) : null}
        </span>
      </div>
      {request ? (
        <div className="h-1 overflow-hidden rounded-full bg-subtle">
          <div
            className="h-full rounded-full"
            style={{
              width: `${String(Math.min(100, ratio * 100))}%`,
              background: ratio > 1 ? 'var(--map-warn)' : 'var(--map-accent)'
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

/** Bảng nổi khi rê chuột: pod (trạng thái, restart, node, IP, tuổi, CPU / RAM), workload, v.v. */
export function HoverCard({
  node,
  podsOf,
  x,
  y,
  bottom
}: {
  node: MapNode
  podsOf: ReadonlyMap<string, MapNode[]>
  x: number
  y?: number
  bottom?: number
}): React.JSX.Element {
  const pod = node.kind === 'pod' ? node.pod : undefined
  const pods = node.kind === 'workload' ? (podsOf.get(node.id) ?? []) : []
  const restarts = pods.reduce((n, p) => n + (p.pod?.restarts ?? 0), 0)
  const row = (k: string, v: React.ReactNode, tone?: string): React.JSX.Element => (
    <>
      <span className="text-faint">{k}</span>
      <span className={cx('truncate text-right font-mono text-fg', tone)}>{v}</span>
    </>
  )
  return (
    <div
      className="pointer-events-none absolute z-20 w-72 rounded-xl border border-line bg-elevated/95 p-2.5 text-xs shadow-xl backdrop-blur-sm"
      style={{ left: x, ...(bottom !== undefined ? { bottom } : { top: y }) }}
      data-testid="k8s-map-tooltip"
    >
      <div className="flex items-center gap-2">
        <span className={cx('size-2 shrink-0 rounded-full', DOT[node.tone])} />
        <span className="min-w-0 flex-1 truncate font-semibold text-fg">{node.label}</span>
        <span className="shrink-0 text-[11px] text-faint">{titleOf(node)}</span>
      </div>
      {pod ? (
        <>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
            {row(t('Status'), pod.status, node.tone === 'bad' ? '!text-danger' : undefined)}
            {row(t('Restarts'), pod.restarts, pod.restarts > 0 ? '!text-warning' : undefined)}
            {pod.node && row(t('Node'), pod.node)}
            {pod.ip && row('IP', pod.ip)}
            {pod.startedAt ? row(t('Up'), formatRelative(pod.startedAt)) : null}
          </div>
          {pod.usage ? (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-2">
              <UsageBar label="CPU" used={pod.usage.cpu} request={pod.cpu} format={formatCpu} />
              <UsageBar
                label={t('Memory')}
                used={pod.usage.memory}
                request={pod.memory}
                format={formatMemory}
              />
            </div>
          ) : (
            <p className="mt-2 border-t border-line pt-1.5 text-[11px] text-faint">
              {t('No live CPU / memory (metrics-server not available).')}
            </p>
          )}
        </>
      ) : node.kind === 'workload' ? (
        <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          {node.replicas &&
            row(t('Ready'), `${String(node.replicas.ready)} / ${String(node.replicas.desired)}`)}
          {row(t('Pods'), pods.length)}
          {row(t('Restarts'), restarts, restarts > 0 ? '!text-warning' : undefined)}
          {node.status && !node.replicas && row(t('Status'), node.status)}
          {node.badges && node.badges.length > 0 && row('', node.badges.join(' · '))}
        </div>
      ) : (
        node.sub && <div className="mt-1 truncate font-mono text-[11px] text-faint">{node.sub}</div>
      )}
    </div>
  )
}
