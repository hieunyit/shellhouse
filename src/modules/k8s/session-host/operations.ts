import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { parseAllDocuments, stringify as toYamlText } from 'yaml'
import type {
  HelmRelease,
  HelmReleaseDetail,
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

/**
 * Đếm đối tượng: `limit=1` + `metadata.remainingItemCount` (một request nhỏ mỗi loại / namespace);
 * server không trả số → đếm theo trang (tối đa 5000). Lỗi / không có quyền → null.
 */
export async function counts(
  client: KubeClient,
  kinds: readonly ResourceKind[],
  namespaces: readonly string[]
): Promise<Record<string, number | null>> {
  const countPath = async (path: string): Promise<number> => {
    let total = 0
    let cont: string | undefined
    for (let page = 0; page < 10; page++) {
      const r = await client.json<{
        items: unknown[]
        metadata?: { remainingItemCount?: number; continue?: string }
      }>('GET', path, { query: { limit: page === 0 ? 1 : 500, continue: cont } })
      total += r.items.length
      if (page === 0 && typeof r.metadata?.remainingItemCount === 'number')
        return total + r.metadata.remainingItemCount
      cont = r.metadata?.continue || undefined
      if (!cont) return total
    }
    return total
  }
  const out: Record<string, number | null> = {}
  const jobs = kinds.map((k) => async () => {
    try {
      const scope = k.namespaced && namespaces.length > 0 ? namespaces : [undefined]
      let n = 0
      for (const ns of scope) n += await countPath(resourcePath(k, ns))
      out[k.id] = n
    } catch {
      out[k.id] = null
    }
  })
  // 6 loại cùng lúc — đủ nhanh, không dồn API server.
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(6, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]?.()
    })
  )
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
  prune: boolean
): Promise<void> {
  const app = await client.json<K8sObject>('GET', argoPath(version, namespace, name))
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
    contentType: 'application/merge-patch+json'
  })
}

/** Refresh: Argo CD so lại trạng thái với Git ngay (annotation, controller tự xoá sau khi xong). */
export async function argoRefresh(
  client: KubeClient,
  version: string,
  namespace: string,
  name: string,
  hard: boolean
): Promise<void> {
  await client.json('PATCH', argoPath(version, namespace, name), {
    body: { metadata: { annotations: { 'argocd.argoproj.io/refresh': hard ? 'hard' : 'normal' } } },
    contentType: 'application/merge-patch+json'
  })
}

// ——— Helm 3 ———

interface HelmSecret {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  data?: Record<string, string>
}

interface HelmRecord {
  name?: string
  namespace?: string
  version?: number
  info?: {
    status?: string
    last_deployed?: string
    description?: string
    notes?: string
  }
  chart?: { metadata?: { name?: string; version?: string; appVersion?: string } }
  config?: Record<string, unknown> | null
  manifest?: string
}

/** Secret của Helm: data.release = base64(base64(gzip(JSON))). */
export function decodeHelmRelease(data: string): HelmRecord {
  const inner = Buffer.from(Buffer.from(data, 'base64').toString('utf8'), 'base64')
  const json = inner[0] === 0x1f && inner[1] === 0x8b ? gunzipSync(inner) : inner
  return JSON.parse(json.toString('utf8')) as HelmRecord
}

function summary(r: HelmRecord, fallback: HelmSecret): HelmRelease {
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

async function helmSecrets(
  client: KubeClient,
  namespaces: readonly string[],
  selector: string
): Promise<HelmSecret[]> {
  const path = (n?: string): string => `/api/v1${n ? ns(n) : ''}/secrets`
  const query = { labelSelector: selector, fieldSelector: 'type=helm.sh/release.v1' }
  if (namespaces.length === 0)
    return (await client.json<{ items: HelmSecret[] }>('GET', path(), { query })).items
  const lists = await Promise.all(
    namespaces.map((n) => client.json<{ items: HelmSecret[] }>('GET', path(n), { query }))
  )
  return lists.flatMap((l) => l.items)
}

/** Mọi release (revision mới nhất của mỗi tên) — chỉ giải mã đúng revision đó. */
export async function helmReleases(
  client: KubeClient,
  namespaces: readonly string[]
): Promise<HelmRelease[]> {
  const secrets = await helmSecrets(client, namespaces, 'owner=helm')
  const latest = new Map<string, HelmSecret>()
  for (const sec of secrets) {
    const labels = sec.metadata.labels ?? {}
    const key = `${sec.metadata.namespace ?? ''}/${labels['name'] ?? ''}`
    const cur = latest.get(key)
    if (!cur || Number(labels['version'] ?? 0) > Number(cur.metadata.labels?.['version'] ?? 0))
      latest.set(key, sec)
  }
  const out: HelmRelease[] = []
  for (const sec of latest.values()) {
    let record: HelmRecord = {}
    try {
      if (sec.data?.['release']) record = decodeHelmRelease(sec.data['release'])
    } catch {
      // Hỏng / định dạng lạ: vẫn hiện theo nhãn.
    }
    out.push(summary(record, sec))
  }
  return out.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

/** Chi tiết release: revision mới nhất (values / notes / manifest) + lịch sử mọi revision. */
export async function helmRelease(
  client: KubeClient,
  namespace: string,
  name: string
): Promise<HelmReleaseDetail> {
  const secrets = await helmSecrets(client, [namespace], `owner=helm,name=${name}`)
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
