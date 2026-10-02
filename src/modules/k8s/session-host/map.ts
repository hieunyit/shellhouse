import { detectTech } from '../shared/map'
import type {
  MapData,
  MapGateway,
  MapHpa,
  MapNodeInfo,
  MapPod,
  MapPolicy,
  MapPvc,
  MapRoute,
  MapService,
  MapWorkload
} from '../shared/map'
import {
  parseCpu,
  parseMemory,
  podRequests,
  podStatus,
  toRow,
  type K8sObject
} from '../shared/resources'
import { KubeError, type KubeClient } from './client'
import { metrics } from './operations'
import type { MetricsResult } from '../shared/ops'

/**
 * Dữ liệu cho bản đồ cluster: một lượt list các loại cần (song song, có giới hạn), chỉ giữ trường
 * cần vẽ — 5000 workload / 20000 pod vẫn gọn. Không có quyền / API không có → bỏ loại đó.
 */

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const a = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : [])
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

/** Mỗi loại tối đa chừng này đối tượng (cluster quá lớn → báo truncated). */
const MAX_PER_KIND = 25_000
const PAGE = 500

const WORKLOAD_KINDS = [
  { id: 'deployments.apps', path: '/apis/apps/v1', plural: 'deployments' },
  { id: 'statefulsets.apps', path: '/apis/apps/v1', plural: 'statefulsets' },
  { id: 'daemonsets.apps', path: '/apis/apps/v1', plural: 'daemonsets' },
  { id: 'cronjobs.batch', path: '/apis/batch/v1', plural: 'cronjobs' },
  { id: 'jobs.batch', path: '/apis/batch/v1', plural: 'jobs' }
] as const

interface Listed {
  items: K8sObject[]
  truncated: boolean
}

/** List có phân trang, theo từng namespace (hoặc cả cluster); lỗi quyền / 404 → rỗng. */
async function listAll(
  client: KubeClient,
  api: string,
  plural: string,
  namespaces: readonly string[],
  signal?: AbortSignal
): Promise<Listed> {
  const scopes = namespaces.length ? namespaces : [undefined]
  const items: K8sObject[] = []
  let truncated = false
  for (const ns of scopes) {
    const path = `${api}${ns ? `/namespaces/${encodeURIComponent(ns)}` : ''}/${plural}`
    let cont: string | undefined
    try {
      do {
        const r = await client.json<{ items: K8sObject[]; metadata?: { continue?: string } }>(
          'GET',
          path,
          { query: { limit: PAGE, continue: cont }, ...(signal ? { signal } : {}) }
        )
        items.push(...r.items)
        cont = r.metadata?.continue || undefined
        if (items.length >= MAX_PER_KIND) {
          truncated = Boolean(cont)
          break
        }
      } while (cont)
    } catch (error) {
      if (error instanceof KubeError && (error.status === 403 || error.status === 404)) continue
      throw error
    }
  }
  return { items, truncated }
}

function templateOf(kind: string, w: K8sObject): Obj {
  const spec = o(w.spec)
  return kind === 'cronjobs.batch'
    ? o(o(o(spec['jobTemplate'])['spec'])['template'])
    : o(spec['template'])
}

function claimNames(kind: string, w: K8sObject, pvcNames: readonly string[]): string[] {
  const out = new Set<string>()
  for (const v of a(o(templateOf(kind, w)['spec'])['volumes'])) {
    const claim = s(o(v['persistentVolumeClaim'])['claimName'])
    if (claim) out.add(claim)
  }
  if (kind === 'statefulsets.apps')
    for (const t of a(o(w.spec)['volumeClaimTemplates'])) {
      const prefix = `${s(o(t['metadata'])['name'])}-${w.metadata.name}-`
      for (const p of pvcNames)
        if (p.startsWith(prefix) && /^\d+$/.test(p.slice(prefix.length))) out.add(p)
    }
  return [...out]
}

/**
 * Namespace đang xem (kèm nhãn — để gom vùng theo nhãn): đọc từng cái; không đọc được (không có
 * quyền get namespace) → chỉ có tên.
 */
async function scopedNamespaces(
  client: KubeClient,
  namespaces: readonly string[],
  signal?: AbortSignal
): Promise<Listed> {
  const items = await Promise.all(
    namespaces.map((n) =>
      client
        .json<K8sObject>(
          'GET',
          `/api/v1/namespaces/${encodeURIComponent(n)}`,
          signal ? { signal } : {}
        )
        .catch((): K8sObject => ({ metadata: { name: n } }))
    )
  )
  return { items, truncated: false }
}

