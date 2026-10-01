import { useEffect, useState } from 'react'
import { Copy, Eye, MoreHorizontal, RefreshCw, Rows3, X } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { useContextMenu } from '../../../renderer/src/components/ContextMenu'
import {
  DefList,
  Heading,
  LabelChips,
  Meter,
  Pill,
  Sparkline,
  TabStrip,
  SidePanel,
  type Tone
} from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import type { K8sOp, RelatedGroup, RelatedItem, RelatedResult, Usage } from '../shared/ops'
import {
  age,
  formatCpu,
  formatMemory,
  parseCpu,
  parseMemory,
  podStatus,
  selectorString,
  toRow,
  type K8sObject
} from '../shared/resources'
import { HAS_PODS, keyLabel, toMenu, type K8sAction } from './actions'

type Request = <T>(op: K8sOp) => Promise<T>
type Obj = Record<string, unknown>
const o = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {}
const a = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(o) : [])
const s = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''

const TONE: Record<string, Tone> = { ok: 'ok', warn: 'warn', bad: 'bad', muted: 'muted' }

export type DetailTab = 'overview' | 'related' | 'pods' | 'data' | 'events' | 'yaml'

/** Loại có tab Related (kiểu Rancher). */
export const RELATED_KINDS = [
  'pods',
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'replicasets.apps',
  'jobs.batch',
  'cronjobs.batch',
  'services',
  'ingresses.networking.k8s.io',
  'gateways.gateway.networking.k8s.io',
  'httproutes.gateway.networking.k8s.io',
  'grpcroutes.gateway.networking.k8s.io',
  'configmaps',
  'secrets',
  'persistentvolumeclaims'
]

/** Bảng chi tiết bên phải (kiểu Lens): tab Overview / Pods / Data / Events / YAML + thao tác. */
export function Detail({
  kindId,
  obj,
  request,
  actions,
  usage,
  nodeUsage,
  onClose,
  onOpenPod,
  initialTab = 'overview',
  onNavigate,
  onShowPods
}: {
  kindId: string
  obj: K8sObject
  request: Request
  actions: K8sAction[]
  /** Lịch sử mức dùng (pod) từ metrics-server. */
  usage: Usage[] | null
  /** Mức dùng hiện tại (node). */
  nodeUsage: Usage | null
  onClose: () => void
  onOpenPod: (pod: K8sObject) => void
  /** Tab mở sẵn (bấm đúp workload → Related, như Rancher). */
  initialTab?: DetailTab
  /** Mở một tài nguyên liên quan (cùng namespace). */
  onNavigate?: (kind: string, name: string) => void
  /** Xem pod của workload trong bảng chính (kiểu k9s). */
  onShowPods?: () => void
}): React.JSX.Element {
  const ns = obj.metadata.namespace
  const hasPods = HAS_PODS.includes(kindId) || kindId === 'nodes'
  const hasData = kindId === 'configmaps' || kindId === 'secrets'
  const hasRelated = RELATED_KINDS.includes(kindId) && Boolean(ns)
  const [tab, setTab] = useState<DetailTab>(
    initialTab === 'related' && !hasRelated ? 'overview' : initialTab
  )
  const { menu, open: openMenu } = useContextMenu()
  const primary = actions.filter((x) => !x.danger).slice(0, 3)
  const row = toRow(kindId, obj)
  const statusTone = TONE[row.tone] ?? 'muted'
  const statusText = row.cells['status'] ?? row.cells['ready'] ?? ''

  return (
    <SidePanel storageKey="k8s-detail" testId="k8s-describe">
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg" title={obj.metadata.name}>
              {obj.metadata.name}
            </span>
            {statusText && <Pill tone={statusTone}>{statusText}</Pill>}
          </div>
          <div className="truncate text-xs text-faint">
            {obj.kind}
            {ns ? ` · ${ns}` : ''} · {age(Date.parse(obj.metadata.creationTimestamp ?? ''))} old
          </div>
        </div>
        <button
          type="button"
          aria-label="More actions"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
          data-testid="k8s-detail-more"
          onClick={(e) => {
            openMenu(e, toMenu(actions))
          }}
        >
          <MoreHorizontal size={15} />
        </button>
        <button
          type="button"
          aria-label="Close"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      {primary.length > 0 && (
        <div className="flex gap-1 overflow-hidden border-b border-line px-2 py-1.5">
          {primary.map((x) => (
            <button
              key={x.id}
              type="button"
              data-testid={`k8s-action-${x.id}`}
              title={x.key ? `${x.label} (${keyLabel(x.key)})` : x.label}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                x.run()
              }}
            >
              {x.icon}
              {x.label}
            </button>
          ))}
        </div>
      )}
      <TabStrip<DetailTab>
        value={tab}
        onChange={setTab}
        testIdPrefix="k8s-detail-tab"
        tabs={[
          { id: 'overview', label: 'Overview' },
          ...(hasRelated ? [{ id: 'related' as const, label: 'Related' }] : []),
          ...(hasPods ? [{ id: 'pods' as const, label: 'Pods' }] : []),
          ...(hasData
            ? [
                {
                  id: 'data' as const,
                  label: 'Data',
                  count: Object.keys(o(obj.data)).length || Object.keys(o(obj['data'])).length
                }
              ]
            : []),
          { id: 'events', label: 'Events' },
          { id: 'yaml', label: 'YAML' }
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'overview' && (
          <Overview kindId={kindId} obj={obj} usage={usage} nodeUsage={nodeUsage} />
        )}
        {tab === 'related' && (
          <RelatedOf
            kindId={kindId}
            obj={obj}
            request={request}
            {...(onNavigate ? { onNavigate } : {})}
            {...(onShowPods ? { onShowPods } : {})}
          />
        )}
        {tab === 'pods' && (
          <PodsOf kindId={kindId} obj={obj} request={request} onOpenPod={onOpenPod} />
        )}
        {tab === 'data' && <DataOf kindId={kindId} obj={obj} request={request} />}
        {tab === 'events' && <EventsOf obj={obj} request={request} />}
        {tab === 'yaml' && <YamlOf kindId={kindId} obj={obj} request={request} />}
      </div>
      {menu}
    </SidePanel>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-4">
      <Heading>{title}</Heading>
      {children}
    </section>
  )
}

