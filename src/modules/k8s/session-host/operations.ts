import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { parseAllDocuments, stringify as toYamlText } from 'yaml'
import { COUNT_CAPPED } from '../shared/ops'
import type {
  HelmRelease,
  HelmReleaseDetail,
  ApplyResult,
  DrainResult,
  MetricsResult,
  OverviewProblem,
  OverviewResult,
  FleetResult,
  HealthResult,
  RolloutRevision,
  Usage
} from '../shared/ops'
import {
  MASKED_KEYS_ANNOTATION,
  parseCpu,
  parseMemory,
  podRequests,
  resourcePath,
  selectorString,
  type K8sObject,
  type ResourceKind
} from '../shared/resources'
import { certExpiry } from './certs'
import { KubeError, type KubeClient } from './client'

/** Các thao tác kiểu k9s / Lens không phải CRUD đơn giản (ADR-014 mục 7.4). */

type List = { items: K8sObject[] }
const ns = (n: string): string => `/namespaces/${encodeURIComponent(n)}`
/** `{ signal }` nếu có (exactOptionalPropertyTypes không nhận `signal: undefined`). */
const sig = (signal?: AbortSignal): { signal?: AbortSignal } => (signal ? { signal } : {})

/** CPU / RAM từ metrics-server; cluster không có → available = false. */
export async function metrics(
  client: KubeClient,
  scope: 'pods' | 'nodes',
  namespace: string | undefined,
  signal?: AbortSignal
): Promise<MetricsResult> {
  const path =
    scope === 'nodes'
      ? '/apis/metrics.k8s.io/v1beta1/nodes'
      : `/apis/metrics.k8s.io/v1beta1${namespace ? ns(namespace) : ''}/pods`
  try {
    const res = await client.json<{
      items: {
        metadata: { name: string; namespace?: string }
        usage?: Record<string, string>
        containers?: { usage?: Record<string, string> }[]
      }[]
    }>('GET', path, signal ? { signal } : {})
    const items: Record<string, Usage> = {}
    for (const m of res.items) {
      const key = m.metadata.namespace
        ? `${m.metadata.namespace}/${m.metadata.name}`
        : m.metadata.name
      if (m.usage)
        items[key] = { cpu: parseCpu(m.usage['cpu']), memory: parseMemory(m.usage['memory']) }
      else {
        let cpu = 0
        let memory = 0
        for (const c of m.containers ?? []) {
          cpu += parseCpu(c.usage?.['cpu'])
          memory += parseMemory(c.usage?.['memory'])
        }
        items[key] = { cpu, memory }
      }
    }
    return { available: true, items }
  } catch (error) {
    if (
      error instanceof KubeError &&
      (error.status === 404 || error.status === 503 || error.status === 403)
    )
      return { available: false, items: {} }
    throw error
  }
}

/** Header Accept: chỉ metadata (PartialObjectMetadataList) — server cũ không hỗ trợ thì JSON thường. */
export const METADATA_ONLY =
  'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json'

export interface PagedOptions {
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal | undefined
  /** Tối đa chừng này đối tượng (quá → truncated). */
  max?: number
  page?: number
  accept?: string
}

/** List có phân trang (limit + continue) tới hết hoặc tới `max` đối tượng. */
export async function listPaged(
  client: KubeClient,
  path: string,
  options: PagedOptions = {}
): Promise<{ items: K8sObject[]; truncated: boolean }> {
  const max = options.max ?? 50_000
  const page = options.page ?? 500
  const items: K8sObject[] = []
  let cont: string | undefined
  do {
    // `items: null` khi rỗng: PartialObjectMetadataList (list chỉ metadata) của API server, một số
    // proxy (Rancher) — coi như danh sách rỗng.
    const r = await client.json<{ items: K8sObject[] | null; metadata?: { continue?: string } }>(
      'GET',
      path,
      {
        query: { ...options.query, limit: page, continue: cont },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.accept ? { accept: options.accept } : {})
      }
    )
    for (const it of r.items ?? []) items.push(it)
    cont = r.metadata?.continue || undefined
    if (cont && items.length >= max) return { items, truncated: true }
  } while (cont)
  return { items, truncated: false }
}

async function listIn(
  client: KubeClient,
  path: (n?: string) => string,
  namespaces: readonly string[],
  options: PagedOptions = {}
): Promise<{ items: K8sObject[]; truncated: boolean }> {
  const lists = await Promise.all(
    (namespaces.length ? namespaces : [undefined]).map((n) => listPaged(client, path(n), options))
  )
  return { items: lists.flatMap((l) => l.items), truncated: lists.some((l) => l.truncated) }
}

