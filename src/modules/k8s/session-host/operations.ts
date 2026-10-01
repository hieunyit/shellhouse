import { randomBytes } from 'node:crypto'
import { parseAllDocuments } from 'yaml'
import type {
  ApplyResult,
  DrainResult,
  MetricsResult,
  OverviewResult,
  RolloutRevision,
  Usage
} from '../shared/ops'
import {
  parseCpu,
  parseMemory,
  podRequests,
  resourcePath,
  selectorString,
  type K8sObject,
  type ResourceKind
} from '../shared/resources'
import { KubeError, type KubeClient } from './client'

/** Các thao tác kiểu k9s / Lens không phải CRUD đơn giản (ADR-014 mục 7.4). */

type List = { items: K8sObject[] }
const ns = (n: string): string => `/namespaces/${encodeURIComponent(n)}`

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

async function listIn(
  client: KubeClient,
  path: (n?: string) => string,
  namespaces: readonly string[]
): Promise<K8sObject[]> {
  if (namespaces.length === 0) return (await client.json<List>('GET', path())).items
  const lists = await Promise.all(namespaces.map((n) => client.json<List>('GET', path(n))))
  return lists.flatMap((l) => l.items)
}

/** Tổng quan cluster: node, pod theo trạng thái, workload sẵn sàng, cảnh báo gần đây, tài nguyên. */
export async function overview(
  client: KubeClient,
  namespaces: readonly string[]
): Promise<OverviewResult> {
  const [version, nodes, pods, deploys, sets, daemons, events, usage] = await Promise.all([
    client.json<{ gitVersion?: string }>('GET', '/version'),
    client.json<List>('GET', '/api/v1/nodes').catch(() => ({ items: [] as K8sObject[] })),
    listIn(client, (n) => `/api/v1${n ? ns(n) : ''}/pods`, namespaces),
    listIn(client, (n) => `/apis/apps/v1${n ? ns(n) : ''}/deployments`, namespaces).catch(() => []),
    listIn(client, (n) => `/apis/apps/v1${n ? ns(n) : ''}/statefulsets`, namespaces).catch(
      () => []
    ),
    listIn(client, (n) => `/apis/apps/v1${n ? ns(n) : ''}/daemonsets`, namespaces).catch(() => []),
    listIn(client, (n) => `/api/v1${n ? ns(n) : ''}/events`, namespaces).catch(() => []),
    metrics(client, 'nodes', undefined).catch(() => ({ available: false, items: {} }))
  ])
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
    const v = (o[path] as Record<string, unknown> | undefined)?.[key]
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
        reason: String(e['reason'] ?? ''),
        message: String(e['message'] ?? ''),
        count: typeof e['count'] === 'number' ? e['count'] : 1,
        last: String(e['lastTimestamp'] ?? e['eventTime'] ?? e.metadata.creationTimestamp ?? '')
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
    warnings
  }
}

