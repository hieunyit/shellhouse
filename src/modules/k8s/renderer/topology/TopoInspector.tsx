import {
  AlertOctagon,
  AlertTriangle,
  Cable,
  Crosshair,
  ExternalLink,
  FileCode2,
  FileText,
  Info,
  SquareTerminal,
  X
} from 'lucide-react'
import { cx } from '../../../../renderer/src/components/ui'
import { DefList, Heading, Pill } from '../../../../renderer/src/components/panels'
import { formatRelative, t, tn } from '../../../registry/renderer-kit'
import { formatCpu, formatMemory } from '../../shared/resources'
import { TECH, type MapPod, type MapTone } from '../../shared/map'
import { selectorText, type TopoEdge, type TopoNode } from '../../shared/appTopology'
import type { TrafficRate } from '../../shared/traffic'
import { KindIcon, TechIcon } from '../icons'
import type { MapRef } from '../mapModel'
import type { TrafficState } from '../useTraffic'
import { rateText, useTrafficUnit } from '../trafficUnit'

const DOT: Record<MapTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger-solid',
  muted: 'bg-line-strong'
}

const ICON_KIND: Record<string, string> = {
  gateway: 'gateways.gateway.networking.k8s.io',
  ingress: 'ingresses.networking.k8s.io',
  lb: 'services',
  route: 'httproutes.gateway.networking.k8s.io',
  service: 'services',
  configmap: 'configmaps',
  secret: 'secrets',
  pvc: 'persistentvolumeclaims',
  pods: 'pods',
  namespace: 'namespaces'
}

function toneLabel(n: TopoNode): string {
  if (n.missing) return t('not found')
  return n.tone === 'ok'
    ? t('healthy')
    : n.tone === 'bad'
      ? t('failing')
      : n.tone === 'warn'
        ? t('degraded')
        : t('idle')
}

export interface NodeTraffic {
  status: TrafficState['status']
  reason: string | undefined
  incoming: TrafficRate[]
  outgoing: TrafficRate[]
  updated: number
}

/**
 * Bảng bên phải của Topology: sự thật chính của mục đang chọn, vấn đề (giải thích bằng lời), quan hệ
 * (bấm để tới), thao tác (chi tiết, log, shell, YAML, tập trung đường đi) và traffic live nếu có.
 */