/** Tổng quan cluster: node, pod theo trạng thái, workload sẵn sàng, cảnh báo gần đây, tài nguyên. */
export async function overview(
  client: KubeClient,
  namespaces: readonly string[],
  signal?: AbortSignal
): Promise<OverviewResult> {
  const opts = { signal }
  const none = { items: [] as K8sObject[], truncated: false }
  const [version, nodeList, podList, deployList, setList, daemonList, eventList, usage, pvcList] =
    await Promise.all([
      client.json<{ gitVersion?: string }>('GET', '/version', opts),
      listPaged(client, '/api/v1/nodes', opts).catch(() => none),
      listIn(client, (n) => `/api/v1${n ? ns(n) : ''}/pods`, namespaces, opts),
      listIn(client, (n) => `/apis/apps/v1${n ? ns(n) : ''}/deployments`, namespaces, opts).catch(
        () => none
      ),
      listIn(client, (n) => `/apis/apps/v1${n ? ns(n) : ''}/statefulsets`, namespaces, opts).catch(
        () => none
      ),
      listIn(client, (n) => `/apis/apps/v1${n ? ns(n) : ''}/daemonsets`, namespaces, opts).catch(
        () => none
      ),
      // Chỉ cảnh báo (lọc ở server) — cluster lớn có hàng chục nghìn event Normal.
      listIn(client, (n) => `/api/v1${n ? ns(n) : ''}/events`, namespaces, {
        ...opts,
        query: { fieldSelector: 'type=Warning' },
        max: 5000
      }).catch(() => none),
      metrics(client, 'nodes', undefined, signal).catch(() => ({ available: false, items: {} })),
      // PVC chờ bound — chỉ để liệt kê vấn đề; không đọc được (thiếu quyền) thì bỏ qua.
      listIn(client, (n) => `/api/v1${n ? ns(n) : ''}/persistentvolumeclaims`, namespaces, {
        ...opts,
        max: 5000
      }).catch(() => none)
    ])
  const nodes = nodeList
  const pods = podList.items
  const deploys = deployList.items
  const sets = setList.items
  const daemons = daemonList.items
  const events = eventList.items
  const capacity: Usage = { cpu: 0, memory: 0 }
  let ready = 0
  let cordoned = 0
  for (const n of nodes.items) {
    const status = n.status ?? {}
    const alloc = (status['allocatable'] ?? {}) as Record<string, string>
    capacity.cpu += parseCpu(alloc['cpu'])
    capacity.memory += parseMemory(alloc['memory'])
    const conds = (status['conditions'] as { type: string; status: string }[] | undefined) ?? []
    if (conds.some((c) => c.type === 'Ready' && c.status === 'True')) ready++
    if (n.spec?.['unschedulable'] === true) cordoned++
  }
  const podCounts = { running: 0, pending: 0, failed: 0, succeeded: 0, restarting: 0 }
  const requests: Usage = { cpu: 0, memory: 0 }
  for (const p of pods) {
    const phase = (p.status?.['phase'] as string | undefined) ?? 'Unknown'
    if (phase === 'Running') {
      podCounts.running++
      const r = podRequests(p)
      requests.cpu += r.cpu
      requests.memory += r.memory
    } else if (phase === 'Pending') podCounts.pending++
    else if (phase === 'Failed') podCounts.failed++
    else if (phase === 'Succeeded') podCounts.succeeded++
    const statuses =
      (p.status?.['containerStatuses'] as
        { state?: { waiting?: { reason?: string } } }[] | undefined) ?? []
    if (statuses.some((c) => c.state?.waiting?.reason === 'CrashLoopBackOff'))
      podCounts.restarting++
  }
  const readyCount = (
    list: K8sObject[],
    want: (o: K8sObject) => number,
    have: (o: K8sObject) => number
  ): number => list.filter((o) => have(o) >= want(o)).length
  const num = (o: K8sObject, path: 'spec' | 'status', key: string): number => {
    const v = o[path]?.[key]
    return typeof v === 'number' ? v : 0
  }
  let usageSum: Usage | null = null
  if (usage.available) {
    usageSum = { cpu: 0, memory: 0 }
    for (const u of Object.values(usage.items)) {
      usageSum.cpu += u.cpu
      usageSum.memory += u.memory
    }
  }
  const warnings = events
    .filter((e) => e['type'] === 'Warning')
    .map((e) => {
      const involved = (e['involvedObject'] ?? {}) as { kind?: string; name?: string }
      return {
        namespace: e.metadata.namespace ?? '',
        object: `${(involved.kind ?? '').toLowerCase()}/${involved.name ?? ''}`,
        reason: typeof e['reason'] === 'string' ? e['reason'] : '',
        message: typeof e['message'] === 'string' ? e['message'] : '',
        count: typeof e['count'] === 'number' ? e['count'] : 1,
        last:
          [e['lastTimestamp'], e['eventTime'], e.metadata.creationTimestamp].find(
            (x): x is string => typeof x === 'string'
          ) ?? ''
      }
    })
    .sort((a, b) => b.last.localeCompare(a.last))
    .slice(0, 50)
  return {
    version: version.gitVersion ?? '',
    nodes: { total: nodes.items.length, ready, cordoned },
    capacity,
    requests,
    usage: usageSum,
    pods: podCounts,
    workloads: [
      {
        kind: 'Deployments',
        total: deploys.length,
        ready: readyCount(
          deploys,
          (o) => num(o, 'spec', 'replicas'),
          (o) => num(o, 'status', 'readyReplicas')
        )
      },
      {
        kind: 'StatefulSets',
        total: sets.length,
        ready: readyCount(
          sets,
          (o) => num(o, 'spec', 'replicas'),
          (o) => num(o, 'status', 'readyReplicas')
        )
      },
      {
        kind: 'DaemonSets',
        total: daemons.length,
        ready: readyCount(
          daemons,
          (o) => num(o, 'status', 'desiredNumberScheduled'),
          (o) => num(o, 'status', 'numberReady')
        )
      }
    ],
    warnings,
    problems: findProblems(nodes.items, pods, pvcList.items),
    ...([nodeList, podList, deployList, setList, daemonList].some((l) => l.truncated)
      ? { truncated: true }
      : {})
  }
}

/** Mỗi nhóm vấn đề giữ tối đa chừng này mục (tổng vẫn đếm đủ). */
const PROBLEMS_MAX = 50
/** Pod Pending lâu hơn chừng này mới là vấn đề (vừa tạo thì Pending là bình thường). */
const PENDING_GRACE_MS = 2 * 60_000

const IMAGE_PULL = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName'])
const FAILING = new Set([
  'CrashLoopBackOff',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
  'OOMKilled',
  'Error',
  'ContainerCannotRun'
])

