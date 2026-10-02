import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, Server } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { Heading, Meter, Pill, type Tone } from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import { UsagePanel } from './Usage'
import type { K8sOp, RolloutRevision } from '../shared/ops'
import {
  age,
  formatCpu,
  formatMemory,
  parseCpu,
  parseMemory,
  podStatus,
  selectorString,
  type K8sObject
} from '../shared/resources'

type Request = <T>(op: K8sOp) => Promise<T>
type Obj = Record<string, unknown>
const o = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {}
const a = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(o) : [])
const s = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''

/** Loại có trang workload đầy đủ (Status / Strategy / Resources / Pods). */
export const WORKLOAD_VIEW_KINDS = new Set([
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps'
])
/** Loại có tab Metrics / Security (pod template). */
export const POD_TEMPLATE_KINDS = new Set([
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'replicasets.apps',
  'jobs.batch',
  'cronjobs.batch'
])

const TONE: Record<string, Tone> = { ok: 'ok', warn: 'warn', bad: 'bad', muted: 'muted' }

export function templateSpec(kindId: string, obj: K8sObject): Obj {
  const spec = o(obj.spec)
  if (kindId === 'pods') return spec
  const tpl =
    kindId === 'cronjobs.batch'
      ? o(o(o(spec['jobTemplate'])['spec'])['template'])
      : o(spec['template'])
  return o(tpl['spec'])
}

/** Pod theo selector của workload (tự tải lại khi đối tượng đổi — watch). */
function usePods(
  obj: K8sObject,
  request: Request
): { pods: K8sObject[] | null; error: string | null } {
  const [state, setState] = useState<{ pods: K8sObject[] | null; error: string | null }>({
    pods: null,
    error: null
  })
  const selector = selectorString(o(obj.spec)['selector'])
  const ns = obj.metadata.namespace
  useEffect(() => {
    let cancelled = false
    if (!selector) {
      void Promise.resolve().then(() => {
        if (!cancelled) setState({ pods: [], error: null })
      })
      return
    }
    request<{ items: K8sObject[] }>({
      op: 'list',
      kind: 'pods',
      ...(ns ? { namespace: ns } : {}),
      labelSelector: selector,
      limit: 1000
    }).then(
      (r) => {
        if (!cancelled) setState({ pods: r.items, error: null })
      },
      (e: unknown) => {
        if (!cancelled) setState({ pods: null, error: cleanError(e) })
      }
    )
    return () => {
      cancelled = true
    }
    // obj đổi (watch: replicas, status…) → tải lại pod.
  }, [request, ns, selector, obj])
  return state
}

function Section({
  title,
  action,
  children,
  testId
}: {
  title: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <section className="mb-5" data-testid={testId}>
      <Heading action={action}>{title}</Heading>
      {children}
    </section>
  )
}

function Counter({
  label,
  value,
  tone,
  testId
}: {
  label: string
  value: number | string
  tone?: Tone | undefined
  testId?: string
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-line px-2 py-1.5">
      <div className="truncate text-[10px] tracking-wide text-faint uppercase">{label}</div>
      <div
        data-testid={testId}
        className={cx(
          'text-base font-semibold tabular-nums',
          tone === 'bad'
            ? 'text-danger'
            : tone === 'warn'
              ? 'text-warning'
              : tone === 'ok'
                ? 'text-success'
                : 'text-fg'
        )}
      >
        {value}
      </div>
    </div>
  )
}