function Conditions({ list }: { list: Obj[] }): React.JSX.Element | null {
  if (list.length === 0) return null
  return (
    <Section title="Conditions">
      <div className="flex flex-col gap-1 text-xs">
        {list.map((c) => (
          <div key={s(c['type'])} className="flex items-center gap-2" title={s(c['message'])}>
            <span className={s(c['status']) === 'True' ? 'text-success' : 'text-warning'}>
              {s(c['status']) === 'True' ? '✓' : '✗'}
            </span>
            <span className="text-fg">{s(c['type'])}</span>
            <span className="truncate text-faint">{s(c['reason'])}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Containers({ spec, status }: { spec: Obj; status: Obj }): React.JSX.Element {
  const statuses = [...a(status['containerStatuses']), ...a(status['initContainerStatuses'])]
  const list = [
    ...a(spec['initContainers']).map((c) => ({ c, init: true })),
    ...a(spec['containers']).map((c) => ({ c, init: false }))
  ]
  return (
    <Section title="Containers">
      <div className="flex flex-col gap-2">
        {list.map(({ c, init }) => {
          const st = statuses.find((x) => x['name'] === c['name'])
          const state = o(st?.['state'])
          const stateName = Object.keys(state)[0] ?? 'unknown'
          const reason = s(o(state[stateName])['reason'])
          const tone: Tone =
            stateName === 'running'
              ? st?.['ready'] === true
                ? 'ok'
                : 'warn'
              : stateName === 'terminated'
                ? reason === 'Completed'
                  ? 'muted'
                  : 'bad'
                : 'warn'
          const res = o(c['resources'])
          const req = o(res['requests'])
          const lim = o(res['limits'])
          const env = a(c['env'])
          return (
            <div
              key={s(c['name'])}
              className="rounded-md border border-line p-2"
              data-testid="k8s-container"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-fg">{s(c['name'])}</span>
                {init && (
                  <Pill tone="muted" dot={false}>
                    init
                  </Pill>
                )}
                <Pill tone={tone}>{reason || stateName}</Pill>
                <span className="ml-auto text-[11px] text-faint">
                  {s(st?.['restartCount'] ?? 0)} restarts
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-muted" title={s(c['image'])}>
                {s(c['image'])}
              </div>
              <DefList
                className="mt-1.5"
                items={[
                  a(c['ports']).length > 0 && [
                    'Ports',
                    a(c['ports'])
                      .map(
                        (p) =>
                          `${s(p['containerPort'])}/${s(p['protocol']) || 'TCP'}${p['name'] ? ` (${s(p['name'])})` : ''}`
                      )
                      .join(', ')
                  ],
                  (req['cpu'] !== undefined || lim['cpu'] !== undefined) && [
                    'CPU',
                    `${s(req['cpu']) || '—'} / ${s(lim['cpu']) || '—'}`
                  ],
                  (req['memory'] !== undefined || lim['memory'] !== undefined) && [
                    'Memory',
                    `${s(req['memory']) || '—'} / ${s(lim['memory']) || '—'}`
                  ],
                  Array.isArray(c['command']) && [
                    'Command',
                    <span key="c" className="font-mono">
                      {(c['command'] as unknown[]).map(s).join(' ')}
                    </span>
                  ],
                  a(c['volumeMounts']).length > 0 && [
                    'Mounts',
                    <span key="m" className="font-mono">
                      {a(c['volumeMounts'])
                        .map((m) => `${s(m['mountPath'])}${m['readOnly'] === true ? ' (ro)' : ''}`)
                        .join(', ')}
                    </span>
                  ]
                ]}
              />
              {env.length > 0 && (
                <details className="mt-1.5 text-[11px]">
                  <summary className="cursor-pointer text-faint">
                    Environment ({env.length})
                  </summary>
                  <div className="mt-1 flex flex-col gap-0.5 font-mono">
                    {env.map((e) => (
                      <div key={s(e['name'])} className="truncate">
                        <span className="text-fg">{s(e['name'])}</span>
                        <span className="text-faint">=</span>
                        <span className="text-muted">
                          {e['value'] !== undefined
                            ? s(e['value'])
                            : `‹${Object.keys(o(e['valueFrom']))[0] ?? 'ref'}›`}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function Overview({
  kindId,
  obj,
  usage,
  nodeUsage
}: {
  kindId: string
  obj: K8sObject
  usage: Usage[] | null
  nodeUsage: Usage | null
}): React.JSX.Element {
  const spec = o(obj.spec)
  const status = o(obj.status)
  const meta = obj.metadata
  const owners = meta.ownerReferences ?? []
  const annotations = Object.entries(meta.annotations ?? {})
  const common = (
    <>
      <Section title="Metadata">
        <DefList
          items={[
            [
              'Created',
              meta.creationTimestamp ? new Date(meta.creationTimestamp).toLocaleString() : '—'
            ],
            owners.length > 0 && ['Owner', owners.map((x) => `${x.kind}/${x.name}`).join(', ')],
            Boolean(meta.uid) && [
              'UID',
              <span key="u" className="font-mono text-[11px]">
                {meta.uid}
              </span>
            ]
          ]}
        />
      </Section>
      {Object.keys(meta.labels ?? {}).length > 0 && (
        <Section title="Labels">
          <LabelChips labels={meta.labels} />
        </Section>
      )}
      {annotations.length > 0 && (
        <details className="mb-4 text-xs">
          <summary className="cursor-pointer text-[11px] font-semibold tracking-wider text-faint uppercase">
            Annotations ({annotations.length})
          </summary>
          <div className="mt-1 flex flex-col gap-1 font-mono text-[11px]">
            {annotations.map(([k, v]) => (
              <div key={k} className="break-all">
                <span className="text-muted">{k}</span>: <span className="text-fg">{v}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  )
  switch (kindId) {
    case 'pods': {
      const st = podStatus(obj)
      const last = usage?.at(-1)
      return (
        <>
          <Section title="Status">
            <DefList
              items={[
                [
                  'Status',
                  <Pill key="s" tone={TONE[st.tone] ?? 'muted'}>
                    {st.text}
                  </Pill>
                ],
                ['Node', s(spec['nodeName']) || '—'],
                ['Pod IP', s(status['podIP']) || '—'],
                ['QoS', s(status['qosClass']) || '—'],
                ['Service acct', s(spec['serviceAccountName']) || 'default'],
                ['Restart policy', s(spec['restartPolicy'])]
              ]}
            />
          </Section>
          {usage && usage.length > 0 && last && (
            <Section title="Usage">
              <div className="grid grid-cols-2 gap-3" data-testid="k8s-pod-usage">
                <div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">CPU</span>
                    <span className="text-fg tabular-nums">{formatCpu(last.cpu)}</span>
                  </div>
                  <Sparkline
                    values={usage.map((u) => u.cpu)}
                    max={Math.max(...usage.map((u) => u.cpu), 1)}
                  />
                </div>
                <div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Memory</span>
                    <span className="text-fg tabular-nums">{formatMemory(last.memory)}</span>
                  </div>
                  <Sparkline
                    values={usage.map((u) => u.memory)}
                    max={Math.max(...usage.map((u) => u.memory), 1)}
                  />
                </div>
              </div>
            </Section>
          )}
          <Containers spec={spec} status={status} />
          <Conditions list={a(status['conditions'])} />
          {common}
        </>
      )
    }
    case 'deployments.apps':
    case 'statefulsets.apps':
    case 'daemonsets.apps':
    case 'replicasets.apps': {
      const want =
        kindId === 'daemonsets.apps'
          ? Number(status['desiredNumberScheduled'] ?? 0)
          : Number(spec['replicas'] ?? 0)
      const ready =
        kindId === 'daemonsets.apps'
          ? Number(status['numberReady'] ?? 0)
          : Number(status['readyReplicas'] ?? 0)
      const template = o(o(spec['template'])['spec'])
      return (
        <>
          <Section title="Replicas">
            <Meter
              value={ready}
              max={Math.max(want, 1)}
              label="Ready"
              detail={`${ready} / ${want}`}
              testId="k8s-replicas-meter"
            />
            <DefList
              className="mt-2"
              items={[
                [
                  'Desired',
                  <span key="d" data-testid="k8s-replicas">
                    {want}
                  </span>
                ],
                status['updatedReplicas'] !== undefined && [
                  'Up to date',
                  s(status['updatedReplicas'])
                ],
                status['availableReplicas'] !== undefined && [
                  'Available',
                  s(status['availableReplicas'])
                ],
                spec['strategy'] !== undefined && ['Strategy', s(o(spec['strategy'])['type'])],
                spec['paused'] === true && [
                  'Rollout',
                  <Pill key="p" tone="warn">
                    paused
                  </Pill>
                ],
                [
                  'Selector',
                  <span key="s" className="font-mono text-[11px]">
                    {selectorString(spec['selector']) ?? '—'}
                  </span>
                ],
                [
                  'Images',
                  <span key="i" className="font-mono text-[11px]">
                    {a(template['containers'])
                      .map((c) => s(c['image']))
                      .join(', ')}
                  </span>
                ]
              ]}
            />
          </Section>
          <Conditions list={a(status['conditions'])} />
          {common}
        </>
      )
    }
    case 'nodes': {
      const info = o(status['nodeInfo'])
      const alloc = o(status['allocatable'])
      const cpu = parseCpu(alloc['cpu'])
      const mem = parseMemory(alloc['memory'])
      return (
        <>
          <Section title="Resources">
            <div className="flex flex-col gap-2">
              {nodeUsage ? (
                <>
                  <Meter
                    value={nodeUsage.cpu}
                    max={cpu}
                    label="CPU"
                    detail={`${formatCpu(nodeUsage.cpu)} / ${formatCpu(cpu)}`}
                  />
                  <Meter
                    value={nodeUsage.memory}
                    max={mem}
                    label="Memory"
                    detail={`${formatMemory(nodeUsage.memory)} / ${formatMemory(mem)}`}
                  />
                </>
              ) : (
                <DefList
                  items={[
                    ['CPU', formatCpu(cpu)],
                    ['Memory', formatMemory(mem)],
                    ['Pods', s(alloc['pods'])]
                  ]}
                />
              )}
            </div>
          </Section>
          <Section title="System">
            <DefList
              items={[
                ['Kubelet', s(info['kubeletVersion'])],
                ['OS', `${s(info['osImage'])} (${s(info['architecture'])})`],
                ['Kernel', s(info['kernelVersion'])],
                ['Runtime', s(info['containerRuntimeVersion'])],
                [
                  'Addresses',
                  a(status['addresses'])
                    .map((x) => s(x['address']))
                    .join(', ')
                ],
                spec['unschedulable'] === true && [
                  'Scheduling',
                  <Pill key="c" tone="warn">
                    cordoned
                  </Pill>
                ]
              ]}
            />
          </Section>
          {a(spec['taints']).length > 0 && (
            <Section title="Taints">
              <div className="flex flex-col gap-0.5 font-mono text-[11px] text-muted">
                {a(spec['taints']).map((t) => (
                  <span key={`${s(t['key'])}${s(t['effect'])}`}>
                    {s(t['key'])}
                    {t['value'] ? `=${s(t['value'])}` : ''}:{s(t['effect'])}
                  </span>
                ))}
              </div>
            </Section>
          )}
          <Conditions list={a(status['conditions'])} />
          {common}
        </>
      )
    }
    case 'services':
      return (
        <>
          <Section title="Service">
            <DefList
              items={[
                ['Type', s(spec['type'])],
                [
                  'Cluster IP',
                  <span key="i" className="font-mono">
                    {s(spec['clusterIP'])}
                  </span>
                ],
                a(o(status['loadBalancer'])['ingress']).length > 0 && [
                  'External',
                  a(o(status['loadBalancer'])['ingress'])
                    .map((i) => s(i['ip']) || s(i['hostname']))
                    .join(', ')
                ],
                [
                  'Ports',
                  <span key="p" className="font-mono">
                    {a(spec['ports'])
                      .map(
                        (p) =>
                          `${s(p['port'])}→${s(p['targetPort'])}${p['nodePort'] ? ` (node ${s(p['nodePort'])})` : ''}/${s(p['protocol']) || 'TCP'}`
                      )
                      .join(', ')}
                  </span>
                ],
                [
                  'Selector',
                  <span key="s" className="font-mono text-[11px]">
                    {selectorString(spec['selector']) ?? '—'}
                  </span>
                ]
              ]}
            />
          </Section>
          {common}
        </>
      )
    case 'ingresses.networking.k8s.io':
      return (
        <>
          <Section title="Rules">
            <div className="flex flex-col gap-1 font-mono text-[11px]">
              {a(spec['rules']).flatMap((r) =>
                a(o(r['http'])['paths']).map((p) => {
                  const svc = o(o(p['backend'])['service'])
                  return (
                    <div key={`${s(r['host'])}${s(p['path'])}`} className="text-fg">
                      {s(r['host']) || '*'}
                      {s(p['path']) || '/'} <span className="text-faint">→</span> {s(svc['name'])}:
                      {s(o(svc['port'])['number']) || s(o(svc['port'])['name'])}
                    </div>
                  )
                })
              )}
            </div>
          </Section>
          {a(spec['tls']).length > 0 && (
            <Section title="TLS">
              <div className="font-mono text-[11px] text-muted">
                {a(spec['tls'])
                  .map(
                    (t) =>
                      `${(t['hosts'] as string[] | undefined)?.join(', ') ?? ''} (${s(t['secretName'])})`
                  )
                  .join('; ')}
              </div>
            </Section>
          )}
          {common}
        </>
      )
    case 'cronjobs.batch':
      return (
        <>
          <Section title="Schedule">
            <DefList
              items={[
                [
                  'Schedule',
                  <span key="s" className="font-mono">
                    {s(spec['schedule'])}
                  </span>
                ],
                spec['timeZone'] !== undefined
                  ? (['Time zone', s(spec['timeZone'])] as const)
                  : null,
                [
                  'Suspended',
                  spec['suspend'] === true ? (
                    <Pill key="p" tone="warn">
                      yes
                    </Pill>
                  ) : (
                    'no'
                  )
                ],
                [
                  'Last run',
                  status['lastScheduleTime']
                    ? `${age(Date.parse(s(status['lastScheduleTime'])))} ago`
                    : 'never'
                ],
                ['Active jobs', String(a(status['active']).length)]
              ]}
            />
          </Section>
          {common}
        </>
      )
    case 'jobs.batch':
      return (
        <>
          <Section title="Job">
            <DefList
              items={[
                ['Completions', `${s(status['succeeded'] ?? 0)} / ${s(spec['completions'] ?? 1)}`],
                ['Failed', s(status['failed'] ?? 0)],
                status['startTime'] !== undefined && [
                  'Started',
                  new Date(s(status['startTime'])).toLocaleString()
                ],
                status['completionTime'] !== undefined &&
                  status['startTime'] !== undefined && [
                    'Duration',
                    `${Math.round((Date.parse(s(status['completionTime'])) - Date.parse(s(status['startTime']))) / 1000)}s`
                  ]
              ]}
            />
          </Section>
          <Conditions list={a(status['conditions'])} />
          {common}
        </>
      )
    case 'persistentvolumeclaims':
      return (
        <>
          <Section title="Claim">
            <DefList
              items={[
                ['Status', s(status['phase'])],
                [
                  'Capacity',
                  s(o(status['capacity'])['storage']) ||
                    s(o(o(spec['resources'])['requests'])['storage'])
                ],
                ['Access', ((spec['accessModes'] as string[] | undefined) ?? []).join(', ')],
                ['Class', s(spec['storageClassName'])],
                ['Volume', s(spec['volumeName'])]
              ]}
            />
          </Section>
          {common}
        </>
      )
    default:
      return (
        <>
          <Conditions list={a(status['conditions'])} />
          {common}
        </>
      )
  }
}

/** Pod thuộc workload / service (theo selector) hoặc đang chạy trên node. */
function PodsOf({
  kindId,
  obj,
  request,
  onOpenPod
}: {
  kindId: string
  obj: K8sObject
  request: Request
  onOpenPod: (pod: K8sObject) => void
}): React.JSX.Element {
  const [pods, setPods] = useState<K8sObject[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const spec = o(obj.spec)
    const selector =
      kindId === 'services'
        ? selectorString(spec['selector'])
        : kindId === 'nodes'
          ? null
          : selectorString(spec['selector'])
    const query: K8sOp =
      kindId === 'nodes'
        ? {
            op: 'list',
            kind: 'pods',
            fieldSelector: `spec.nodeName=${obj.metadata.name}`,
            limit: 500
          }
        : {
            op: 'list',
            kind: 'pods',
            ...(obj.metadata.namespace ? { namespace: obj.metadata.namespace } : {}),
            ...(selector ? { labelSelector: selector } : {}),
            limit: 500
          }
    if (kindId !== 'nodes' && !selector) {
      void Promise.resolve().then(() => {
        if (!cancelled) setPods([])
      })
      return
    }
    request<{ items: K8sObject[] }>(query).then(
      (r) => {
        if (!cancelled) setPods(r.items)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [kindId, obj, request])
  if (error) return <p className="text-xs text-danger">{error}</p>
  if (!pods) return <p className="text-xs text-faint">Loading…</p>
  if (pods.length === 0) return <p className="text-xs text-faint">No pods.</p>
  return (
    <div className="flex flex-col divide-y divide-line text-xs" data-testid="k8s-detail-pods">
      {pods.map((p) => {
        const r = toRow('pods', p)
        return (
          <button
            key={r.key}
            type="button"
            className="flex items-center gap-2 py-1.5 text-left hover:bg-hover"
            onClick={() => {
              onOpenPod(p)
            }}
          >
            <span className="min-w-0 flex-1 truncate text-fg">{p.metadata.name}</span>
            <span className="text-faint">{r.cells['ready']}</span>
            <Pill tone={TONE[r.tone] ?? 'muted'}>{r.cells['status']}</Pill>
          </button>
        )
      })}
    </div>
  )
}

function DataOf({
  kindId,
  obj,
  request
}: {
  kindId: string
  obj: K8sObject
  request: Request
}): React.JSX.Element {
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const data = o(obj.data ?? obj['data'])
  const binary = o(obj['binaryData'])
  const keys = [...Object.keys(data), ...Object.keys(binary)]
  if (keys.length === 0) return <p className="text-xs text-faint">No data.</p>
  const reveal = (key: string): Promise<string> =>
    request<string>({
      op: 'secret.reveal',
      namespace: obj.metadata.namespace ?? '',
      name: obj.metadata.name,
      key
    }).then((v) => {
      setRevealed((r) => ({ ...r, [key]: v }))
      return v
    })
  return (
    <div className="flex flex-col gap-2" data-testid="k8s-secret-keys">
      {kindId === 'secrets' && (
        <button
          type="button"
          className="self-start text-xs text-accent hover:underline"
          data-testid="k8s-secret-reveal-all"
          onClick={() => {
            for (const k of keys) void reveal(k)
          }}
        >
          Reveal all
        </button>
      )}
      {keys.map((key) => {
        const value = kindId === 'secrets' ? revealed[key] : s(data[key]) || '‹binary›'
        return (
          <div key={key} className="rounded-md border border-line">
            <div className="flex items-center gap-2 border-b border-line px-2 py-1">
              <span className="flex-1 truncate font-mono text-xs text-fg">{key}</span>
              {kindId === 'secrets' && value === undefined && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                  data-testid="k8s-secret-reveal"
                  onClick={() => void reveal(key)}
                >
                  <Eye size={12} /> Reveal
                </button>
              )}
              {value !== undefined && (
                <button
                  type="button"
                  aria-label={`Copy ${key}`}
                  className="text-faint hover:text-fg"
                  onClick={() => void window.shellhouse.writeClipboard(value)}
                >
                  <Copy size={12} />
                </button>
              )}
            </div>
            {value !== undefined && (
              <pre
                className={cx(
                  'max-h-48 overflow-auto px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-muted select-text'
                )}
                data-testid={kindId === 'secrets' ? 'k8s-secret-value' : undefined}
              >
                {value}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}

function EventsOf({ obj, request }: { obj: K8sObject; request: Request }): React.JSX.Element {
  const [events, setEvents] = useState<K8sObject[] | null>(null)
  const ns = obj.metadata.namespace
  useEffect(() => {
    let cancelled = false
    request<{ items: K8sObject[] }>({
      op: 'list',
      kind: 'events',
      ...(ns ? { namespace: ns } : {}),
      fieldSelector: `involvedObject.name=${obj.metadata.name}`,
      limit: 100
    }).then(
      (r) => {
        if (!cancelled)
          setEvents(
            r.items.sort((x, y) => s(o(y)['lastTimestamp']).localeCompare(s(o(x)['lastTimestamp'])))
          )
      },
      () => {
        if (!cancelled) setEvents([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, ns, obj.metadata.name])
  if (!events) return <p className="text-xs text-faint">Loading…</p>
  if (events.length === 0) return <p className="text-xs text-faint">No recent events.</p>
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="k8s-events">
      {events.map((e) => {
        const warn = o(e)['type'] === 'Warning'
        return (
          <div key={e.metadata.name} className="flex gap-2">
            <span
              className={cx(
                'mt-1 size-1.5 shrink-0 rounded-full',
                warn ? 'bg-warning' : 'bg-line-strong'
              )}
            />
            <div className="min-w-0">
              <div>
                <span className={warn ? 'font-medium text-warning' : 'font-medium text-muted'}>
                  {s(o(e)['reason'])}
                </span>
                <span className="ml-2 text-faint">
                  {o(e)['lastTimestamp'] ? `${age(Date.parse(s(o(e)['lastTimestamp'])))} ago` : ''}
                  {Number(o(e)['count'] ?? 1) > 1 ? ` · ×${s(o(e)['count'])}` : ''}
                </span>
              </div>
              <div className="text-fg">{s(o(e)['message'])}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function YamlOf({
  kindId,
  obj,
  request
}: {
  kindId: string
  obj: K8sObject
  request: Request
}): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    request<string>({
      op: 'get',
      kind: kindId,
      ...(obj.metadata.namespace ? { namespace: obj.metadata.namespace } : {}),
      name: obj.metadata.name,
      format: 'yaml'
    }).then(
      (t) => {
        if (!cancelled) setText(t)
      },
      (e: unknown) => {
        if (!cancelled) setText(`# ${cleanError(e)}`)
      }
    )
    return () => {
      cancelled = true
    }
    // Đối tượng đổi (watch) → tải lại.
  }, [request, kindId, obj])
  return (
    <pre
      className="overflow-auto font-mono text-[11px] leading-relaxed text-fg select-text"
      data-testid="k8s-detail-yaml"
    >
      {text ?? 'Loading…'}
    </pre>
  )
}

/** Nhóm mặc định luôn hiện (kể cả khi trống) cho workload — thấy ngay "không có service nào". */
const ALWAYS = new Set(['pods', 'services', 'configmaps', 'secrets'])

/**
 * Tab Related (kiểu Rancher): pod, service, ingress, ConfigMap / Secret / PVC đang dùng (thiếu →
 * đỏ), autoscaler, disruption budget, owner; với ConfigMap / Secret / PVC: workload đang dùng.
 */
function RelatedOf({
  kindId,
  obj,
  request,
  onNavigate,
  onShowPods
}: {
  kindId: string
  obj: K8sObject
  request: Request
  onNavigate?: (kind: string, name: string) => void
  onShowPods?: () => void
}): React.JSX.Element {
  const [data, setData] = useState<RelatedResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const ns = obj.metadata.namespace ?? ''
  const name = obj.metadata.name
  useEffect(() => {
    let cancelled = false
    request<RelatedResult>({ op: 'related', kind: kindId, namespace: ns, name }).then(
      (r) => {
        if (cancelled) return
        setData(r)
        setError(null)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, kindId, ns, name, tick])
  if (error) return <p className="text-xs text-danger">{error}</p>
  if (!data) return <p className="text-xs text-faint">Finding related resources…</p>
  const shown = data.groups.filter((g) => g.items.length > 0 || g.error || ALWAYS.has(g.id))
  const empty = data.groups.filter((g) => !shown.includes(g)).map((g) => g.title.toLowerCase())
  const missing = data.groups.flatMap((g) => g.items.filter((i) => i.missing))
  return (
    <div className="flex flex-col gap-4" data-testid="k8s-related">
      {missing.length > 0 && (
        <p className="rounded-md bg-danger-soft px-2 py-1.5 text-xs text-danger">
          {missing.length} referenced resource{missing.length === 1 ? ' is' : 's are'} missing —
          pods that need {missing.length === 1 ? 'it' : 'them'} will not start.
        </p>
      )}
      {shown.map((g) => (
        <RelatedSection
          key={g.id}
          group={g}
          {...(onNavigate ? { onNavigate } : {})}
          {...(g.id === 'pods' && onShowPods ? { onShowPods } : {})}
        />
      ))}
      <div className="flex items-center gap-2 text-xs text-faint">
        {empty.length > 0 && <span className="flex-1">No {empty.join(', ')}.</span>}
        <button
          type="button"
          className="ml-auto flex items-center gap-1 hover:text-fg"
          onClick={() => {
            setTick((n) => n + 1)
          }}
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
    </div>
  )
}

function RelatedSection({
  group,
  onNavigate,
  onShowPods
}: {
  group: RelatedGroup
  onNavigate?: (kind: string, name: string) => void
  onShowPods?: () => void
}): React.JSX.Element {
  return (
    <section data-testid="k8s-related-group" data-group={group.id}>
      <div className="mb-1 flex items-center gap-2">
        <Heading>
          {group.title}
          {group.items.length > 0 && (
            <span className="ml-1.5 font-normal text-faint tabular-nums">{group.items.length}</span>
          )}
        </Heading>
        {onShowPods && group.items.length > 0 && (
          <button
            type="button"
            className="mb-1 ml-auto flex items-center gap-1 text-xs text-accent hover:underline"
            data-testid="k8s-related-show-pods"
            onClick={onShowPods}
          >
            <Rows3 size={12} /> Show in table
          </button>
        )}
      </div>
      {group.error && <p className="text-xs text-warning">{group.error}</p>}
      {group.items.length === 0 && !group.error && <p className="text-xs text-faint">None</p>}
      <div className="flex flex-col">
        {group.items.map((item) => (
          <RelatedRow
            key={`${item.kind}/${item.name}`}
            item={item}
            {...(onNavigate ? { onNavigate } : {})}
          />
        ))}
      </div>
    </section>
  )
}

function RelatedRow({
  item,
  onNavigate
}: {
  item: RelatedItem
  onNavigate?: (kind: string, name: string) => void
}): React.JSX.Element {
  const canOpen = Boolean(onNavigate && item.kind && !item.missing)
  const body = (
    <>
      <span className={cx('size-1.5 shrink-0 rounded-full', DOT_BG[item.tone])} />
      <span
        className={cx(
          'min-w-0 shrink truncate font-mono',
          item.missing ? 'text-danger' : canOpen ? 'text-fg group-hover:text-accent' : 'text-fg'
        )}
        title={item.name}
      >
        {item.name}
      </span>
      {item.missing && <Pill tone="bad">missing</Pill>}
      <span className="ml-auto min-w-0 truncate text-right text-faint" title={item.summary}>
        {item.summary}
      </span>
    </>
  )
  return canOpen ? (
    <button
      type="button"
      className="group flex h-7 w-full items-center gap-2 rounded px-1 text-left text-xs hover:bg-hover"
      data-testid="k8s-related-item"
      data-name={item.name}
      onClick={() => onNavigate?.(item.kind, item.name)}
    >
      {body}
    </button>
  ) : (
    <div
      className="flex h-7 items-center gap-2 px-1 text-xs"
      data-testid="k8s-related-item"
      data-name={item.name}
    >
      {body}
    </div>
  )
}

const DOT_BG: Record<RelatedItem['tone'], string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger-solid',
  muted: 'bg-line-strong'
}