interface PodContainerStatus {
  name: string
  ready?: boolean
  restartCount?: number
  state?: {
    waiting?: { reason?: string; message?: string }
    terminated?: { reason?: string; message?: string; exitCode?: number; finishedAt?: string }
    running?: { startedAt?: string }
  }
  lastState?: { terminated?: { reason?: string; exitCode?: number; finishedAt?: string } }
}

/**
 * Vấn đề cần xem (trang tổng quan, kiểu Lens / k9s pulses): pod lỗi / kéo image hỏng / Pending lâu,
 * node không Ready, PVC chưa bound. Pod đã xong (Succeeded) hay đang bị xoá không tính.
 */
export function findProblems(
  nodes: readonly K8sObject[],
  pods: readonly K8sObject[],
  pvcs: readonly K8sObject[],
  now = Date.now(),
  /** Số mục giữ lại mỗi nhóm (tổng vẫn đếm đủ); đếm theo namespace cần giữ hết. */
  max = PROBLEMS_MAX
): NonNullable<OverviewResult['problems']> {
  const groups: NonNullable<OverviewResult['problems']> = {
    failing: { total: 0, items: [] },
    imagePull: { total: 0, items: [] },
    pending: { total: 0, items: [] },
    nodes: { total: 0, items: [] },
    pvcs: { total: 0, items: [] }
  }
  const add = (group: keyof typeof groups, item: OverviewProblem): void => {
    const g = groups[group]
    g.total++
    if (g.items.length < max) g.items.push(item)
  }
  for (const p of pods) {
    if (p.metadata.deletionTimestamp) continue
    const phase = (p.status?.['phase'] as string | undefined) ?? 'Unknown'
    if (phase === 'Succeeded') continue
    const statuses = [
      ...((p.status?.['initContainerStatuses'] as PodContainerStatus[] | undefined) ?? []),
      ...((p.status?.['containerStatuses'] as PodContainerStatus[] | undefined) ?? [])
    ]
    const restarts = statuses.reduce((n, c) => n + (c.restartCount ?? 0), 0)
    const base = {
      kind: 'pods',
      ...(p.metadata.namespace ? { namespace: p.metadata.namespace } : {}),
      name: p.metadata.name,
      restarts
    }
    const pull = statuses.find((c) => IMAGE_PULL.has(c.state?.waiting?.reason ?? ''))
    if (pull) {
      add('imagePull', {
        ...base,
        reason: pull.state?.waiting?.reason ?? '',
        message: pull.state?.waiting?.message ?? '',
        since: p.metadata.creationTimestamp ?? ''
      })
      continue
    }
    const bad = statuses.find(
      (c) =>
        FAILING.has(c.state?.waiting?.reason ?? '') ||
        (c.state?.terminated && (c.state.terminated.exitCode ?? 0) !== 0 && phase !== 'Running')
    )
    if (bad || phase === 'Failed') {
      const reason =
        bad?.state?.waiting?.reason ??
        bad?.state?.terminated?.reason ??
        (p.status?.['reason'] as string | undefined) ??
        'Failed'
      const message =
        bad?.state?.waiting?.message ??
        bad?.state?.terminated?.message ??
        (p.status?.['message'] as string | undefined) ??
        ''
      add('failing', {
        ...base,
        reason,
        message,
        since:
          bad?.lastState?.terminated?.finishedAt ??
          bad?.state?.terminated?.finishedAt ??
          p.metadata.creationTimestamp ??
          ''
      })
      continue
    }
    if (phase === 'Pending') {
      const created = Date.parse(p.metadata.creationTimestamp ?? '')
      if (Number.isFinite(created) && now - created < PENDING_GRACE_MS) continue
      const conds =
        (p.status?.['conditions'] as
          { type: string; status: string; reason?: string; message?: string }[] | undefined) ?? []
      const sched = conds.find((c) => c.type === 'PodScheduled' && c.status !== 'True')
      const waiting = statuses.find((c) => c.state?.waiting?.reason)?.state?.waiting
      add('pending', {
        ...base,
        reason: sched?.reason ?? waiting?.reason ?? 'Pending',
        message: sched?.message ?? waiting?.message ?? '',
        since: p.metadata.creationTimestamp ?? ''
      })
    }
  }
  for (const n of nodes) {
    const conds =
      (n.status?.['conditions'] as
        | {
            type: string
            status: string
            reason?: string
            message?: string
            lastTransitionTime?: string
          }[]
        | undefined) ?? []
    const ready = conds.find((c) => c.type === 'Ready')
    if (ready?.status === 'True') continue
    add('nodes', {
      kind: 'nodes',
      name: n.metadata.name,
      reason: ready ? (ready.status === 'Unknown' ? 'NodeStatusUnknown' : 'NotReady') : 'NotReady',
      message: ready?.message ?? ready?.reason ?? '',
      since: ready?.lastTransitionTime ?? ''
    })
  }
  for (const c of pvcs) {
    const phase = c.status?.['phase'] as string | undefined
    if (phase === 'Bound') continue
    add('pvcs', {
      kind: 'persistentvolumeclaims',
      ...(c.metadata.namespace ? { namespace: c.metadata.namespace } : {}),
      name: c.metadata.name,
      reason: phase ?? 'Pending',
      message:
        typeof c.spec?.['storageClassName'] === 'string'
          ? `storageClassName: ${c.spec['storageClassName']}`
          : '',
      since: c.metadata.creationTimestamp ?? ''
    })
  }
  return groups
}