export async function mapData(
  client: KubeClient,
  namespaces: readonly string[],
  signal?: AbortSignal
): Promise<MapData> {
  // Song song theo loại (mỗi loại phân trang tuần tự) — ~12 loại cùng lúc là đủ nhanh, không dồn.
  const [
    nsList,
    nodes,
    pods,
    rs,
    services,
    ingresses,
    httpRoutes,
    grpcRoutes,
    pvcs,
    hpas,
    policies,
    gateways,
    usage,
    ...workloadLists
  ] = await Promise.all([
    namespaces.length
      ? scopedNamespaces(client, namespaces, signal)
      : listAll(client, '/api/v1', 'namespaces', [], signal),
    listAll(client, '/api/v1', 'nodes', [], signal),
    listAll(client, '/api/v1', 'pods', namespaces, signal),
    listAll(client, '/apis/apps/v1', 'replicasets', namespaces, signal),
    listAll(client, '/api/v1', 'services', namespaces, signal),
    listAll(client, '/apis/networking.k8s.io/v1', 'ingresses', namespaces, signal),
    listAll(client, '/apis/gateway.networking.k8s.io/v1', 'httproutes', namespaces, signal),
    listAll(client, '/apis/gateway.networking.k8s.io/v1', 'grpcroutes', namespaces, signal),
    listAll(client, '/api/v1', 'persistentvolumeclaims', namespaces, signal),
    listAll(client, '/apis/autoscaling/v2', 'horizontalpodautoscalers', namespaces, signal),
    listAll(client, '/apis/networking.k8s.io/v1', 'networkpolicies', namespaces, signal),
    listAll(client, '/apis/gateway.networking.k8s.io/v1', 'gateways', namespaces, signal),
    metrics(client, 'nodes', undefined, signal).catch((): MetricsResult => ({
      available: false,
      items: {}
    })),
    ...WORKLOAD_KINDS.map((k) => listAll(client, k.path, k.plural, namespaces, signal))
  ])

  // Owner gốc: ReplicaSet → Deployment, Job → CronJob.
  const rsOwner = new Map<string, { kind: string; name: string }>()
  for (const r of rs.items) {
    const ref = (r.metadata.ownerReferences ?? []).find((x) => x.controller !== false)
    if (ref) rsOwner.set(`${r.metadata.namespace ?? ''}/${r.metadata.name}`, ref)
  }
  const jobs = workloadLists[WORKLOAD_KINDS.findIndex((k) => k.id === 'jobs.batch')]?.items ?? []
  const jobOwner = new Map<string, { kind: string; name: string }>()
  for (const j of jobs) {
    const ref = (j.metadata.ownerReferences ?? []).find((x) => x.kind === 'CronJob')
    if (ref) jobOwner.set(`${j.metadata.namespace ?? ''}/${j.metadata.name}`, ref)
  }
  const topOwner = (p: K8sObject): { kind: string; name: string } | null => {
    const ns = p.metadata.namespace ?? ''
    const ref = (p.metadata.ownerReferences ?? []).find((x) => x.controller !== false)
    if (!ref) return null
    if (ref.kind === 'ReplicaSet') {
      const up = rsOwner.get(`${ns}/${ref.name}`)
      return up ? { kind: up.kind, name: up.name } : { kind: 'ReplicaSet', name: ref.name }
    }
    if (ref.kind === 'Job') {
      const up = jobOwner.get(`${ns}/${ref.name}`)
      return up ? { kind: 'CronJob', name: up.name } : { kind: 'Job', name: ref.name }
    }
    return { kind: ref.kind, name: ref.name }
  }

  const pvcByNs = new Map<string, string[]>()
  for (const v of pvcs.items) {
    const ns = v.metadata.namespace ?? ''
    pvcByNs.set(ns, [...(pvcByNs.get(ns) ?? []), v.metadata.name])
  }

  const workloads: MapWorkload[] = []
  WORKLOAD_KINDS.forEach((k, i) => {
    for (const w of workloadLists[i]?.items ?? []) {
      // Job của CronJob nằm trong thẻ CronJob (qua pod) — không thành thẻ riêng.
      if (k.id === 'jobs.batch' && jobOwner.has(`${w.metadata.namespace ?? ''}/${w.metadata.name}`))
        continue
      const row = toRow(k.id, w)
      const st = o(w.status)
      const spec = o(w.spec)
      const desired =
        k.id === 'daemonsets.apps'
          ? num(st['desiredNumberScheduled'])
          : k.id === 'jobs.batch'
            ? num(spec['completions']) || 1
            : k.id === 'cronjobs.batch'
              ? 0
              : num(spec['replicas'] ?? 1)
      const ready =
        k.id === 'daemonsets.apps'
          ? num(st['numberReady'])
          : k.id === 'jobs.batch'
            ? num(st['succeeded'])
            : k.id === 'cronjobs.batch'
              ? a(st['active']).length
              : num(st['readyReplicas'])
      const status =
        k.id === 'cronjobs.batch'
          ? (row.cells['schedule'] ?? '')
          : k.id === 'jobs.batch'
            ? (row.cells['status'] ?? '')
            : `${ready}/${desired} ready`
      const labels = (o(templateOf(k.id, w)['metadata'])['labels'] ?? {}) as Record<string, string>
      const images = a(o(templateOf(k.id, w)['spec'])['containers']).map((c) => s(c['image']))
      const tech = detectTech(images, { ...(w.metadata.labels ?? {}), ...labels }, w.metadata.name)
      const meta = w.metadata.labels ?? {}
      const helm = meta['app.kubernetes.io/managed-by'] === 'Helm' || 'helm.sh/chart' in meta
      workloads.push({
        kind: k.id,
        ns: w.metadata.namespace ?? '',
        name: w.metadata.name,
        labels,
        ...(tech ? { tech } : {}),
        ...(helm ? { helm } : {}),
        ready,
        desired,
        status,
        tone: k.id === 'cronjobs.batch' ? row.tone : desired > 0 && ready === 0 ? 'bad' : row.tone,
        pvcs: claimNames(k.id, w, pvcByNs.get(w.metadata.namespace ?? '') ?? [])
      })
    }
  })

  const mapPods: MapPod[] = pods.items.map((p) => {
    const st = podStatus(p)
    const statuses = a(o(p.status)['containerStatuses'])
    const req = podRequests(p)
    return {
      ns: p.metadata.namespace ?? '',
      name: p.metadata.name,
      owner: topOwner(p),
      status: st.text,
      tone: st.tone,
      restarts: statuses.reduce((n, c) => n + num(c['restartCount']), 0),
      node: s(o(p.spec)['nodeName']),
      ...(req.cpu ? { cpu: req.cpu } : {}),
      ...(req.memory ? { memory: req.memory } : {})
    }
  })

  const mapServices: MapService[] = services.items.map((svc) => {
    const spec = o(svc.spec)
    return {
      ns: svc.metadata.namespace ?? '',
      name: svc.metadata.name,
      type: s(spec['type']) || 'ClusterIP',
      selector: (spec['selector'] ?? {}) as Record<string, string>,
      ports: a(spec['ports'])
        .map((p) => `${String(num(p['port']))}/${s(p['protocol']) || 'TCP'}`)
        .join(', ')
    }
  })

  const routes: MapRoute[] = [
    ...ingresses.items.map((i) => {
      const spec = o(i.spec)
      const backends = new Set<string>()
      const add = (b: unknown): void => {
        const n = s(o(o(b)['service'])['name'])
        if (n) backends.add(n)
      }
      add(spec['defaultBackend'])
      for (const r of a(spec['rules'])) for (const p of a(o(r['http'])['paths'])) add(p['backend'])
      return {
        kind: 'ingresses.networking.k8s.io',
        ns: i.metadata.namespace ?? '',
        name: i.metadata.name,
        hosts: a(spec['rules'])
          .map((r) => s(r['host']))
          .filter(Boolean),
        backends: [...backends]
      }
    }),
    ...[
      { list: httpRoutes, kind: 'httproutes.gateway.networking.k8s.io' },
      { list: grpcRoutes, kind: 'grpcroutes.gateway.networking.k8s.io' }
    ].flatMap(({ list, kind }) =>
      list.items.map((r) => {
        const spec = o(r.spec)
        const backends = new Set<string>()
        for (const rule of a(spec['rules']))
          for (const b of a(rule['backendRefs']))
            if ((s(b['kind']) || 'Service') === 'Service' && s(b['name']))
              backends.add(s(b['name']))
        const ns = r.metadata.namespace ?? ''
        return {
          kind,
          ns,
          name: r.metadata.name,
          hosts: (Array.isArray(spec['hostnames']) ? (spec['hostnames'] as unknown[]) : [])
            .map(s)
            .filter(Boolean),
          backends: [...backends],
          parents: a(spec['parentRefs'])
            .filter((p) => (s(p['kind']) || 'Gateway') === 'Gateway' && s(p['name']))
            .map((p) => ({ ns: s(p['namespace']) || ns, name: s(p['name']) }))
        }
      })
    )
  ]

  const mapPvcs: MapPvc[] = pvcs.items.map((v) => {
    const st = o(v.status)
    const phase = s(st['phase'])
    return {
      ns: v.metadata.namespace ?? '',
      name: v.metadata.name,
      status: phase,
      capacity: s(o(st['capacity'])['storage']),
      tone: phase === 'Bound' ? 'ok' : phase === 'Lost' ? 'bad' : 'warn'
    }
  })

  const mapHpas: MapHpa[] = hpas.items.map((h) => {
    const spec = o(h.spec)
    const ref = o(spec['scaleTargetRef'])
    return {
      ns: h.metadata.namespace ?? '',
      name: h.metadata.name,
      target: { kind: s(ref['kind']), name: s(ref['name']) },
      min: num(spec['minReplicas']) || 1,
      max: num(spec['maxReplicas']),
      current: num(o(h.status)['currentReplicas'])
    }
  })

  const mapPolicies: MapPolicy[] = policies.items.map((p) => ({
    ns: p.metadata.namespace ?? '',
    name: p.metadata.name,
    selector: o(p.spec)['podSelector'] ?? {}
  }))

  const mapGateways: MapGateway[] = gateways.items.map((g) => {
    const spec = o(g.spec)
    return {
      ns: g.metadata.namespace ?? '',
      name: g.metadata.name,
      className: s(spec['gatewayClassName']),
      listeners: a(spec['listeners'])
        .map((l) => `${s(l['protocol'])}:${String(num(l['port']))}`)
        .join(', ')
    }
  })

  const nodeList: MapNodeInfo[] = nodes.items.map((n) => {
    const st = o(n.status)
    const labels = n.metadata.labels ?? {}
    const alloc = o(st['allocatable'])
    const conds = a(st['conditions'])
    const used = usage.items[n.metadata.name]
    return {
      name: n.metadata.name,
      ready: conds.some((c) => c['type'] === 'Ready' && c['status'] === 'True'),
      unschedulable: o(n.spec)['unschedulable'] === true,
      roles: Object.keys(labels)
        .filter((k) => k.startsWith('node-role.kubernetes.io/'))
        .map((k) => k.slice('node-role.kubernetes.io/'.length))
        .filter(Boolean)
        .sort(),
      zone:
        labels['topology.kubernetes.io/zone'] ??
        labels['failure-domain.beta.kubernetes.io/zone'] ??
        '',
      instance:
        labels['node.kubernetes.io/instance-type'] ??
        labels['beta.kubernetes.io/instance-type'] ??
        '',
      kubelet: s(o(st['nodeInfo'])['kubeletVersion']),
      allocatable: {
        cpu: parseCpu(alloc['cpu']),
        memory: parseMemory(alloc['memory']),
        pods: Number(s(alloc['pods']) || num(alloc['pods'])) || 0
      },
      usage: usage.available && used ? used : null,
      taints: a(o(n.spec)['taints']).map((t) => ({
        key: s(t['key']),
        value: s(t['value']),
        effect: s(t['effect'])
      })),
      pressure: conds
        .filter((c) => c['type'] !== 'Ready' && c['status'] === 'True')
        .map((c) => s(c['type']))
    }
  })
  const nodeReady = nodeList.filter((n) => n.ready).length

  return {
    namespaces: nsList.items.map((n) => ({
      name: n.metadata.name,
      active: s(o(n.status)['phase']) !== 'Terminating',
      ...(n.metadata.labels ? { labels: n.metadata.labels } : {})
    })),
    workloads,
    pods: mapPods,
    services: mapServices,
    routes,
    pvcs: mapPvcs,
    hpas: mapHpas,
    policies: mapPolicies,
    gateways: mapGateways,
    nodes: { total: nodes.items.length, ready: nodeReady },
    nodeList,
    truncated: [pods, rs, services, ...workloadLists].some((l) => l.truncated)
  }
}