/** ReplicaSet của deployment theo revision (mới nhất trước) — như `kubectl rollout history`. */
export async function rolloutHistory(
  client: KubeClient,
  namespace: string,
  name: string
): Promise<RolloutRevision[]> {
  const deploy = await client.json<K8sObject>(
    'GET',
    `/apis/apps/v1${ns(namespace)}/deployments/${encodeURIComponent(name)}`
  )
  const selector = selectorString(deploy.spec?.['selector'])
  const sets = await client.json<List>('GET', `/apis/apps/v1${ns(namespace)}/replicasets`, {
    query: { labelSelector: selector ?? undefined }
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
  revision: number
): Promise<void> {
  const path = `/apis/apps/v1${ns(namespace)}/deployments/${encodeURIComponent(name)}`
  const deploy = await client.json<K8sObject>('GET', path)
  const selector = selectorString(deploy.spec?.['selector'])
  const sets = await client.json<List>('GET', `/apis/apps/v1${ns(namespace)}/replicasets`, {
    query: { labelSelector: selector ?? undefined }
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
  await client.json('PUT', path, { body: { ...deploy, spec: { ...deploy.spec, template } } })
}

export async function cordon(
  client: KubeClient,
  node: string,
  unschedulable: boolean
): Promise<void> {
  await client.json('PATCH', `/api/v1/nodes/${encodeURIComponent(node)}`, {
    body: { spec: { unschedulable } },
    contentType: 'application/merge-patch+json'
  })
}

/** Drain: cordon rồi evict mọi pod (bỏ qua pod của DaemonSet và static pod) — như `kubectl drain`. */
export async function drain(client: KubeClient, node: string): Promise<DrainResult> {
  await cordon(client, node, true)
  const pods = await client.json<List>('GET', '/api/v1/pods', {
    query: { fieldSelector: `spec.nodeName=${node}` }
  })
  const result: DrainResult = { evicted: [], skipped: [], failed: [] }
  await Promise.all(
    pods.items.map(async (p) => {
      const key = `${p.metadata.namespace ?? ''}/${p.metadata.name}`
      const owners = p.metadata.ownerReferences ?? []
      const mirror = p.metadata.annotations?.['kubernetes.io/config.mirror'] !== undefined
      const phase = p.status?.['phase']
      if (
        owners.some((o) => o.kind === 'DaemonSet') ||
        mirror ||
        phase === 'Succeeded' ||
        phase === 'Failed'
      ) {
        result.skipped.push(key)
        return
      }
      try {
        await client.json(
          'POST',
          `/api/v1${ns(p.metadata.namespace ?? 'default')}/pods/${encodeURIComponent(p.metadata.name)}/eviction`,
          {
            body: {
              apiVersion: 'policy/v1',
              kind: 'Eviction',
              metadata: { name: p.metadata.name, namespace: p.metadata.namespace }
            }
          }
        )
        result.evicted.push(key)
      } catch (error) {
        result.failed.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  )
  return result
}

/** Chạy CronJob ngay (tạo Job từ jobTemplate) — như `kubectl create job --from=cronjob/x`. */
export async function cronTrigger(
  client: KubeClient,
  namespace: string,
  name: string
): Promise<string> {
  const cron = await client.json<K8sObject>(
    'GET',
    `/apis/batch/v1${ns(namespace)}/cronjobs/${encodeURIComponent(name)}`
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
    }
  })
  return jobName
}

export async function cronSuspend(
  client: KubeClient,
  namespace: string,
  name: string,
  suspend: boolean
): Promise<void> {
  await client.json(
    'PATCH',
    `/apis/batch/v1${ns(namespace)}/cronjobs/${encodeURIComponent(name)}`,
    {
      body: { spec: { suspend } },
      contentType: 'application/merge-patch+json'
    }
  )
}

/**
 * Server-side apply từng tài liệu YAML (tạo mới hoặc cập nhật, như `kubectl apply --server-side`).
 * Tài liệu lỗi không chặn tài liệu khác; mỗi tài liệu một kết quả.
 */
export async function serverApply(
  client: KubeClient,
  text: string,
  defaultNamespace: string,
  findKind: (apiVersion: string, kind: string) => Promise<ResourceKind | undefined>
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
      await client.json('PATCH', resourcePath(kind, namespace, o.metadata.name), {
        body: o,
        contentType: 'application/apply-patch+yaml',
        query: { fieldManager: 'shellhouse', force: false }
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
    container?: string | undefined
    allContainers?: boolean | undefined
  }
): Promise<{ pod: string; container: string | undefined }[]> {
  const containersOf = (p: K8sObject): string[] =>
    ((p.spec?.['containers'] as { name: string }[] | undefined) ?? []).map((c) => c.name)
  if (op.pod && !op.allContainers) return [{ pod: op.pod, container: op.container }]
  const pods = op.pod
    ? [
        await client.json<K8sObject>(
          'GET',
          `/api/v1${ns(namespace)}/pods/${encodeURIComponent(op.pod)}`
        )
      ]
    : (
        await client.json<List>('GET', `/api/v1${ns(namespace)}/pods`, {
          query: { labelSelector: op.selector }
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