/** ReplicaSet của deployment theo revision (mới nhất trước) — như `kubectl rollout history`. */
export async function rolloutHistory(
  client: KubeClient,
  namespace: string,
  name: string,
  signal?: AbortSignal
): Promise<RolloutRevision[]> {
  const deploy = await client.json<K8sObject>(
    'GET',
    `/apis/apps/v1${ns(namespace)}/deployments/${encodeURIComponent(name)}`,
    sig(signal)
  )
  const selector = selectorString(deploy.spec?.['selector'])
  const sets = await client.json<List>('GET', `/apis/apps/v1${ns(namespace)}/replicasets`, {
    query: { labelSelector: selector ?? undefined },
    ...sig(signal)
  })
  const current = Number(deploy.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0)
  return sets.items
    .filter((rs) =>
      rs.metadata.ownerReferences?.some((o) => o.kind === 'Deployment' && o.name === name)
    )
    .map((rs) => {
      const revision = Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0)
      const template = rs.spec?.['template'] as
        { spec?: { containers?: { image?: string }[] } } | undefined
      return {
        revision,
        replicaSet: rs.metadata.name,
        images: (template?.spec?.containers ?? []).map((c) => c.image ?? ''),
        created: rs.metadata.creationTimestamp ?? '',
        replicas: typeof rs.status?.['replicas'] === 'number' ? rs.status['replicas'] : 0,
        current: revision === current
      }
    })
    .sort((a, b) => b.revision - a.revision)
}

/** Quay về một revision: lấy pod template của ReplicaSet đó (như `kubectl rollout undo`). */
export async function rollback(
  client: KubeClient,
  namespace: string,
  name: string,
  revision: number,
  signal?: AbortSignal
): Promise<void> {
  const path = `/apis/apps/v1${ns(namespace)}/deployments/${encodeURIComponent(name)}`
  const deploy = await client.json<K8sObject>('GET', path, sig(signal))
  const selector = selectorString(deploy.spec?.['selector'])
  const sets = await client.json<List>('GET', `/apis/apps/v1${ns(namespace)}/replicasets`, {
    query: { labelSelector: selector ?? undefined },
    ...sig(signal)
  })
  const target = sets.items.find(
    (rs) =>
      Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision']) === revision &&
      rs.metadata.ownerReferences?.some((o) => o.kind === 'Deployment' && o.name === name)
  )
  if (!target) throw new Error(`Revision ${revision} was not found`)
  const template = structuredClone(target.spec?.['template']) as {
    metadata?: { labels?: Record<string, string> }
  }
  delete template.metadata?.labels?.['pod-template-hash']
  await client.json('PUT', path, {
    body: { ...deploy, spec: { ...deploy.spec, template } },
    ...sig(signal)
  })
}

export async function cordon(
  client: KubeClient,
  node: string,
  unschedulable: boolean,
  signal?: AbortSignal
): Promise<void> {
  await client.json('PATCH', `/api/v1/nodes/${encodeURIComponent(node)}`, {
    body: { spec: { unschedulable } },
    contentType: 'application/merge-patch+json',
    ...sig(signal)
  })
}

export interface DrainOptions {
  gracePeriodSeconds?: number | undefined
  deleteEmptyDirData?: boolean | undefined
  force?: boolean | undefined
  timeoutSeconds?: number | undefined
}

/** Thời gian chờ giữa các lần thử evict bị PDB chặn (test rút ngắn được). */
export const drainRetry = { ms: 5000 }

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled'))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error('Cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Drain như `kubectl drain --ignore-daemonsets`: cordon, rồi evict pod (tối đa 8 cùng lúc). Bỏ qua
 * pod DaemonSet / static pod / đã xong. Pod không có controller hoặc dùng emptyDir chặn cả lượt
 * (không evict gì) trừ khi bật force / deleteEmptyDirData. PDB chặn (429) → thử lại mỗi 5 giây tới
 * hết `timeoutSeconds`.
 */
export async function drain(
  client: KubeClient,
  node: string,
  options: DrainOptions = {},
  signal?: AbortSignal
): Promise<DrainResult> {
  await cordon(client, node, true, signal)
  const { items: pods } = await listPaged(client, '/api/v1/pods', {
    query: { fieldSelector: `spec.nodeName=${node}` },
    signal
  })
  const result: DrainResult = { evicted: [], skipped: [], failed: [] }
  const blocked: string[] = []
  const targets: K8sObject[] = []
  for (const p of pods) {
    const key = `${p.metadata.namespace ?? ''}/${p.metadata.name}`
    const owners = p.metadata.ownerReferences ?? []
    const mirror = p.metadata.annotations?.['kubernetes.io/config.mirror'] !== undefined
    const phase = p.status?.['phase']
    if (
      owners.some((o) => o.kind === 'DaemonSet') ||
      mirror ||
      phase === 'Succeeded' ||
      phase === 'Failed' ||
      p.metadata.deletionTimestamp
    ) {
      result.skipped.push(key)
      continue
    }
    if (!owners.some((o) => o.controller === true) && !options.force)
      blocked.push(`${key}: not managed by a controller (it would not come back) — use force`)
    else if (
      !options.deleteEmptyDirData &&
      ((p.spec?.['volumes'] as { emptyDir?: unknown }[] | undefined) ?? []).some((v) => v.emptyDir)
    )
      blocked.push(`${key}: uses emptyDir (its data would be lost) — allow deleting emptyDir data`)
    else targets.push(p)
  }
  if (blocked.length) {
    // Như kubectl: không evict nửa chừng — node đã cordon, người dùng chọn rồi chạy lại.
    result.failed.push(...blocked)
    result.blocked = blocked.map((b) => b.slice(0, b.indexOf(':')))
    return result
  }
  const deadline = Date.now() + (options.timeoutSeconds ?? 300) * 1000
  await pool(targets, 8, async (p) => {
    const key = `${p.metadata.namespace ?? ''}/${p.metadata.name}`
    for (;;) {
      try {
        await client.json(
          'POST',
          `/api/v1${ns(p.metadata.namespace ?? 'default')}/pods/${encodeURIComponent(p.metadata.name)}/eviction`,
          {
            body: {
              apiVersion: 'policy/v1',
              kind: 'Eviction',
              metadata: { name: p.metadata.name, namespace: p.metadata.namespace },
              ...(options.gracePeriodSeconds !== undefined
                ? { deleteOptions: { gracePeriodSeconds: options.gracePeriodSeconds } }
                : {})
            },
            ...(signal ? { signal } : {})
          }
        )
        result.evicted.push(key)
        return
      } catch (error) {
        if (error instanceof KubeError && error.status === 404) {
          // Đã bị xoá trong lúc drain.
          result.evicted.push(key)
          return
        }
        // 429 = PodDisruptionBudget chưa cho phép (đang chờ pod khác sẵn sàng) → thử lại.
        if (
          error instanceof KubeError &&
          error.status === 429 &&
          Date.now() + drainRetry.ms < deadline &&
          !signal?.aborted
        ) {
          await sleep(drainRetry.ms, signal).catch(() => undefined)
          continue
        }
        result.failed.push(
          `${key}: ${
            error instanceof KubeError && error.status === 429
              ? `still blocked by a PodDisruptionBudget after ${options.timeoutSeconds ?? 300} s`
              : error instanceof Error
                ? error.message
                : String(error)
          }`
        )
        return
      }
    }
  })
  return result
}