/** Trạng thái rollout từ conditions (như `kubectl rollout status`). */
function rolloutState(
  kindId: string,
  obj: K8sObject
): { text: string; tone: Tone; detail: string } {
  const spec = o(obj.spec)
  const st = o(obj.status)
  const conds = a(st['conditions'])
  const cond = (type: string): Obj | undefined => conds.find((c) => c['type'] === type)
  if (spec['paused'] === true) return { text: 'Paused', tone: 'warn', detail: 'Rollout is paused' }
  if (
    Number(st['observedGeneration'] ?? 0) <
    ((obj.metadata as { generation?: number }).generation ?? 0)
  )
    return {
      text: 'Updating',
      tone: 'warn',
      detail: 'Waiting for the controller to see the change'
    }
  if (kindId === 'deployments.apps') {
    const progressing = cond('Progressing')
    const available = cond('Available')
    if (s(progressing?.['reason']) === 'ProgressDeadlineExceeded')
      return { text: 'Stalled', tone: 'bad', detail: s(progressing?.['message']) }
    const want = Number(spec['replicas'] ?? 1)
    const updated = Number(st['updatedReplicas'] ?? 0)
    const avail = Number(st['availableReplicas'] ?? 0)
    const total = Number(st['replicas'] ?? 0)
    if (updated < want)
      return {
        text: 'Rolling out',
        tone: 'warn',
        detail: `${updated} of ${want} new replicas updated`
      }
    if (total > updated)
      return {
        text: 'Rolling out',
        tone: 'warn',
        detail: `${total - updated} old replicas pending termination`
      }
    if (avail < updated)
      return {
        text: 'Rolling out',
        tone: 'warn',
        detail: `${avail} of ${updated} updated replicas available`
      }
    if (s(available?.['status']) === 'False')
      return { text: 'Unavailable', tone: 'bad', detail: s(available?.['message']) }
    return {
      text: want === 0 ? 'Scaled to zero' : 'Available',
      tone: want === 0 ? 'muted' : 'ok',
      detail: 'Rollout complete'
    }
  }
  if (kindId === 'statefulsets.apps') {
    const want = Number(spec['replicas'] ?? 1)
    const ready = Number(st['readyReplicas'] ?? 0)
    if (st['updateRevision'] && st['currentRevision'] !== st['updateRevision'])
      return {
        text: 'Rolling out',
        tone: 'warn',
        detail: `${s(st['updatedReplicas']) || 0} of ${want} pods on the new revision`
      }
    return ready >= want
      ? {
          text: want === 0 ? 'Scaled to zero' : 'Available',
          tone: want === 0 ? 'muted' : 'ok',
          detail: 'All pods ready'
        }
      : { text: 'Degraded', tone: ready ? 'warn' : 'bad', detail: `${ready} of ${want} pods ready` }
  }
  const want = Number(st['desiredNumberScheduled'] ?? 0)
  const ready = Number(st['numberReady'] ?? 0)
  const updated = Number(st['updatedNumberScheduled'] ?? 0)
  if (updated < want)
    return { text: 'Rolling out', tone: 'warn', detail: `${updated} of ${want} nodes updated` }
  return ready >= want
    ? { text: 'Available', tone: 'ok', detail: `Running on ${want} node${want === 1 ? '' : 's'}` }
    : { text: 'Degraded', tone: ready ? 'warn' : 'bad', detail: `${ready} of ${want} nodes ready` }
}

/**
 * Trang workload (kiểu K8Studio): Status, Strategy, Resources and limits, Pods (lưới đầy bề
 * ngang — bấm pod mở pod, bấm node mở node), ReplicaSets / rollback.
 */
