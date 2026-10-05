import { detectTech, workloadKindLabel } from '../shared/map'
import type {
  MapContainerPort,
  MapData,
  MapGateway,
  MapRouteRule,
  MapHpa,
  MapNodeInfo,
  MapPod,
  MapPolicy,
  MapPvc,
  MapRoute,
  MapService,
  MapServicePort,
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
import { METADATA_ONLY, metrics } from './operations'
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
  /** Có namespace / loại không đọc được (403) — danh sách không đầy đủ. */
  denied?: boolean
  /** API không có (404) — vd. cluster cũ không có EndpointSlice. */
  missing?: boolean
}

/**
 * List có phân trang, theo từng namespace (hoặc cả cluster); lỗi quyền / 404 → rỗng. Tổng tối đa
 * MAX_PER_KIND (tính chung mọi namespace) — chạm mức mà còn dữ liệu (trang sau / namespace sau) →
 * truncated.
 */
async function listAll(
  client: KubeClient,
  api: string,
  plural: string,
  namespaces: readonly string[],
  signal?: AbortSignal,
  accept?: string
): Promise<Listed> {
  const scopes = namespaces.length ? namespaces : [undefined]
  const items: K8sObject[] = []
  let truncated = false
  let denied = false
  let missing = false
  for (const ns of scopes) {
    if (items.length >= MAX_PER_KIND) {
      // Còn namespace chưa đọc.
      truncated = true
      break
    }
    const path = `${api}${ns ? `/namespaces/${encodeURIComponent(ns)}` : ''}/${plural}`
    let cont: string | undefined
    try {
      do {
        // `items: null` khi rỗng (list chỉ metadata, một số proxy) → danh sách rỗng.
        const r = await client.json<{
          items: K8sObject[] | null
          metadata?: { continue?: string }
        }>('GET', path, {
          query: { limit: PAGE, continue: cont },
          ...(signal ? { signal } : {}),
          ...(accept ? { accept } : {})
        })
        for (const it of r.items ?? []) items.push(it)
        cont = r.metadata?.continue || undefined
        if (cont && items.length >= MAX_PER_KIND) truncated = true
      } while (cont && !truncated)
    } catch (error) {
      if (error instanceof KubeError && (error.status === 403 || error.status === 404)) {
        if (error.status === 403) denied = true
        else missing = true
        continue
      }
      throw error
    }
    if (truncated) break
  }
  return { items, truncated, ...(denied ? { denied } : {}), ...(missing ? { missing } : {}) }
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

/** ConfigMap / Secret / ServiceAccount / cổng container của pod template (như podRefs, gọn hơn). */
function templateRefs(tpl: Obj): {
  configMaps: string[]
  secrets: string[]
  serviceAccount: string
  ports: MapContainerPort[]
} {
  const spec = o(tpl['spec'])
  const cms = new Set<string>()
  const secrets = new Set<string>()
  const add = (set: Set<string>, v: unknown): void => {
    const name = s(v)
    if (name) set.add(name)
  }
  for (const v of a(spec['volumes'])) {
    add(cms, o(v['configMap'])['name'])
    add(secrets, o(v['secret'])['secretName'])
    for (const src of a(o(v['projected'])['sources'])) {
      add(cms, o(src['configMap'])['name'])
      add(secrets, o(src['secret'])['name'])
    }
  }
  const ports: MapContainerPort[] = []
  for (const c of [...a(spec['initContainers']), ...a(spec['containers'])]) {
    for (const e of a(c['env'])) {
      const from = o(e['valueFrom'])
      // optional: true → thiếu cũng chạy được, không tính là phụ thuộc bắt buộc.
      const cm = o(from['configMapKeyRef'])
      if (cm['optional'] !== true) add(cms, cm['name'])
      const sk = o(from['secretKeyRef'])
      if (sk['optional'] !== true) add(secrets, sk['name'])
    }
    for (const e of a(c['envFrom'])) {
      const cm = o(e['configMapRef'])
      if (cm['optional'] !== true) add(cms, cm['name'])
      const sr = o(e['secretRef'])
      if (sr['optional'] !== true) add(secrets, sr['name'])
    }
    for (const p of a(c['ports'])) {
      const port = num(p['containerPort'])
      if (!port) continue
      ports.push({
        port,
        ...(s(p['name']) ? { name: s(p['name']) } : {}),
        ...(s(p['protocol']) && s(p['protocol']) !== 'TCP' ? { protocol: s(p['protocol']) } : {})
      })
    }
  }
  for (const p of a(spec['imagePullSecrets'])) add(secrets, p['name'])
  return {
    configMaps: [...cms].sort(),
    secrets: [...secrets].sort(),
    serviceAccount: s(spec['serviceAccountName']) || s(spec['serviceAccount']) || 'default',
    ports
  }
}

/** Địa chỉ cấp cho LoadBalancer / Ingress / Gateway (IP hoặc hostname). */
function lbAddresses(status: Obj): string[] {
  return a(o(status['loadBalancer'])['ingress'])
    .map((x) => s(x['ip']) || s(x['hostname']))
    .filter(Boolean)
}

/**
 * Endpoint của mỗi Service theo EndpointSlice ("ns/service" → sẵn sàng / chưa). Một pod có thể nằm
 * trong nhiều slice (IPv4 + IPv6) — đếm theo pod (targetRef) hoặc địa chỉ đầu. `ready` không ghi
 * nghĩa là sẵn sàng (theo đặc tả EndpointSlice).
 */
function endpointCounts(
  slices: readonly K8sObject[]
): Map<string, { ready: number; notReady: number }> {
  const seen = new Map<string, Map<string, boolean>>()
  for (const sl of slices) {
    const svc = sl.metadata.labels?.['kubernetes.io/service-name']
    if (!svc) continue
    const key = `${sl.metadata.namespace ?? ''}/${svc}`
    const m = seen.get(key) ?? new Map<string, boolean>()
    seen.set(key, m)
    for (const e of a(o(sl)['endpoints'])) {
      const ref = o(e['targetRef'])
      const id =
        s(ref['uid']) ||
        s(ref['name']) ||
        (Array.isArray(e['addresses']) ? s((e['addresses'] as unknown[])[0]) : '')
      if (!id) continue
      const ready = o(e['conditions'])['ready'] !== false
      m.set(id, (m.get(id) ?? false) || ready)
    }
  }
  const out = new Map<string, { ready: number; notReady: number }>()
  for (const [key, m] of seen) {
    let ready = 0
    for (const r of m.values()) if (r) ready++
    out.set(key, { ready, notReady: m.size - ready })
  }
  return out
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

/** CPU / RAM đang dùng của pod (metrics-server); không có → rỗng. */
async function podMetrics(
  client: KubeClient,
  namespaces: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, { cpu: number; memory: number }>> {
  const scopes = namespaces.length ? namespaces : [undefined]
  const results = await Promise.all(
    scopes.map((ns) =>
      metrics(client, 'pods', ns, signal).catch((): MetricsResult => ({
        available: false,
        items: {}
      }))
    )
  )
  const out = new Map<string, { cpu: number; memory: number }>()
  for (const r of results) for (const [key, u] of Object.entries(r.items)) out.set(key, u)
  return out
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
    podUsage,
    slices,
    configMapList,
    secretList,
    ...workloadLists
  ] = await Promise.all([
    namespaces.length
      ? scopedNamespaces(client, namespaces, signal)
      : listAll(client, '/api/v1', 'namespaces', [], signal),
    listAll(client, '/api/v1', 'nodes', [], signal),
    listAll(client, '/api/v1', 'pods', namespaces, signal),
    // ReplicaSet chỉ cần ownerReferences → chỉ metadata (bỏ pod template của mọi bản cũ).
    listAll(client, '/apis/apps/v1', 'replicasets', namespaces, signal, METADATA_ONLY),
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
    podMetrics(client, namespaces, signal),
    listAll(client, '/apis/discovery.k8s.io/v1', 'endpointslices', namespaces, signal).catch(
      (): Listed => ({ items: [], truncated: false, denied: true })
    ),
    // Chỉ tên (metadata) — để biết ConfigMap / Secret được tham chiếu có tồn tại không.
    listAll(client, '/api/v1', 'configmaps', namespaces, signal, METADATA_ONLY).catch(
      (): Listed => ({ items: [], truncated: false, denied: true })
    ),
    listAll(client, '/api/v1', 'secrets', namespaces, signal, METADATA_ONLY).catch((): Listed => ({
      items: [],
      truncated: false,
      denied: true
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
    const list = pvcByNs.get(ns)
    if (list) list.push(v.metadata.name)
    else pvcByNs.set(ns, [v.metadata.name])
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
      const tpl = templateOf(k.id, w)
      const labels = (o(tpl['metadata'])['labels'] ?? {}) as Record<string, string>
      const images = a(o(tpl['spec'])['containers']).map((c) => s(c['image']))
      const refs = templateRefs(tpl)
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
        pvcs: claimNames(k.id, w, pvcByNs.get(w.metadata.namespace ?? '') ?? []),
        ...(refs.ports.length ? { ports: refs.ports } : {}),
        ...(refs.configMaps.length ? { configMaps: refs.configMaps } : {}),
        ...(refs.secrets.length ? { secrets: refs.secrets } : {}),
        serviceAccount: refs.serviceAccount,
        ...(k.id === 'jobs.batch' &&
        num(st['failed']) > 0 &&
        !num(st['active']) &&
        !num(st['succeeded'])
          ? { failed: true }
          : {})
      })
    }
  })

  // Workload có thẻ trên bản đồ — pod của owner khác (ReplicaSet lẻ, controller lạ) giữ nhãn.
  const workloadKeys = new Set(
    workloads.map((w) => `${w.ns}|${workloadKindLabel(w.kind)}|${w.name}`)
  )
  const mapPods: MapPod[] = pods.items.map((p) => {
    const st = podStatus(p)
    const statuses = a(o(p.status)['containerStatuses'])
    const owner = topOwner(p)
    const ns = p.metadata.namespace ?? ''
    const orphan = !owner || !workloadKeys.has(`${ns}|${owner.kind}|${owner.name}`)
    const notReady =
      st.text === 'Running' && statuses.length > 0 && statuses.some((c) => c['ready'] !== true)
    const req = podRequests(p)
    const status = o(p.status)
    const started = Date.parse(s(status['startTime']))
    const used = podUsage.get(`${p.metadata.namespace ?? ''}/${p.metadata.name}`)
    return {
      ns,
      name: p.metadata.name,
      owner,
      status: st.text,
      tone: notReady ? 'warn' : st.tone,
      restarts: statuses.reduce((n, c) => n + num(c['restartCount']), 0),
      node: s(o(p.spec)['nodeName']),
      ...(req.cpu ? { cpu: req.cpu } : {}),
      ...(req.memory ? { memory: req.memory } : {}),
      ...(s(status['podIP']) ? { ip: s(status['podIP']) } : {}),
      ...(Number.isFinite(started) ? { startedAt: started } : {}),
      ...(used ? { usage: used } : {}),
      ...(notReady ? { notReady } : {}),
      ...(orphan && p.metadata.labels ? { labels: p.metadata.labels } : {})
    }
  })

  const endpoints =
    slices.denied || slices.missing || slices.truncated ? null : endpointCounts(slices.items)
  const mapServices: MapService[] = services.items.map((svc) => {
    const spec = o(svc.spec)
    const ns = svc.metadata.namespace ?? ''
    const type = s(spec['type']) || 'ClusterIP'
    const portList: MapServicePort[] = a(spec['ports']).map((p) => {
      const target = p['targetPort']
      return {
        port: num(p['port']),
        targetPort:
          typeof target === 'number' || typeof target === 'string'
            ? String(target)
            : String(num(p['port'])),
        ...(s(p['name']) ? { name: s(p['name']) } : {}),
        ...(s(p['protocol']) && s(p['protocol']) !== 'TCP' ? { protocol: s(p['protocol']) } : {}),
        ...(num(p['nodePort']) ? { nodePort: num(p['nodePort']) } : {})
      }
    })
    const external = [
      ...lbAddresses(o(svc.status)),
      ...(Array.isArray(spec['externalIPs']) ? (spec['externalIPs'] as unknown[]).map(s) : [])
    ].filter(Boolean)
    const selector = (spec['selector'] ?? {}) as Record<string, string>
    // Service không có selector: endpoint do người khác quản lý — vẫn đếm nếu có slice.
    const ep = endpoints?.get(`${ns}/${svc.metadata.name}`)
    return {
      ns,
      name: svc.metadata.name,
      type,
      selector,
      ports: a(spec['ports'])
        .map((p) => `${String(num(p['port']))}/${s(p['protocol']) || 'TCP'}`)
        .join(', '),
      ...(portList.length ? { portList } : {}),
      ...(s(spec['clusterIP']) ? { clusterIP: s(spec['clusterIP']) } : {}),
      ...(s(spec['externalName']) ? { externalName: s(spec['externalName']) } : {}),
      ...(external.length ? { external } : {}),
      ...(endpoints && type !== 'ExternalName'
        ? { endpoints: ep ?? { ready: 0, notReady: 0 } }
        : {})
    }
  })

  const routes: MapRoute[] = [
    ...ingresses.items.map((i) => {
      const spec = o(i.spec)
      const backends = new Set<string>()
      // Service → các path dẫn tới nó ("host/path") — nhãn trên đường nối của bản đồ.
      const paths: Record<string, string[]> = {}
      const rules: MapRouteRule[] = []
      const add = (b: unknown, where: string, rule: Omit<MapRouteRule, 'service'>): void => {
        const svc = o(o(b)['service'])
        const n = s(svc['name'])
        if (!n) return
        backends.add(n)
        ;(paths[n] ??= []).push(where)
        const port = o(svc['port'])
        const pv = num(port['number']) ? String(num(port['number'])) : s(port['name'])
        rules.push({ ...rule, service: n, ...(pv ? { port: pv } : {}) })
      }
      add(spec['defaultBackend'], '(default)', { host: '', path: '', default: true })
      for (const r of a(spec['rules']))
        for (const p of a(o(r['http'])['paths']))
          add(p['backend'], `${s(r['host'])}${s(p['path']) || '/'}`, {
            host: s(r['host']),
            path: s(p['path']) || '/'
          })
      const tls = a(spec['tls'])
        .map((t) => ({
          hosts: (Array.isArray(t['hosts']) ? (t['hosts'] as unknown[]) : [])
            .map(s)
            .filter(Boolean),
          secret: s(t['secretName'])
        }))
        .filter((t) => t.secret || t.hosts.length)
      const className =
        s(spec['ingressClassName']) ||
        (i.metadata.annotations?.['kubernetes.io/ingress.class'] ?? '')
      const address = lbAddresses(o(i.status))
      return {
        kind: 'ingresses.networking.k8s.io',
        ns: i.metadata.namespace ?? '',
        name: i.metadata.name,
        hosts: a(spec['rules'])
          .map((r) => s(r['host']))
          .filter(Boolean),
        backends: [...backends],
        paths,
        ...(rules.length ? { rules } : {}),
        ...(tls.length ? { tls } : {}),
        ...(className ? { className } : {}),
        ...(address.length ? { address } : {})
      }
    }),
    ...[
      { list: httpRoutes, kind: 'httproutes.gateway.networking.k8s.io' },
      { list: grpcRoutes, kind: 'grpcroutes.gateway.networking.k8s.io' }
    ].flatMap(({ list, kind }) =>
      list.items.map((r) => {
        const spec = o(r.spec)
        const backends = new Set<string>()
        const hostnames = (Array.isArray(spec['hostnames']) ? (spec['hostnames'] as unknown[]) : [])
          .map(s)
          .filter(Boolean)
        const rules: MapRouteRule[] = []
        for (const rule of a(spec['rules'])) {
          const matches = a(rule['matches'])
          // HTTPRoute: path; GRPCRoute: service/method.
          const paths = matches
            .map((m) => {
              const path = s(o(m['path'])['value'])
              const method = o(m['method'])
              return (
                path || [s(method['service']), s(method['method'])].filter(Boolean).join('/') || ''
              )
            })
            .filter(Boolean)
          for (const b of a(rule['backendRefs']))
            if ((s(b['kind']) || 'Service') === 'Service' && s(b['name'])) {
              backends.add(s(b['name']))
              for (const path of paths.length ? paths : ['/'])
                rules.push({
                  host: hostnames[0] ?? '',
                  path,
                  service: s(b['name']),
                  ...(num(b['port']) ? { port: String(num(b['port'])) } : {})
                })
            }
        }
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
            .map((p) => ({ ns: s(p['namespace']) || ns, name: s(p['name']) })),
          ...(rules.length ? { rules } : {})
        }
      })
    )
  ]

  const mapPvcs: MapPvc[] = pvcs.items.map((v) => {
    const st = o(v.status)
    const phase = s(st['phase'])
    const spec = o(v.spec)
    return {
      ns: v.metadata.namespace ?? '',
      name: v.metadata.name,
      status: phase,
      capacity: s(o(st['capacity'])['storage']),
      tone: phase === 'Bound' ? 'ok' : phase === 'Lost' ? 'bad' : 'warn',
      ...(s(spec['storageClassName']) ? { storageClass: s(spec['storageClassName']) } : {}),
      ...(s(spec['volumeName']) ? { volume: s(spec['volumeName']) } : {})
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

  const mapPolicies: MapPolicy[] = policies.items.map((p) => {
    const spec = o(p.spec)
    const ingress = a(spec['ingress']).length
    const egress = a(spec['egress']).length
    // Không ghi policyTypes: luôn có Ingress, có Egress nếu có luật egress.
    const types = Array.isArray(spec['policyTypes'])
      ? (spec['policyTypes'] as unknown[]).map(s).filter(Boolean)
      : ['Ingress', ...(egress ? ['Egress'] : [])]
    return {
      ns: p.metadata.namespace ?? '',
      name: p.metadata.name,
      selector: spec['podSelector'] ?? {},
      types,
      ingressRules: ingress,
      egressRules: egress
    }
  })

  const mapGateways: MapGateway[] = gateways.items.map((g) => {
    const spec = o(g.spec)
    return {
      ns: g.metadata.namespace ?? '',
      name: g.metadata.name,
      className: s(spec['gatewayClassName']),
      listeners: a(spec['listeners'])
        .map((l) => `${s(l['protocol'])}:${String(num(l['port']))}`)
        .join(', '),
      ...(() => {
        const addresses = a(o(g.status)['addresses'])
          .map((x) => s(x['value']))
          .filter(Boolean)
        return addresses.length ? { addresses } : {}
      })()
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

  // Chỉ giữ tên được tham chiếu (workload, Ingress TLS) — gọn, đủ để báo "thiếu".
  const wantCm = new Set<string>()
  const wantSecret = new Set<string>()
  for (const w of workloads) {
    for (const c of w.configMaps ?? []) wantCm.add(`${w.ns}/${c}`)
    for (const c of w.secrets ?? []) wantSecret.add(`${w.ns}/${c}`)
  }
  for (const r of routes)
    for (const t of r.tls ?? []) if (t.secret) wantSecret.add(`${r.ns}/${t.secret}`)
  const existing = (list: Listed, want: Set<string>): string[] | undefined =>
    list.denied || list.missing || list.truncated
      ? undefined
      : list.items
          .map((x) => `${x.metadata.namespace ?? ''}/${x.metadata.name}`)
          .filter((k) => want.has(k))
          .sort()
  const configMaps = existing(configMapList, wantCm)
  const secrets = existing(secretList, wantSecret)

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
    truncated: [pods, rs, services, ...workloadLists].some((l) => l.truncated),
    ...(configMaps ? { configMaps } : {}),
    ...(secrets ? { secrets } : {})
  }
}