/** Chạy CronJob ngay (tạo Job từ jobTemplate) — như `kubectl create job --from=cronjob/x`. */
export async function cronTrigger(
  client: KubeClient,
  namespace: string,
  name: string,
  signal?: AbortSignal
): Promise<string> {
  const cron = await client.json<K8sObject>(
    'GET',
    `/apis/batch/v1${ns(namespace)}/cronjobs/${encodeURIComponent(name)}`,
    sig(signal)
  )
  const template = (cron.spec?.['jobTemplate'] ?? {}) as {
    metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
    spec?: unknown
  }
  const jobName = `${name.slice(0, 40)}-manual-${randomBytes(3).toString('hex')}`
  await client.json('POST', `/apis/batch/v1${ns(namespace)}/jobs`, {
    body: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace,
        labels: template.metadata?.labels,
        annotations: {
          ...template.metadata?.annotations,
          'cronjob.kubernetes.io/instantiate': 'manual'
        },
        ownerReferences: [
          {
            apiVersion: 'batch/v1',
            kind: 'CronJob',
            name,
            uid: cron.metadata.uid,
            controller: true
          }
        ]
      },
      spec: template.spec
    },
    ...sig(signal)
  })
  return jobName
}

export async function cronSuspend(
  client: KubeClient,
  namespace: string,
  name: string,
  suspend: boolean,
  signal?: AbortSignal
): Promise<void> {
  await client.json(
    'PATCH',
    `/apis/batch/v1${ns(namespace)}/cronjobs/${encodeURIComponent(name)}`,
    {
      body: { spec: { suspend } },
      contentType: 'application/merge-patch+json',
      ...sig(signal)
    }
  )
}

/**
 * Secret trong YAML lấy từ Shellhouse có giá trị bị ẩn (chuỗi rỗng — xem hideSecretValuesForEdit),
 * khoá bị ẩn ghi trong annotation MASKED_KEYS_ANNOTATION. Ghi nguyên như vậy sẽ XOÁ giá trị thật →
 * khoá bị ẩn còn rỗng mà trên cluster đang có giá trị thì giữ giá trị đang có. Khoá không bị ẩn (hoặc
 * YAML không có annotation) để rỗng là người dùng muốn rỗng thật. Annotation luôn bị bỏ trước khi gửi.
 * Muốn đổi giá trị: ghi giá trị mới (base64) vào data hoặc dùng stringData; muốn bỏ khoá: xoá dòng.
 */
export async function keepHiddenSecretValues(
  client: KubeClient,
  kind: ResourceKind,
  namespace: string | undefined,
  o: K8sObject,
  signal?: AbortSignal
): Promise<void> {
  if (kind.id !== 'secrets') return
  const annotations = o.metadata.annotations
  const marker = annotations?.[MASKED_KEYS_ANNOTATION]
  if (annotations && marker !== undefined) {
    const rest = Object.fromEntries(
      Object.entries(annotations).filter(([k]) => k !== MASKED_KEYS_ANNOTATION)
    )
    if (Object.keys(rest).length) o.metadata.annotations = rest
    else delete o.metadata.annotations
  }
  if (!o.data || typeof marker !== 'string') return
  const masked = new Set(marker.split(',').filter(Boolean))
  const empty = Object.entries(o.data).filter(([k, v]) => v === '' && masked.has(k))
  if (!empty.length) return
  const current = await client
    .json<K8sObject>('GET', resourcePath(kind, namespace, o.metadata.name), sig(signal))
    .catch((error: unknown) => {
      if (error instanceof KubeError && error.status === 404) return null
      throw error
    })
  const data = { ...o.data }
  for (const [k] of empty) {
    const v = current?.data?.[k]
    if (v) data[k] = v
  }
  o.data = data
}

/**
 * Server-side apply từng tài liệu YAML (tạo mới hoặc cập nhật, như `kubectl apply --server-side`).
 * Tài liệu lỗi không chặn tài liệu khác; mỗi tài liệu một kết quả.
 */