export function WorkloadOverview({
  kindId,
  obj,
  request,
  readOnly,
  onOpenPod,
  onNavigate,
  onNotify,
  common
}: {
  kindId: string
  obj: K8sObject
  request: Request
  readOnly: boolean
  onOpenPod: (pod: K8sObject) => void
  onNavigate?: (kind: string, name: string, namespace?: string) => void
  onNotify?: (text: string, tone?: 'danger') => void
  common: React.ReactNode
}): React.JSX.Element {
  const spec = o(obj.spec)
  const st = o(obj.status)
  const { pods, error } = usePods(obj, request)
  const state = rolloutState(kindId, obj)
  const ds = kindId === 'daemonsets.apps'
  const want = ds ? Number(st['desiredNumberScheduled'] ?? 0) : Number(spec['replicas'] ?? 1)
  const ready = Number(ds ? st['numberReady'] : st['readyReplicas']) || 0
  const updated = Number(ds ? st['updatedNumberScheduled'] : st['updatedReplicas']) || 0
  const available = Number(ds ? st['numberAvailable'] : st['availableReplicas']) || 0
  const unavailable = Math.max(
    0,
    Number(ds ? st['numberUnavailable'] : st['unavailableReplicas']) || want - available
  )

  // Trạng thái pod thật (không dựa vào số trên status — khớp với lưới bên dưới).
  const phases = useMemo(() => {
    const counts = new Map<string, { n: number; tone: Tone }>()
    for (const p of pods ?? []) {
      const ps = podStatus(p)
      const prev = counts.get(ps.text)
      counts.set(ps.text, { n: (prev?.n ?? 0) + 1, tone: TONE[ps.tone] ?? 'muted' })
    }
    return [...counts.entries()].sort((x, y) => y[1].n - x[1].n)
  }, [pods])

  return (
    <>
      <Section
        title="Status"
        testId="k8s-workload-status"
        action={
          <Pill tone={state.tone}>
            <span data-testid="k8s-rollout-state">{state.text}</span>
          </Pill>
        }
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1.5">
          <Counter label={ds ? 'Scheduled' : 'Desired'} value={want} testId="k8s-replicas" />
          <Counter
            label="Ready"
            value={ready}
            tone={ready >= want ? 'ok' : ready ? 'warn' : 'bad'}
          />
          <Counter label="Up to date" value={updated} tone={updated < want ? 'warn' : undefined} />
          <Counter label="Available" value={available} />
          <Counter label="Unavailable" value={unavailable} tone={unavailable ? 'bad' : undefined} />
        </div>
        <div className="mt-2">
          <Meter
            value={ready}
            max={Math.max(want, 1)}
            label="Ready"
            detail={`${ready} / ${want}`}
            neutral
            testId="k8s-replicas-meter"
          />
        </div>
        <p className="mt-1.5 text-xs text-muted">{state.detail}</p>
        {phases.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1" data-testid="k8s-pod-phases">
            {phases.map(([text, { n, tone }]) => (
              <Pill key={text} tone={tone}>
                {n} {text}
              </Pill>
            ))}
          </div>
        )}
      </Section>

      <Section title="Resources and limits" testId="k8s-workload-resources">
        <ResourcesOf spec={templateSpec(kindId, obj)} replicas={want} />
      </Section>

      <Section
        title={
          <>
            Pods{' '}
            <span className="ml-1 font-normal text-faint tabular-nums">{pods?.length ?? ''}</span>
          </>
        }
      >
        {error && <p className="text-xs text-danger">{error}</p>}
        {!pods && !error && <p className="text-xs text-faint">Loading…</p>}
        {pods && pods.length === 0 && <p className="text-xs text-faint">No pods.</p>}
        {pods && pods.length > 0 && (
          <PodGrid
            pods={pods}
            prefix={obj.metadata.name}
            onOpenPod={onOpenPod}
            {...(onNavigate ? { onNavigate } : {})}
          />
        )}
      </Section>

      {kindId === 'deployments.apps' && (
        <Section title="ReplicaSets" testId="k8s-workload-replicasets">
          <ReplicaSets
            obj={obj}
            request={request}
            readOnly={readOnly}
            {...(onNavigate ? { onNavigate } : {})}
            {...(onNotify ? { onNotify } : {})}
          />
        </Section>
      )}
      {common}
    </>
  )
}

