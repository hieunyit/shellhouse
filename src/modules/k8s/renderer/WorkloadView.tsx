import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, Server } from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import {
  DefList,
  Heading,
  Meter,
  Pill,
  Sparkline,
  type Tone
} from '../../../renderer/src/components/panels'
import { cleanError } from '../../../renderer/src/lib/format'
import type { K8sOp, MetricsResult, RbacReach, RolloutRevision, Usage } from '../shared/ops'
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
import { securityFindings, type Severity } from '../shared/security'

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

      <Section title="Strategy">
        <StrategyOf kindId={kindId} spec={spec} status={st} />
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

function StrategyOf({
  kindId,
  spec,
  status
}: {
  kindId: string
  spec: Obj
  status: Obj
}): React.JSX.Element {
  if (kindId === 'deployments.apps') {
    const strat = o(spec['strategy'])
    const ru = o(strat['rollingUpdate'])
    const type = s(strat['type']) || 'RollingUpdate'
    return (
      <DefList
        items={[
          ['Type', type],
          type === 'RollingUpdate' && ['Max surge', s(ru['maxSurge']) || '25%'],
          type === 'RollingUpdate' && ['Max unavailable', s(ru['maxUnavailable']) || '25%'],
          ['Min ready', `${s(spec['minReadySeconds']) || '0'}s`],
          ['Deadline', `${s(spec['progressDeadlineSeconds']) || '600'}s`],
          ['History limit', s(spec['revisionHistoryLimit']) || '10'],
          [
            'Selector',
            <span key="s" className="font-mono text-[11px]">
              {selectorString(spec['selector']) ?? '—'}
            </span>
          ]
        ]}
      />
    )
  }
  if (kindId === 'statefulsets.apps') {
    const strat = o(spec['updateStrategy'])
    return (
      <DefList
        items={[
          ['Update', s(strat['type']) || 'RollingUpdate'],
          o(strat['rollingUpdate'])['partition'] !== undefined && [
            'Partition',
            s(o(strat['rollingUpdate'])['partition'])
          ],
          ['Pod order', s(spec['podManagementPolicy']) || 'OrderedReady'],
          ['Service', s(spec['serviceName']) || '—'],
          [
            'Revision',
            <span key="r" className="font-mono text-[11px]">
              {s(status['updateRevision']) || '—'}
            </span>
          ],
          [
            'Claims',
            a(spec['volumeClaimTemplates'])
              .map((t) => s(o(t['metadata'])['name']))
              .join(', ') || '—'
          ]
        ]}
      />
    )
  }
  const strat = o(spec['updateStrategy'])
  const ru = o(strat['rollingUpdate'])
  return (
    <DefList
      items={[
        ['Update', s(strat['type']) || 'RollingUpdate'],
        ['Max unavailable', s(ru['maxUnavailable']) || '1'],
        ru['maxSurge'] !== undefined && ['Max surge', s(ru['maxSurge'])],
        ['Misscheduled', s(status['numberMisscheduled']) || '0'],
        [
          'Node selector',
          Object.entries(o(o(o(spec['template'])['spec'])['nodeSelector']))
            .map(([k, v]) => `${k}=${s(v)}`)
            .join(', ') || 'all nodes'
        ]
      ]}
    />
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

const TONE_BORDER: Record<Tone, string> = {
  ok: 'border-l-success',
  warn: 'border-l-warning',
  bad: 'border-l-danger',
  info: 'border-l-accent',
  muted: 'border-l-line-strong'
}

/** Lưới pod đầy bề ngang: lỗi trước; bấm thẻ mở pod, bấm node mở node. */
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
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-1.5"
      data-testid="k8s-pod-grid"
    >
      {sorted.map((p) => {
        const ps = podStatus(p)
        const tone = TONE[ps.tone] ?? 'muted'
        const statuses = a(o(p.status)['containerStatuses'])
        const readyN = statuses.filter((c) => c['ready'] === true).length
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
            className={cx(
              'flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-md border border-l-[3px] border-line bg-surface px-2 py-1.5 text-xs hover:border-line-strong',
              TONE_BORDER[tone]
            )}
            onClick={() => {
              onOpenPod(p)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpenPod(p)
            }}
          >
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-fg">{short}</span>
              <span className="shrink-0 text-faint tabular-nums">
                {readyN}/{statuses.length || a(o(p.spec)['containers']).length}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Pill tone={tone}>{ps.text}</Pill>
              {restarts > 0 && (
                <span className={cx('text-[11px]', restarts > 5 ? 'text-danger' : 'text-warning')}>
                  ↻{restarts}
                </span>
              )}
              <span className="ml-auto text-[11px] text-faint">
                {age(Date.parse(p.metadata.creationTimestamp ?? ''))}
              </span>
            </div>
            {node ? (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 self-start text-[11px] text-muted hover:text-accent hover:underline"
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

const METRICS_MS = 15_000
const HISTORY = 40

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
  const ns = obj.metadata.namespace
  const selector = selectorString(o(obj.spec)['selector'])
  const [samples, setSamples] = useState<{ total: Usage; pods: [string, Usage][] }[]>([])
  const [available, setAvailable] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      Promise.all([
        request<MetricsResult>({ op: 'metrics', scope: 'pods', ...(ns ? { namespace: ns } : {}) }),
        request<{ items: K8sObject[] }>({
          op: 'list',
          kind: 'pods',
          ...(ns ? { namespace: ns } : {}),
          ...(selector ? { labelSelector: selector } : {}),
          limit: 1000
        })
      ]).then(
        ([m, list]) => {
          if (cancelled) return
          setAvailable(m.available)
          if (!m.available) return
          const pods: [string, Usage][] = list.items.map((p) => [
            p.metadata.name,
            m.items[`${p.metadata.namespace ?? ''}/${p.metadata.name}`] ?? { cpu: 0, memory: 0 }
          ])
          const total = pods.reduce(
            (t, [, u]) => ({ cpu: t.cpu + u.cpu, memory: t.memory + u.memory }),
            { cpu: 0, memory: 0 }
          )
          setSamples((h) => [...h.slice(-(HISTORY - 1)), { total, pods }])
          setError(null)
        },
        (e: unknown) => {
          if (!cancelled) setError(cleanError(e))
        }
      )
    }
    load()
    const t = setInterval(load, METRICS_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [request, ns, selector])

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
  if (available === false)
    return (
      <p className="text-xs text-faint" data-testid="k8s-metrics-unavailable">
        This cluster has no metrics-server — CPU and memory usage are not available.
      </p>
    )
  const last = samples.at(-1)
  if (!last) return <p className="text-xs text-faint">Collecting usage…</p>
  const n = Math.max(1, last.pods.length)
  const maxCpu = Math.max(...last.pods.map(([, u]) => u.cpu), 1)
  const maxMem = Math.max(...last.pods.map(([, u]) => u.memory), 1)
  const pods = [...last.pods].sort((p, q) => q[1].cpu - p[1].cpu)
  const block = (
    label: string,
    value: number,
    series: number[],
    fmt: (v: number) => string,
    req: number,
    lim: number
  ): React.JSX.Element => (
    <div className="rounded-md border border-line p-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="text-sm font-semibold text-fg tabular-nums">{fmt(value)}</span>
      </div>
      <Sparkline values={series} max={Math.max(...series, lim * n, req * n, 1)} />
      <div className="mt-1 flex flex-col gap-1.5">
        {req > 0 && (
          <Meter
            value={value}
            max={req * n}
            label="of requests"
            detail={`${Math.round((value / (req * n)) * 100)}% of ${fmt(req * n)}`}
          />
        )}
        {lim > 0 && (
          <Meter
            value={value}
            max={lim * n}
            label="of limits"
            detail={`${Math.round((value / (lim * n)) * 100)}% of ${fmt(lim * n)}`}
          />
        )}
        {!req && !lim && (
          <span className="text-[11px] text-warning">No requests or limits set</span>
        )}
      </div>
    </div>
  )
  return (
    <div className="flex flex-col gap-3" data-testid="k8s-metrics">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-2">
        {block(
          'CPU',
          last.total.cpu,
          samples.map((x) => x.total.cpu),
          formatCpu,
          per.cpuReq,
          per.cpuLim
        )}
        {block(
          'Memory',
          last.total.memory,
          samples.map((x) => x.total.memory),
          formatMemory,
          per.memReq,
          per.memLim
        )}
      </div>
      <section>
        <Heading>By pod</Heading>
        <div className="flex flex-col gap-1 text-xs">
          {pods.map(([name, u]) => (
            <div key={name} className="grid grid-cols-[minmax(0,1fr)_7rem_7rem] items-center gap-2">
              <span className="truncate font-mono text-fg" title={name}>
                {name}
              </span>
              <Bar value={u.cpu} max={maxCpu} text={formatCpu(u.cpu)} />
              <Bar value={u.memory} max={maxMem} text={formatMemory(u.memory)} />
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-faint">Updates every 15 s while this tab is open.</p>
      </section>
    </div>
  )
}

function Bar({
  value,
  max,
  text
}: {
  value: number
  max: number
  text: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
        <div
          className="h-full rounded-full bg-accent-solid"
          style={{ width: `${Math.min(100, (value / max) * 100)}%` }}
        />
      </div>
      <span className="w-12 text-right text-faint tabular-nums">{text}</span>
    </div>
  )
}

// ——— Security ———

const SEVERITY_TONE: Record<Severity, Tone> = { high: 'bad', medium: 'warn', low: 'muted' }

/** Cấu hình rủi ro của pod template + ServiceAccount với tới được gì (RBAC). */
export function SecurityOf({
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
  const spec = templateSpec(kindId, obj)
  const findings = useMemo(() => securityFindings(spec), [spec])
  const sa = s(spec['serviceAccountName']) || s(spec['serviceAccount']) || 'default'
  const ns = obj.metadata.namespace ?? ''
  const [reach, setReach] = useState<RbacReach | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showLow, setShowLow] = useState(false)
  useEffect(() => {
    let cancelled = false
    request<RbacReach>({ op: 'rbacReach', namespace: ns, serviceAccount: sa }).then(
      (r) => {
        if (!cancelled) setReach(r)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, ns, sa])
  const count = (sev: Severity): number => findings.filter((f) => f.severity === sev).length
  const shown = showLow ? findings : findings.filter((f) => f.severity !== 'low')
  const grants = reach?.grants ?? []
  const risky = grants.filter((g) => g.risk !== 'low')
  return (
    <div className="flex flex-col gap-4" data-testid="k8s-security">
      <section>
        <Heading
          action={
            <span className="flex gap-1">
              <Pill tone={count('high') ? 'bad' : 'muted'}>{count('high')} high</Pill>
              <Pill tone={count('medium') ? 'warn' : 'muted'}>{count('medium')} medium</Pill>
              <Pill tone="muted">{count('low')} low</Pill>
            </span>
          }
        >
          Pod configuration
        </Heading>
        {shown.length === 0 && (
          <p className="text-xs text-success">
            {findings.length ? 'Only low-risk hardening suggestions.' : 'No issues found.'}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          {shown.map((f, i) => (
            <div
              key={`${f.id}-${f.container ?? ''}-${String(i)}`}
              className="flex gap-2 text-xs"
              data-testid="k8s-security-finding"
              data-id={f.id}
              data-severity={f.severity}
            >
              <span className="mt-0.5 shrink-0">
                <Pill tone={SEVERITY_TONE[f.severity]}>{f.severity}</Pill>
              </span>
              <div className="min-w-0">
                <div className="text-fg">
                  {f.title}
                  {f.container && (
                    <span className="ml-1 font-mono text-faint">({f.container})</span>
                  )}
                </div>
                <div className="text-faint">{f.detail}</div>
              </div>
            </div>
          ))}
        </div>
        {count('low') > 0 && (
          <button
            type="button"
            className="mt-1.5 text-xs text-accent hover:underline"
            onClick={() => {
              setShowLow((v) => !v)
            }}
          >
            {showLow ? 'Hide' : 'Show'} {count('low')} low-risk suggestion
            {count('low') === 1 ? '' : 's'}
          </button>
        )}
      </section>
      <section data-testid="k8s-security-rbac">
        <Heading>
          If compromised — service account{' '}
          <button
            type="button"
            className="font-mono normal-case hover:text-accent hover:underline"
            onClick={() => onNavigate?.('serviceaccounts', sa, ns)}
          >
            {sa}
          </button>
        </Heading>
        {spec['automountServiceAccountToken'] === false && (
          <p className="mb-1 text-xs text-success">
            The token is not mounted — pods cannot use these permissions.
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        {!reach && !error && <p className="text-xs text-faint">Checking permissions…</p>}
        {reach?.error && <p className="mb-1 text-xs text-warning">{reach.error}</p>}
        {reach && grants.length === 0 && !reach.error && (
          <p className="text-xs text-success">No RBAC permissions beyond the defaults.</p>
        )}
        {reach && grants.length > 0 && (
          <>
            <p className="mb-1.5 text-xs text-muted">
              {risky.length
                ? `${risky.length} sensitive permission${risky.length === 1 ? '' : 's'} through ${reach.bindings.length} binding${reach.bindings.length === 1 ? '' : 's'}.`
                : `${grants.length} low-risk permission${grants.length === 1 ? '' : 's'}.`}
            </p>
            <div className="flex flex-col divide-y divide-line text-xs">
              {grants.slice(0, 80).map((g, i) => (
                <div
                  key={`${g.via}-${g.resource}-${String(i)}`}
                  className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 py-1"
                  data-testid="k8s-rbac-grant"
                  data-risk={g.risk}
                >
                  <Pill tone={SEVERITY_TONE[g.risk]}>{g.risk}</Pill>
                  <div className="min-w-0">
                    <div className="text-fg">
                      <span className="font-mono">{g.resource}</span>
                      {g.names.length > 0 && (
                        <span className="text-faint"> ({g.names.join(', ')})</span>
                      )}
                      <span className="text-muted"> · {g.verbs.join(', ')}</span>
                      <span className="text-faint">
                        {' '}
                        · {g.scope === '*' ? 'all namespaces' : g.scope}
                      </span>
                    </div>
                    <div className="truncate text-faint" title={g.via}>
                      {g.reason ? `${g.reason} — ` : ''}
                      {g.via}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