export async function serverApply(
  client: KubeClient,
  text: string,
  defaultNamespace: string,
  findKind: (apiVersion: string, kind: string) => Promise<ResourceKind | undefined>,
  signal?: AbortSignal
): Promise<ApplyResult[]> {
  const docs = parseAllDocuments(text)
  const out: ApplyResult[] = []
  for (const doc of docs) {
    if (doc.errors.length) {
      out.push({
        object: '(invalid YAML)',
        action: 'error',
        error: doc.errors[0]?.message ?? 'Invalid YAML'
      })
      continue
    }
    const o = doc.toJS() as K8sObject | null
    if (!o) continue
    const label = `${(o.kind ?? '?').toLowerCase()}/${(o.metadata as K8sObject['metadata'] | undefined)?.name ?? '?'}`
    try {
      if (!o.apiVersion || !o.kind || !(o.metadata as K8sObject['metadata'] | undefined)?.name)
        throw new Error('needs apiVersion, kind and metadata.name')
      const kind = await findKind(o.apiVersion, o.kind)
      if (!kind) throw new Error(`unknown kind ${o.kind} (${o.apiVersion})`)
      const namespace = kind.namespaced ? (o.metadata.namespace ?? defaultNamespace) : undefined
      if (namespace) o.metadata.namespace = namespace
      delete o.metadata.resourceVersion
      await keepHiddenSecretValues(client, kind, namespace, o, signal)
      await client.json('PATCH', resourcePath(kind, namespace, o.metadata.name), {
        body: o,
        contentType: 'application/apply-patch+yaml',
        query: { fieldManager: 'shellhouse', force: false },
        ...sig(signal)
      })
      out.push({ object: namespace ? `${namespace}/${label}` : label, action: 'configured' })
    } catch (error) {
      out.push({
        object: label,
        action: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return out
}

/** Pod / container cần lấy log: một pod, mọi container của pod, hoặc mọi pod khớp selector. */
export async function logTargets(
  client: KubeClient,
  namespace: string,
  op: {
    pod?: string | undefined
    selector?: string | undefined
    pods?: readonly string[] | undefined
    container?: string | undefined
    allContainers?: boolean | undefined
  },
  signal?: AbortSignal
): Promise<{ pod: string; container: string | undefined }[]> {
  const containersOf = (p: K8sObject): string[] =>
    ((p.spec?.['containers'] as { name: string }[] | undefined) ?? []).map((c) => c.name)
  if (op.pod && !op.allContainers) return [{ pod: op.pod, container: op.container }]
  const pods = op.pods
    ? (await client.json<List>('GET', `/api/v1${ns(namespace)}/pods`, sig(signal))).items.filter(
        (p) => op.pods?.includes(p.metadata.name)
      )
    : op.pod
      ? [
          await client.json<K8sObject>(
            'GET',
            `/api/v1${ns(namespace)}/pods/${encodeURIComponent(op.pod)}`,
            sig(signal)
          )
        ]
      : (
          await client.json<List>('GET', `/api/v1${ns(namespace)}/pods`, {
            query: { labelSelector: op.selector },
            ...sig(signal)
          })
        ).items
  if (pods.length === 0) throw new Error('No pods match')
  return pods
    .slice(0, 20)
    .flatMap((p) =>
      op.allContainers || !op.container
        ? op.allContainers
          ? containersOf(p).map((c) => ({ pod: p.metadata.name, container: c }))
          : [{ pod: p.metadata.name, container: containersOf(p)[0] }]
        : [{ pod: p.metadata.name, container: op.container }]
    )
}

/** Chạy `fn` cho từng phần tử, tối đa `limit` cùng lúc (không dồn hàng trăm request một lúc). */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i] as T, i)
      }
    })
  )
  return out
}

/**
 * Vấn đề cần xem cả cluster (Home › Needs attention): như trang tổng quan nhưng chỉ đọc pod, node,
 * PVC (không metrics, không event) — nhẹ để hỏi định kỳ khi tab đang mở. Thiếu quyền một loại → bỏ
 * qua loại đó.
 */
export async function problems(
  client: KubeClient,
  signal?: AbortSignal
): Promise<NonNullable<OverviewResult['problems']>> {
  const opts = { signal, max: 5000 }
  const none = { items: [] as K8sObject[], truncated: false }
  const [nodes, pods, pvcs] = await Promise.all([
    listPaged(client, '/api/v1/nodes', opts).catch(() => none),
    listPaged(client, '/api/v1/pods', opts).catch(() => none),
    listPaged(client, '/api/v1/persistentvolumeclaims', opts).catch(() => none)
  ])
  return findProblems(nodes.items, pods.items, pvcs.items)
}

/**
 * Tóm tắt cho bảng theo dõi (Home): phiên bản, node sẵn sàng, vấn đề (như `problems`), hạn chứng
 * chỉ API server (đọc lúc bắt tay TLS) và chứng chỉ client trong kubeconfig.
 */
export async function fleet(
  client: KubeClient,
  clientCert: string | undefined,
  signal?: AbortSignal
): Promise<FleetResult> {
  const opts = { signal, max: 5000 }
  const none = { items: [] as K8sObject[], truncated: false }
  const [version, nodes, pods, pvcs] = await Promise.all([
    client.json<{ gitVersion?: string }>('GET', '/version', signal ? { signal } : {}),
    listPaged(client, '/api/v1/nodes', opts).catch(() => none),
    listPaged(client, '/api/v1/pods', opts).catch(() => none),
    listPaged(client, '/api/v1/persistentvolumeclaims', opts).catch(() => none)
  ])
  const found = findProblems(nodes.items, pods.items, pvcs.items)
  const clientCertExpiry = clientCert ? certExpiry(clientCert) : null
  return {
    version: version.gitVersion ?? '',
    nodes: { total: nodes.items.length, ready: nodes.items.length - found.nodes.total },
    problems: found,
    ...(client.serverCertExpiry ? { serverCertExpiry: client.serverCertExpiry } : {}),
    ...(clientCertExpiry ? { clientCertExpiry } : {})
  }
}