/** Requests / limits theo container + tổng × số replica; thiếu → vàng. */
function ResourcesOf({ spec, replicas }: { spec: Obj; replicas: number }): React.JSX.Element {
  const containers = a(spec['containers'])
  const sum = (pick: (res: Obj) => number): number =>
    containers.reduce((n, c) => n + pick(o(c['resources'])), 0)
  const cpuReq = sum((r) => parseCpu(o(r['requests'])['cpu']))
  const memReq = sum((r) => parseMemory(o(r['requests'])['memory']))
  const cpuLim = sum((r) => parseCpu(o(r['limits'])['cpu']))
  const memLim = sum((r) => parseMemory(o(r['limits'])['memory']))
  const missing = (v: unknown): React.JSX.Element =>
    v === undefined ? <span className="text-warning">—</span> : <>{s(v)}</>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="k8s-resources-table">
        <thead>
          <tr className="text-left text-[10px] tracking-wide text-faint uppercase">
            <th className="py-1 pr-2 font-medium">Container</th>
            <th className="py-1 pr-2 font-medium">CPU req / lim</th>
            <th className="py-1 pr-2 font-medium">Memory req / lim</th>
            <th className="py-1 font-medium" title="Liveness · Readiness · Startup">
              Probes
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {containers.map((c) => {
            const res = o(c['resources'])
            const req = o(res['requests'])
            const lim = o(res['limits'])
            const probe = (k: string, letter: string): React.JSX.Element => (
              <span
                className={c[k] ? 'text-success' : 'text-faint'}
                title={`${k.replace('Probe', '')}: ${c[k] ? 'yes' : 'none'}`}
              >
                {letter}
              </span>
            )
            return (
              <tr key={s(c['name'])}>
                <td className="py-1 pr-2">
                  <div className="font-medium text-fg">{s(c['name'])}</div>
                  <div
                    className="max-w-[16rem] truncate font-mono text-[10px] text-faint"
                    title={s(c['image'])}
                  >
                    {s(c['image'])}
                  </div>
                </td>
                <td className="py-1 pr-2 font-mono tabular-nums">
                  {missing(req['cpu'])} / {missing(lim['cpu'])}
                </td>
                <td className="py-1 pr-2 font-mono tabular-nums">
                  {missing(req['memory'])} / {missing(lim['memory'])}
                </td>
                <td className="py-1 font-mono tracking-widest">
                  {probe('livenessProbe', 'L')}
                  {probe('readinessProbe', 'R')}
                  {probe('startupProbe', 'S')}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {replicas > 0 && (
        <p className="mt-1.5 text-xs text-muted">
          Total for {replicas} replica{replicas === 1 ? '' : 's'}: CPU{' '}
          <span className="font-mono text-fg">{cpuReq ? formatCpu(cpuReq * replicas) : '—'}</span>
          {cpuLim ? ` (limit ${formatCpu(cpuLim * replicas)})` : ''}, memory{' '}
          <span className="font-mono text-fg">
            {memReq ? formatMemory(memReq * replicas) : '—'}
          </span>
          {memLim ? ` (limit ${formatMemory(memLim * replicas)})` : ''}
        </p>
      )}
    </div>
  )
}

const DOT_BG: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger-solid',
  info: 'bg-accent',
  muted: 'bg-line-strong'
}
const TONE_TEXT_CLS: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  info: 'text-accent',
  muted: 'text-faint'
}

/** Pod của workload: mỗi pod một dòng gọn — lỗi lên đầu; bấm mở pod, bấm node mở node. */
function PodGrid({
  pods,
  prefix,
  onOpenPod,
  onNavigate
}: {
  pods: K8sObject[]
  prefix: string
  onOpenPod: (pod: K8sObject) => void
  onNavigate?: (kind: string, name: string, namespace?: string) => void
}): React.JSX.Element {
  const rank: Record<string, number> = { bad: 0, warn: 1, ok: 2, muted: 3 }
  const sorted = [...pods].sort(
    (p, q) =>
      (rank[podStatus(p).tone] ?? 3) - (rank[podStatus(q).tone] ?? 3) ||
      p.metadata.name.localeCompare(q.metadata.name)
  )
  return (
    <div className="flex flex-col" data-testid="k8s-pod-grid">
      {sorted.map((p) => {
        const ps = podStatus(p)
        const tone = TONE[ps.tone] ?? 'muted'
        const statuses = a(o(p.status)['containerStatuses'])
        const readyN = statuses.filter((c) => c['ready'] === true).length
        const total = statuses.length || a(o(p.spec)['containers']).length
        const restarts = statuses.reduce((n, c) => n + (Number(c['restartCount']) || 0), 0)
        const node = s(o(p.spec)['nodeName'])
        const short = p.metadata.name.startsWith(`${prefix}-`)
          ? p.metadata.name.slice(prefix.length + 1)
          : p.metadata.name
        return (
          <div
            key={p.metadata.name}
            role="button"
            tabIndex={0}
            data-testid="k8s-pod-tile"
            data-name={p.metadata.name}
            title={p.metadata.name}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-xs hover:bg-hover"
            onClick={() => {
              onOpenPod(p)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpenPod(p)
            }}
          >
            <span className={cx('size-2 shrink-0 rounded-full', DOT_BG[tone])} />
            <span className="shrink-0 font-mono text-fg">{short}</span>
            {ps.text !== 'Running' && (
              <span className={cx('shrink-0', TONE_TEXT_CLS[tone])}>{ps.text}</span>
            )}
            {restarts > 0 && (
              <span className={cx('shrink-0', restarts > 5 ? 'text-danger' : 'text-warning')}>
                {restarts} restart{restarts === 1 ? '' : 's'}
              </span>
            )}
            {node ? (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 text-[11px] text-faint hover:text-accent"
                data-testid="k8s-pod-node"
                title={`Open node ${node}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onNavigate?.('nodes', node)
                }}
              >
                <Server size={10} className="shrink-0" />
                <span className="truncate">{node}</span>
              </button>
            ) : (
              <span className="text-[11px] text-warning">Not scheduled</span>
            )}
            <span className="ml-auto flex shrink-0 gap-3 text-faint tabular-nums">
              <span title="Ready containers">
                {readyN}/{total}
              </span>
              <span className="w-8 text-right">
                {age(Date.parse(p.metadata.creationTimestamp ?? ''))}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** ReplicaSet cũ / mới (revision) + quay về revision trước. */
function ReplicaSets({
  obj,
  request,
  readOnly,
  onNavigate,
  onNotify
}: {
  obj: K8sObject
  request: Request
  readOnly: boolean
  onNavigate?: (kind: string, name: string, namespace?: string) => void
  onNotify?: (text: string, tone?: 'danger') => void
}): React.JSX.Element {
  const [list, setList] = useState<RolloutRevision[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const ns = obj.metadata.namespace ?? ''
  const name = obj.metadata.name
  const revision = obj.metadata.annotations?.['deployment.kubernetes.io/revision']
  useEffect(() => {
    let cancelled = false
    request<RolloutRevision[]>({ op: 'rolloutHistory', namespace: ns, name }).then(
      (r) => {
        if (!cancelled) setList(r)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
    // Revision đổi (rollout / rollback) → tải lại.
  }, [request, ns, name, revision])
  if (error) return <p className="text-xs text-danger">{error}</p>
  if (!list) return <p className="text-xs text-faint">Loading…</p>
  if (!list.length) return <p className="text-xs text-faint">No ReplicaSets.</p>
  return (
    <div className="flex flex-col divide-y divide-line text-xs">
      {list.map((r) => (
        <div
          key={r.replicaSet}
          className="flex items-center gap-2 py-1.5"
          data-testid="k8s-replicaset-row"
        >
          <span className="w-9 shrink-0 font-mono text-faint">#{r.revision}</span>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className="max-w-full truncate font-mono text-fg hover:text-accent hover:underline"
              onClick={() => onNavigate?.('replicasets.apps', r.replicaSet, ns)}
            >
              {r.replicaSet}
            </button>
            <div className="truncate font-mono text-[10px] text-faint" title={r.images.join(', ')}>
              {r.images.join(', ')}
            </div>
          </div>
          <span className="shrink-0 text-faint tabular-nums">
            {r.replicas} pod{r.replicas === 1 ? '' : 's'} · {age(Date.parse(r.created))}
          </span>
          {r.current ? (
            <Pill tone="ok">current</Pill>
          ) : (
            !readOnly && (
              <button
                type="button"
                disabled={busy !== null}
                data-testid="k8s-replicaset-rollback"
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-50"
                onClick={() => {
                  if (!window.confirm(`Roll ${name} back to revision ${r.revision}?`)) return
                  setBusy(r.revision)
                  request({ op: 'rollback', namespace: ns, name, revision: r.revision }).then(
                    () => {
                      setBusy(null)
                      onNotify?.(`Rolled ${name} back to revision ${r.revision}`)
                    },
                    (e: unknown) => {
                      setBusy(null)
                      onNotify?.(cleanError(e), 'danger')
                    }
                  )
                }}
              >
                <RotateCcw size={11} /> {busy === r.revision ? 'Rolling back…' : 'Roll back'}
              </button>
            )
          )}
        </div>
      ))}
    </div>
  )
}

// ——— Metrics ———

/** CPU / RAM của mọi pod thuộc workload (metrics-server), so với requests / limits. */
export function MetricsOf({
  kindId,
  obj,
  request
}: {
  kindId: string
  obj: K8sObject
  request: Request
}): React.JSX.Element {
  const { pods, error } = usePods(obj, request)
  const spec = templateSpec(kindId, obj)
  const per = a(spec['containers']).reduce<{
    cpuReq: number
    memReq: number
    cpuLim: number
    memLim: number
  }>(
    (t, c) => {
      const res = o(c['resources'])
      return {
        cpuReq: t.cpuReq + parseCpu(o(res['requests'])['cpu']),
        memReq: t.memReq + parseMemory(o(res['requests'])['memory']),
        cpuLim: t.cpuLim + parseCpu(o(res['limits'])['cpu']),
        memLim: t.memLim + parseMemory(o(res['limits'])['memory'])
      }
    },
    { cpuReq: 0, memReq: 0, cpuLim: 0, memLim: 0 }
  )
  if (error) return <p className="text-xs text-danger">{error}</p>
  if (!pods) return <p className="text-xs text-faint">Loading…</p>
  const names = pods.map((p) => p.metadata.name).sort()
  if (!names.length) return <p className="text-xs text-faint">No pods are running.</p>
  const n = names.length
  return (
    <UsagePanel
      request={request}
      namespace={obj.metadata.namespace ?? 'default'}
      pods={names}
      requests={{ cpu: per.cpuReq * n, memory: per.memReq * n }}
      limits={{ cpu: per.cpuLim * n, memory: per.memLim * n }}
      perPod
    />
  )
}