export function TopoInspector({
  node,
  pod,
  nodes,
  edges,
  traffic,
  focused,
  onClose,
  onGo,
  onOpen,
  onLogs,
  onShell,
  onPortForward,
  onYaml,
  onFocus
}: {
  node: TopoNode
  /** Pod đang chọn trong nhóm pod. */
  pod: MapPod | null
  nodes: ReadonlyMap<string, TopoNode>
  edges: readonly TopoEdge[]
  traffic: NodeTraffic | null
  focused: boolean
  onClose: () => void
  onGo: (id: string) => void
  onOpen: (ref: MapRef) => void
  onLogs: (ref: MapRef) => void
  onShell?: ((ref: MapRef) => void) | undefined
  onPortForward?: ((ref: MapRef) => void) | undefined
  onYaml: (ref: MapRef) => void
  onFocus: (id: string | null) => void
}): React.JSX.Element {
  const podRef: MapRef | null = pod ? { kind: 'pods', ns: pod.ns, name: pod.name } : null
  const ref = podRef ?? node.ref ?? null
  const incoming = edges
    .filter((e) => e.to === node.id)
    .map((e) => nodes.get(e.from))
    .filter((n): n is TopoNode => Boolean(n))
  const outgoing = edges
    .filter((e) => e.from === node.id)
    .map((e) => nodes.get(e.to))
    .filter((n): n is TopoNode => Boolean(n))
  const uniq = (list: TopoNode[]): TopoNode[] => [...new Map(list.map((n) => [n.id, n])).values()]
  const workload = node.kind === 'workload' && node.ref ? node.ref : null
  const title = pod ? 'Pod' : node.title
  const name = pod ? pod.name : node.name
  const tone: MapTone = pod ? pod.tone : node.tone
  return (
    <>
      <div className="flex items-start gap-2.5 border-b border-line px-3 py-2.5">
        <KindIcon
          kind={pod ? 'pods' : (node.ref?.kind ?? ICON_KIND[node.kind] ?? 'pods')}
          size={28}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[13px] font-semibold text-fg" title={name}>
              {name}
            </span>
            {node.kind !== 'namespace' && (
              <Pill tone={tone}>
                {pod ? (pod.notReady ? t('not ready') : pod.status) : toneLabel(node)}
              </Pill>
            )}
          </div>
          <div className="truncate text-xs text-faint">
            {title}
            {node.ns ? ` · ${node.ns}` : ''}
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
        {ref && !node.missing && (
          <Action
            icon={<ExternalLink size={13} />}
            label={ref.kind === 'namespaces' ? t('Show resources') : t('Open details')}
            testId="k8s-topo-open"
            onClick={() => {
              onOpen(ref)
            }}
          />
        )}
        {(pod || (workload && workload.kind !== 'cronjobs.batch')) && ref && (
          <Action
            icon={<FileText size={13} />}
            label={t('Logs')}
            testId="k8s-topo-logs"
            onClick={() => {
              onLogs(ref)
            }}
          />
        )}
        {pod && podRef && onShell && pod.tone !== 'muted' && (
          <Action
            icon={<SquareTerminal size={13} />}
            label={t('Shell')}
            testId="k8s-topo-shell"
            onClick={() => {
              onShell(podRef)
            }}
          />
        )}
        {onPortForward &&
          ref &&
          !node.missing &&
          (ref.kind === 'pods' || ref.kind === 'services') &&
          (!pod || pod.tone !== 'muted') && (
            <Action
              icon={<Cable size={13} />}
              label={t('Port-forward…')}
              testId="k8s-topo-forward"
              onClick={() => {
                onPortForward(ref)
              }}
            />
          )}
        {ref && !node.missing && ref.kind !== 'namespaces' && (
          <Action
            icon={<FileCode2 size={13} />}
            label="YAML"
            testId="k8s-topo-yaml"
            onClick={() => {
              onYaml(ref)
            }}
          />
        )}
        {node.kind !== 'namespace' && node.kind !== 'more' && (
          <Action
            icon={<Crosshair size={13} />}
            label={focused ? t('Show everything') : t('Focus on its path')}
            testId="k8s-topo-focus"
            pressed={focused}
            onClick={() => {
              onFocus(focused ? null : node.id)
            }}
          />
        )}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3"
        data-testid="k8s-topo-inspector"
      >
        {!pod && node.problems.length > 0 && (
          <section data-testid="k8s-topo-problems">
            <Heading>
              {t('Problems')}{' '}
              <span className="ml-1 font-normal text-faint">{node.problems.length}</span>
            </Heading>
            <ul className="flex flex-col gap-1.5">
              {node.problems.map((p, i) => (
                <li
                  key={i}
                  className={cx(
                    'flex gap-2 rounded-md px-2 py-1.5 text-xs leading-snug',
                    p.severity === 'bad'
                      ? 'bg-danger-soft text-danger'
                      : p.severity === 'warn'
                        ? 'bg-warning-soft text-warning'
                        : 'bg-subtle text-muted'
                  )}
                  data-code={p.code}
                >
                  {p.severity === 'bad' ? (
                    <AlertOctagon size={14} className="mt-px shrink-0" />
                  ) : p.severity === 'warn' ? (
                    <AlertTriangle size={14} className="mt-px shrink-0" />
                  ) : (
                    <Info size={14} className="mt-px shrink-0" />
                  )}
                  <span className="min-w-0">
                    <span className="block">{p.text}</span>
                    {p.fix && (
                      <span
                        className="mt-1 block border-t border-current/20 pt-1 text-muted"
                        data-testid="k8s-topo-problem-fix"
                      >
                        {p.fix}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {pod ? <PodFacts pod={pod} /> : <Facts node={node} />}
        {!pod && traffic && traffic.status !== 'off' && workload && (
          <TrafficSection traffic={traffic} />
        )}
        {!pod && (
          <Links
            title={
              node.lane === 'workload'
                ? t('Receives traffic from')
                : node.lane === 'pods' || node.lane === 'deps'
                  ? t('Used by')
                  : t('Comes from')
            }
            list={uniq(incoming)}
            onGo={onGo}
          />
        )}
        {!pod && (
          <Links
            title={
              node.lane === 'workload'
                ? t('Runs')
                : node.lane === 'pods'
                  ? t('Needs')
                  : t('Sends traffic to')
            }
            list={uniq(outgoing)}
            onGo={onGo}
          />
        )}
      </div>
    </>
  )
}

function Action({
  icon,
  label,
  testId,
  pressed,
  onClick
}: {
  icon: React.ReactNode
  label: string
  testId?: string
  pressed?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={pressed}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap',
        pressed ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}

function Links({
  title,
  list,
  onGo
}: {
  title: string
  list: TopoNode[]
  onGo: (id: string) => void
}): React.JSX.Element | null {
  if (!list.length) return null
  return (
    <section>
      <Heading>
        {title} <span className="ml-1 font-normal text-faint">{list.length}</span>
      </Heading>
      <div className="flex flex-col">
        {list.slice(0, 100).map((n) => (
          <button
            key={n.id}
            type="button"
            className="group flex h-7 items-center gap-2 rounded px-1 text-left text-xs hover:bg-hover"
            data-testid="k8s-topo-link"
            data-name={n.name}
            onClick={() => {
              onGo(n.id)
            }}
          >
            <span className={cx('size-1.5 shrink-0 rounded-full', DOT[n.tone])} />
            <span className="min-w-0 flex-1 truncate font-mono text-fg group-hover:text-accent">
              {n.kind === 'pods' ? tn(n.pods?.length ?? 0, '{n} pod', '{n} pods') : n.name}
            </span>
            <span className="shrink-0 truncate text-faint">{n.title}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

const mono = (v: React.ReactNode): React.JSX.Element => <span className="font-mono">{v}</span>

function Facts({ node }: { node: TopoNode }): React.JSX.Element | null {
  const s = node.service
  const r = node.route
  const w = node.workload
  switch (node.kind) {
    case 'workload': {
      const pods = node.status
      return (
        <section>
          <Heading>{t('Details')}</Heading>
          <DefList
            items={[
              node.replicas
                ? [t('Ready'), `${String(node.replicas.ready)} / ${String(node.replicas.desired)}`]
                : null,
              !node.replicas && pods ? [t('Status'), pods] : null,
              node.hpa
                ? [
                    'HPA',
                    t('{min}–{max} replicas, now {current}', {
                      min: node.hpa.min,
                      max: node.hpa.max,
                      current: node.hpa.current
                    })
                  ]
                : null,
              node.policies?.length ? ['NetworkPolicy', mono(node.policies.join(', '))] : null,
              w?.serviceAccount ? ['ServiceAccount', mono(w.serviceAccount)] : null,
              w?.ports?.length
                ? [
                    t('Ports'),
                    mono(
                      w.ports
                        .map(
                          (p) =>
                            `${p.name ? `${p.name}:` : ''}${String(p.port)}${p.protocol ? `/${p.protocol}` : ''}`
                        )
                        .join(', ')
                    )
                  ]
                : null,
              w?.configMaps?.length ? ['ConfigMaps', mono(w.configMaps.join(', '))] : null,
              w?.secrets?.length ? ['Secrets', mono(w.secrets.join(', '))] : null,
              w?.pvcs.length ? [t('Volumes'), mono(w.pvcs.join(', '))] : null,
              node.tech
                ? [
                    t('Runs'),
                    <span key="tech" className="inline-flex items-center gap-1.5">
                      <TechIcon tech={node.tech} size={14} />
                      {TECH[node.tech]?.label ?? node.tech}
                    </span>
                  ]
                : null,
              node.helm ? [t('Installed by'), 'Helm'] : null
            ]}
          />
          {node.labels && Object.keys(node.labels).length > 0 && (
            <p className="mt-2 font-mono text-[11px] break-all text-faint">
              {selectorText(node.labels)}
            </p>
          )}
        </section>
      )
    }
    case 'service':
      if (!s) return null
      return (
        <section>
          <Heading>{t('Details')}</Heading>
          <DefList
            items={[
              [t('Type'), node.sub],
              s.clusterIP ? ['Cluster IP', mono(s.clusterIP)] : null,
              s.external?.length ? [t('External'), mono(s.external.join(', '))] : null,
              Object.keys(s.selector).length
                ? [t('Selector'), mono(selectorText(s.selector))]
                : [t('Selector'), t('none — endpoints are managed manually')],
              node.status ? [t('Endpoints'), node.status] : null
            ]}
          />
          {(node.rows ?? []).length > 0 && (
            <div className="mt-2 flex flex-col gap-0.5">
              {(node.rows ?? []).map((row, i) => (
                <div
                  key={i}
                  className={cx(
                    'flex justify-between gap-3 rounded bg-subtle px-2 py-1 font-mono text-[11.5px]',
                    row.tone === 'bad'
                      ? 'text-danger'
                      : row.tone === 'warn'
                        ? 'text-warning'
                        : 'text-fg'
                  )}
                >
                  <span>{row.text}</span>
                  <span className="text-faint">{row.hint}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )
    case 'ingress':
    case 'route':
      if (!r) return null
      return (
        <section>
          <Heading>{t('Details')}</Heading>
          <DefList
            items={[
              r.className ? [t('Class'), mono(r.className)] : null,
              r.hosts.length ? [t('Hosts'), mono(r.hosts.join(', '))] : null,
              r.address?.length ? [t('Address'), mono(r.address.join(', '))] : null,
              r.parents?.length
                ? ['Gateway', mono(r.parents.map((p) => `${p.ns}/${p.name}`).join(', '))]
                : null,
              r.tls?.length
                ? [
                    'TLS',
                    mono(
                      r.tls
                        .map(
                          (x) =>
                            `${x.hosts.join(', ') || '*'} → ${x.secret || t('default certificate')}`
                        )
                        .join('; ')
                    )
                  ]
                : null
            ]}
          />
          <div className="mt-2 flex flex-col gap-0.5" data-testid="k8s-topo-rules">
            {(r.rules ?? []).map((x, i) => (
              <div
                key={i}
                className="flex justify-between gap-3 rounded bg-subtle px-2 py-1 font-mono text-[11.5px] text-fg"
              >
                <span className="min-w-0 truncate">
                  {x.default ? t('default backend') : `${x.host || '*'}${x.path}`}
                </span>
                <span className="shrink-0 text-faint">
                  → {x.service}
                  {x.port ? `:${x.port}` : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      )
    case 'lb':
    case 'gateway':
      return (
        <section>
          <Heading>{t('Details')}</Heading>
          <DefList
            items={[
              [t('Address'), mono(node.sub)],
              node.rows?.length
                ? [
                    t('Ports'),
                    mono(node.rows.map((x) => `${x.text}${x.hint ? ` ${x.hint}` : ''}`).join(', '))
                  ]
                : null
            ]}
          />
        </section>
      )
    case 'external': {
      const d = node.dest
      if (!d) return null
      return (
        <section data-testid="k8s-topo-external">
          <Heading>{t('Details')}</Heading>
          <DefList
            items={[
              [t('Host'), mono(d.host)],
              d.port !== undefined
                ? [
                    t('Port'),
                    mono(`${String(d.port)}${d.portImplied ? ` (${t('default port')})` : ''}`)
                  ]
                : null,
              d.scheme ? [t('Protocol'), mono(d.scheme)] : null,
              d.viaService
                ? [t('Through Service'), mono(`${d.viaService.ns}/${d.viaService.name}`)]
                : null
            ]}
          />
          <Heading>{t('Declared in')}</Heading>
          <div className="mt-1 flex flex-col gap-1">
            {(node.rows ?? []).map((r, i) => (
              <div
                key={i}
                className="flex justify-between gap-3 rounded bg-subtle px-2 py-1 font-mono text-[11.5px] text-fg"
              >
                <span className="min-w-0 truncate">{r.text}</span>
                <span className="shrink-0 text-faint">{r.hint}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-faint">
            {t('Read from configuration — not observed traffic.')}
          </p>
        </section>
      )
    }
    case 'pods': {
      const pods = node.pods ?? []
      const restarts = pods.reduce((n, p) => n + p.restarts, 0)
      return (
        <section>
          <Heading>{t('Details')}</Heading>
          <DefList
            items={[
              [t('Pods'), String(pods.length)],
              [t('Ready'), String(pods.filter((p) => p.tone === 'ok' && !p.notReady).length)],
              [t('Restarts'), String(restarts)],
              [
                t('Nodes'),
                mono([...new Set(pods.map((p) => p.node).filter(Boolean))].join(', ') || '—')
              ]
            ]}
          />
          <p className="mt-2 text-[11px] text-faint">{t('Click a pod for its logs and shell.')}</p>
        </section>
      )
    }
    case 'namespace': {
      const st = node.stats
      if (!st) return null
      return (
        <section>
          <Heading>{t('Details')}</Heading>
          <DefList
            items={[
              [t('Entry points'), String(st.entries)],
              [t('Services'), String(st.services)],
              [t('Workloads'), String(st.workloads)],
              [t('Pods'), String(st.pods)],
              [t('Problems'), tn(st.problems.bad + st.problems.warn, '{n} problem', '{n} problems')]
            ]}
          />
        </section>
      )
    }
    default:
      return node.sub ? (
        <section>
          <Heading>{t('Details')}</Heading>
          <p className="font-mono text-xs text-muted">{node.sub}</p>
        </section>
      ) : null
  }
}

function PodFacts({ pod }: { pod: MapPod }): React.JSX.Element {
  return (
    <section>
      <Heading>{t('Details')}</Heading>
      <DefList
        items={[
          [t('Status'), pod.notReady ? t('Running, not ready') : pod.status],
          [t('Restarts'), String(pod.restarts)],
          pod.node ? [t('Node'), mono(pod.node)] : null,
          pod.ip ? ['IP', mono(pod.ip)] : null,
          pod.startedAt ? [t('Started'), formatRelative(pod.startedAt)] : null,
          pod.usage
            ? [
                'CPU',
                `${formatCpu(pod.usage.cpu)}${pod.cpu ? ` / ${formatCpu(pod.cpu)} ${t('requested')}` : ''}`
              ]
            : null,
          pod.usage
            ? [
                t('Memory'),
                `${formatMemory(pod.usage.memory)}${pod.memory ? ` / ${formatMemory(pod.memory)} ${t('requested')}` : ''}`
              ]
            : null
        ]}
      />
    </section>
  )
}

function TrafficSection({ traffic }: { traffic: NodeTraffic }): React.JSX.Element {
  const unit = useTrafficUnit()
  const label = (r: TrafficRate, dir: 'in' | 'out'): string => {
    const p = dir === 'in' ? r.client : r.server
    return p.kind === 'external' || !p.ns ? p.name : `${p.ns}/${p.name}`
  }
  const sum = (list: TrafficRate[]): number => list.reduce((n, r) => n + r.rate, 0)
  return (
    <section data-testid="k8s-topo-traffic">
      <Heading>{t('Live traffic')}</Heading>
      {traffic.status === 'unavailable' && (
        <p className="text-xs text-faint">
          {t('Unavailable — {reason}.', {
            reason: traffic.reason ?? t('Caretta is not installed')
          })}
        </p>
      )}
      {traffic.status === 'connecting' && (
        <p className="text-xs text-faint">{t('Measuring traffic…')}</p>
      )}
      {traffic.status === 'live' && (
        <>
          <p
            className={cx(
              'mb-1 text-xs text-muted tabular-nums',
              !traffic.incoming.length && !traffic.outgoing.length && 'hidden'
            )}
          >
            {t('In {in} · out {out} · updated {when}', {
              in: rateText(unit)(sum(traffic.incoming)),
              out: rateText(unit)(sum(traffic.outgoing)),
              when: formatRelative(traffic.updated)
            })}
          </p>
          {(['in', 'out'] as const).map((dir) => {
            const list = dir === 'in' ? traffic.incoming : traffic.outgoing
            if (!list.length) return null
            return (
              <div key={dir} className="mt-1">
                <div className="text-[11px] text-faint">
                  {dir === 'in' ? t('Called by') : t('Calls')}
                </div>
                {list.slice(0, 20).map((r) => (
                  <div
                    key={`${r.client.kind}|${r.client.ns}|${r.client.name}>${r.server.kind}|${r.server.ns}|${r.server.name}`}
                    className="flex h-6 items-center gap-2 text-xs"
                    data-testid="k8s-topo-traffic-row"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-fg">
                      {label(r, dir)}
                    </span>
                    <span className="shrink-0 text-faint tabular-nums">
                      {rateText(unit)(r.rate)}
                    </span>
                  </div>
                ))}
              </div>
            )
          })}
          {!traffic.incoming.length && !traffic.outgoing.length && (
            <p className="text-xs text-faint">{t('No traffic observed in the last minute.')}</p>
          )}
        </>
      )}
    </section>
  )
}