/**
 * Pod / deployment lỗi theo namespace, cả cluster (Explorer hiện "2 failing" cạnh namespace, Pods,
 * Deployments). Pod lỗi = nhóm failing + imagePull của trang tổng quan; deployment chưa đủ =
 * còn replica chưa sẵn sàng. Không đọc được (thiếu quyền) → rỗng.
 */
export async function health(client: KubeClient, signal?: AbortSignal): Promise<HealthResult> {
  const opts = { signal, max: 5000 }
  const none = { items: [] as K8sObject[], truncated: false }
  const [podList, deployList] = await Promise.all([
    listPaged(client, '/api/v1/pods', opts).catch(() => none),
    listPaged(client, '/apis/apps/v1/deployments', opts).catch(() => none)
  ])
  const pods: Record<string, number> = {}
  const problems = findProblems([], podList.items, [], Date.now(), Number.POSITIVE_INFINITY)
  for (const p of [...problems.failing.items, ...problems.imagePull.items]) {
    const n = p.namespace ?? ''
    pods[n] = (pods[n] ?? 0) + 1
  }
  const deployments: Record<string, number> = {}
  for (const d of deployList.items) {
    const wanted = (d.spec?.['replicas'] as number | undefined) ?? 1
    const available = (d.status?.['availableReplicas'] as number | undefined) ?? 0
    if (wanted > 0 && available < wanted) {
      const n = d.metadata.namespace ?? ''
      deployments[n] = (deployments[n] ?? 0) + 1
    }
  }
  return { pods, deployments }
}

/** Đếm theo trang tối đa chừng này đối tượng mỗi loại / namespace (quá → "N+"). */
const COUNT_MAX = 10_000

/**
 * Đếm đối tượng: `limit=1` + `metadata.remainingItemCount` (một request nhỏ mỗi loại / namespace);
 * server không trả số → đếm theo trang (chỉ metadata) tới COUNT_MAX — quá thì đánh dấu
 * `${COUNT_CAPPED}<id>`. Lỗi / không có quyền → null.
 */
export async function counts(
  client: KubeClient,
  kinds: readonly ResourceKind[],
  namespaces: readonly string[],
  signal?: AbortSignal
): Promise<Record<string, number | null>> {
  const countPath = async (path: string): Promise<{ n: number; capped: boolean }> => {
    let total = 0
    let cont: string | undefined
    for (let page = 0; ; page++) {
      const r = await client.json<{
        items: unknown[] | null
        metadata?: { remainingItemCount?: number; continue?: string }
      }>('GET', path, {
        query: { limit: page === 0 ? 1 : 1000, continue: cont },
        accept: METADATA_ONLY,
        ...(signal ? { signal } : {})
      })
      total += r.items?.length ?? 0
      if (page === 0 && typeof r.metadata?.remainingItemCount === 'number')
        return { n: total + r.metadata.remainingItemCount, capped: false }
      cont = r.metadata?.continue || undefined
      if (!cont) return { n: total, capped: false }
      if (total >= COUNT_MAX) return { n: total, capped: true }
    }
  }
  const out: Record<string, number | null> = {}
  // 6 loại cùng lúc — đủ nhanh, không dồn API server.
  await pool(kinds, 6, async (k) => {
    try {
      const scope = k.namespaced && namespaces.length > 0 ? namespaces : [undefined]
      let n = 0
      let capped = false
      for (const ns of scope) {
        const c = await countPath(resourcePath(k, ns))
        n += c.n
        capped ||= c.capped
      }
      out[k.id] = n
      if (capped) out[`${COUNT_CAPPED}${k.id}`] = 1
    } catch {
      out[k.id] = null
    }
  })
  return out
}

/** Application của Argo CD (phiên bản API lấy từ discovery — thường v1alpha1). */
function argoPath(version: string, namespace: string, name: string): string {
  return `/apis/argoproj.io/${version}${ns(namespace)}/applications/${encodeURIComponent(name)}`
}

/**
 * Sync như nút Sync của Argo CD: ghi trường `operation` — application controller thấy và chạy
 * (cùng cách argocd CLI / UI làm). Đang có thao tác chạy → báo, không chồng lên.
 */
export async function argoSync(
  client: KubeClient,
  version: string,
  namespace: string,
  name: string,
  prune: boolean,
  signal?: AbortSignal
): Promise<void> {
  const app = await client.json<K8sObject>('GET', argoPath(version, namespace, name), sig(signal))
  const running = (app as { operation?: unknown }).operation
  if (running) throw new Error(`${name} is already syncing — wait for it to finish`)
  const source = (app.spec?.['source'] ?? {}) as { targetRevision?: string }
  await client.json('PATCH', argoPath(version, namespace, name), {
    body: {
      operation: {
        initiatedBy: { username: 'shellhouse' },
        sync: {
          ...(source.targetRevision ? { revision: source.targetRevision } : {}),
          prune,
          syncStrategy: { hook: {} }
        }
      }
    },
    contentType: 'application/merge-patch+json',
    ...sig(signal)
  })
}

/** Refresh: Argo CD so lại trạng thái với Git ngay (annotation, controller tự xoá sau khi xong). */
export async function argoRefresh(
  client: KubeClient,
  version: string,
  namespace: string,
  name: string,
  hard: boolean,
  signal?: AbortSignal
): Promise<void> {
  await client.json('PATCH', argoPath(version, namespace, name), {
    body: { metadata: { annotations: { 'argocd.argoproj.io/refresh': hard ? 'hard' : 'normal' } } },
    contentType: 'application/merge-patch+json',
    ...sig(signal)
  })
}

// ——— Helm 3 ———

export interface HelmSecret {
  metadata: {
    name: string
    namespace?: string
    labels?: Record<string, string>
    resourceVersion?: string
  }
  data?: Record<string, string>
  type?: string
}

export interface HelmRecord {
  name?: string
  namespace?: string
  version?: number
  info?: {
    status?: string
    first_deployed?: string
    last_deployed?: string
    deleted?: string
    description?: string
    notes?: string
    [key: string]: unknown
  }
  chart?: {
    metadata?: { name?: string; version?: string; appVersion?: string }
    values?: Record<string, unknown> | null
    [key: string]: unknown
  }
  config?: Record<string, unknown> | null
  manifest?: string
  hooks?: { name?: string; kind?: string; events?: string[] }[] | null
  /** Các trường khác của Helm (labels…) — giữ nguyên khi ghi lại. */
  [key: string]: unknown
}

/** Secret của Helm: data.release = base64(base64(gzip(JSON))). */
export function decodeHelmRelease(data: string): HelmRecord {
  const inner = Buffer.from(Buffer.from(data, 'base64').toString('utf8'), 'base64')
  const json = inner[0] === 0x1f && inner[1] === 0x8b ? gunzipSync(inner) : inner
  return JSON.parse(json.toString('utf8')) as HelmRecord
}

export function summary(r: HelmRecord, fallback: HelmSecret): HelmRelease {
  const labels = fallback.metadata.labels ?? {}
  return {
    name: r.name ?? labels['name'] ?? '',
    namespace: r.namespace ?? fallback.metadata.namespace ?? '',
    revision: r.version ?? Number(labels['version'] ?? 0),
    status: r.info?.status ?? labels['status'] ?? 'unknown',
    chart: r.chart?.metadata?.name ?? '',
    chartVersion: r.chart?.metadata?.version ?? '',
    appVersion: r.chart?.metadata?.appVersion ?? '',
    updated: Date.parse(r.info?.last_deployed ?? '') || 0,
    description: r.info?.description ?? ''
  }
}

export async function helmSecrets(
  client: KubeClient,
  namespaces: readonly string[],
  selector: string,
  signal?: AbortSignal,
  accept?: string
): Promise<HelmSecret[]> {
  const query = { labelSelector: selector, fieldSelector: 'type=helm.sh/release.v1' }
  const lists = await Promise.all(
    (namespaces.length ? namespaces : [undefined]).map((n) =>
      listPaged(client, `/api/v1${n ? ns(n) : ''}/secrets`, {
        query,
        signal,
        max: 20_000,
        ...(accept ? { accept } : {})
      })
    )
  )
  return lists.flatMap((l) => l.items as HelmSecret[])
}

/**
 * Mọi release (revision mới nhất của mỗi tên): list chỉ metadata (nhãn name / version / status —
 * không tải dữ liệu nén của mọi revision, có thể hàng chục MB), rồi chỉ GET đúng revision mới nhất.
 */
export async function helmReleases(
  client: KubeClient,
  namespaces: readonly string[],
  signal?: AbortSignal
): Promise<HelmRelease[]> {
  const secrets = await helmSecrets(client, namespaces, 'owner=helm', signal, METADATA_ONLY)
  const latest = new Map<string, HelmSecret>()
  for (const sec of secrets) {
    const labels = sec.metadata.labels ?? {}
    const key = `${sec.metadata.namespace ?? ''}/${labels['name'] ?? ''}`
    const cur = latest.get(key)
    if (!cur || Number(labels['version'] ?? 0) > Number(cur.metadata.labels?.['version'] ?? 0))
      latest.set(key, sec)
  }
  const out = await pool([...latest.values()], 8, async (meta) => {
    let record: HelmRecord = {}
    try {
      // Server không hỗ trợ list chỉ metadata → đã có data, khỏi GET lại.
      const data =
        meta.data?.['release'] ??
        (
          await client.json<HelmSecret>(
            'GET',
            `/api/v1${ns(meta.metadata.namespace ?? 'default')}/secrets/${encodeURIComponent(meta.metadata.name)}`,
            signal ? { signal } : {}
          )
        ).data?.['release']
      if (data) record = decodeHelmRelease(data)
    } catch {
      // Hỏng / định dạng lạ / vừa bị xoá: vẫn hiện theo nhãn.
    }
    return summary(record, meta)
  })
  return out.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

/** Chi tiết release: revision mới nhất (values / notes / manifest) + lịch sử mọi revision. */
export async function helmRelease(
  client: KubeClient,
  namespace: string,
  name: string,
  signal?: AbortSignal
): Promise<HelmReleaseDetail> {
  const secrets = await helmSecrets(client, [namespace], `owner=helm,name=${name}`, signal)
  if (secrets.length === 0) throw new Error(`Helm release ${name} was not found`)
  const records = secrets
    .map((sec) => {
      try {
        return { sec, r: sec.data?.['release'] ? decodeHelmRelease(sec.data['release']) : {} }
      } catch {
        return { sec, r: {} }
      }
    })
    .sort((x, y) => summary(y.r, y.sec).revision - summary(x.r, x.sec).revision)
  const top = records[0]
  if (!top) throw new Error(`Helm release ${name} was not found`)
  const config = top.r.config
  return {
    ...summary(top.r, top.sec),
    values: config && Object.keys(config).length ? toYamlText(config) : '',
    notes: top.r.info?.notes ?? '',
    manifest: top.r.manifest ?? '',
    history: records.map(({ r, sec }) => {
      const x = summary(r, sec)
      return {
        revision: x.revision,
        status: x.status,
        chart: x.chart,
        chartVersion: x.chartVersion,
        appVersion: x.appVersion,
        updated: x.updated,
        description: x.description
      }
    })
  }
}
