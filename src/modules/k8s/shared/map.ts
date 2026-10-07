/**
 * Dữ liệu bản đồ cluster (Map): dữ liệu gọn từ Session Host, gom namespace theo mục đích / tiền tố
 * / nhãn, lọc theo nhãn, nhận diện công nghệ, khớp selector. Thuần — Session Host, renderer và test
 * dùng chung (bố cục Topology ở appTopology.ts).
 */
import { t } from '@shared/i18n'

export type MapTone = 'ok' | 'warn' | 'bad' | 'muted'

export interface MapWorkload {
  /** Id loại: deployments.apps, statefulsets.apps, daemonsets.apps, jobs.batch, cronjobs.batch. */
  kind: string
  ns: string
  name: string
  /** Nhãn của pod template (để khớp selector của service / policy). */
  labels: Record<string, string>
  ready: number
  desired: number
  status: string
  tone: MapTone
  /** PVC mà pod template dùng (kể cả volumeClaimTemplates của StatefulSet đã tạo). */
  pvcs: string[]
  /** Công nghệ nhận ra (prometheus, grafana, argocd…) — xem TECH. */
  tech?: string
  /** Cài bằng Helm (nhãn managed-by / helm.sh/chart). */
  helm?: boolean
  /** Cổng container khai báo trong pod template (để kiểm targetPort của Service). */
  ports?: MapContainerPort[]
  /** ConfigMap / Secret mà pod template dùng (volume, env, envFrom; Secret gồm cả imagePullSecrets). */
  configMaps?: string[]
  secrets?: string[]
  /** ServiceAccount của pod (mặc định "default"). */
  serviceAccount?: string
  /** Job đã thất bại (status.failed > 0 và không còn chạy). */
  failed?: boolean
}

export interface MapContainerPort {
  name?: string
  port: number
  protocol?: string
}

export interface MapPod {
  ns: string
  name: string
  /** Workload gốc (pod → ReplicaSet → Deployment, Job → CronJob); null = pod đứng riêng. */
  owner: { kind: string; name: string } | null
  status: string
  tone: MapTone
  restarts: number
  node: string
  /** Tổng requests của container (millicore / byte) — bỏ khi 0. */
  cpu?: number
  memory?: number
  /** status.podIP. */
  ip?: string
  /** status.startTime (Unix ms). */
  startedAt?: number
  /** Đang dùng thật (metrics-server). */
  usage?: { cpu: number; memory: number }
  /** Đang chạy nhưng có container chưa Ready (readiness probe hỏng) — không nhận traffic. */
  notReady?: boolean
  /**
   * Nhãn pod — chỉ có với pod không thuộc workload nào trên bản đồ (pod lẻ, ReplicaSet không có
   * Deployment…) để khớp selector của Service; pod của workload dùng nhãn pod template.
   */
  labels?: Record<string, string>
}

/** Node (máy) của cluster — cho chế độ xem theo node. */
export interface MapNodeInfo {
  name: string
  ready: boolean
  /** Đã cordon (spec.unschedulable). */
  unschedulable: boolean
  /** node-role.kubernetes.io/<role>. */
  roles: string[]
  /** topology.kubernetes.io/zone (hoặc nhãn cũ failure-domain). */
  zone: string
  /** node.kubernetes.io/instance-type. */
  instance: string
  kubelet: string
  /** Allocatable: CPU millicore, RAM byte, số pod tối đa. */
  allocatable: { cpu: number; memory: number; pods: number }
  /** Đang dùng thật (metrics-server); cluster không có → null. */
  usage: { cpu: number; memory: number } | null
  taints: { key: string; value: string; effect: string }[]
  /** Điều kiện xấu đang bật: MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable. */
  pressure: string[]
}

export interface MapService {
  ns: string
  name: string
  type: string
  selector: Record<string, string>
  ports: string
  /** Chi tiết từng cổng (port → targetPort, nodePort). */
  portList?: MapServicePort[]
  /** "None" = headless. */
  clusterIP?: string
  /** type ExternalName: tên DNS bên ngoài. */
  externalName?: string
  /** Địa chỉ ra ngoài: status.loadBalancer.ingress (IP / hostname) + spec.externalIPs. */
  external?: string[]
  /** Endpoint theo EndpointSlice (không đọc được → không có — không kết luận "0 endpoint"). */
  endpoints?: { ready: number; notReady: number }
}

export interface MapServicePort {
  name?: string
  port: number
  /** Số hoặc tên cổng container ("http"); không khai báo → bằng port. */
  targetPort: string
  protocol?: string
  nodePort?: number
}

export interface MapRoute {
  /** ingresses.networking.k8s.io | httproutes.gateway.networking.k8s.io | grpcroutes… */
  kind: string
  ns: string
  name: string
  hosts: string[]
  /** Tên service phía sau (cùng namespace). */
  backends: string[]
  /** Ingress: service → các "host/path" dẫn tới nó (nhãn trên đường nối). */
  paths?: Record<string, string[]>
  /** Gateway API: Gateway cha (parentRefs). */
  parents?: { ns: string; name: string }[]
  /** Từng luật host + path → service:port (Ingress: cả defaultBackend với host / path rỗng). */
  rules?: MapRouteRule[]
  /** Ingress: TLS — host và Secret chứa chứng chỉ. */
  tls?: { hosts: string[]; secret: string }[]
  /** Ingress: ingressClassName (hoặc annotation kubernetes.io/ingress.class cũ). */
  className?: string
  /** Địa chỉ đã cấp (status.loadBalancer.ingress). */
  address?: string[]
}

export interface MapRouteRule {
  host: string
  path: string
  service: string
  /** Cổng của Service (số hoặc tên) — không ghi thì rỗng. */
  port?: string
  /** defaultBackend của Ingress. */
  default?: boolean
}

export interface MapGateway {
  ns: string
  name: string
  className: string
  /** "HTTPS:443, HTTP:80". */
  listeners: string
  /** status.addresses. */
  addresses?: string[]
}

export interface MapPvc {
  ns: string
  name: string
  status: string
  capacity: string
  tone: MapTone
  storageClass?: string
  /** PersistentVolume đã gắn (spec.volumeName). */
  volume?: string
}

export interface MapHpa {
  ns: string
  name: string
  target: { kind: string; name: string }
  min: number
  max: number
  current: number
}

export interface MapPolicy {
  ns: string
  name: string
  /** LabelSelector của NetworkPolicy (podSelector) — rỗng = mọi pod trong namespace. */
  selector: unknown
  /** policyTypes (mặc định Ingress, thêm Egress khi có luật egress). */
  types?: string[]
  /** Số luật ingress / egress (0 luật + có loại tương ứng = chặn hết chiều đó). */
  ingressRules?: number
  egressRules?: number
}

export interface MapPdb {
  ns: string
  name: string
  /** LabelSelector của PodDisruptionBudget. */
  selector: unknown
  /** status.disruptionsAllowed — 0 = không pod nào được evict (drain node bị chặn). */
  allowed: number
  /** status.expectedPods — số pod PDB đang canh. */
  expected: number
  /** "minAvailable 2" / "maxUnavailable 0" (để giải thích). */
  rule: string
}

export interface MapData {
  /** labels: nhãn của namespace (chỉ có khi list được namespace — xem cả cluster). */
  namespaces: { name: string; active: boolean; labels?: Record<string, string> }[]
  workloads: MapWorkload[]
  pods: MapPod[]
  services: MapService[]
  routes: MapRoute[]
  pvcs: MapPvc[]
  hpas: MapHpa[]
  policies: MapPolicy[]
  /** Gateway API (không có CRD → rỗng / thiếu). */
  gateways?: MapGateway[]
  nodes: { total: number; ready: number }
  /** Chi tiết từng node (thiếu ở dữ liệu cũ / không có quyền list node). */
  nodeList?: MapNodeInfo[]
  /** Cluster quá lớn — một số loại chỉ lấy phần đầu. */
  truncated: boolean
  /**
   * ConfigMap / Secret có thật trong số được workload / Ingress TLS tham chiếu ("ns/name"). Không
   * list được (thiếu quyền) → không có trường — không kết luận "thiếu".
   */
  configMaps?: string[]
  secrets?: string[]
  /** IngressClass có thật (không list được → không có trường — không kết luận "thiếu"). */
  ingressClasses?: { name: string; default: boolean }[]
  /** PodDisruptionBudget (không có quyền → không có trường). */
  pdbs?: MapPdb[]
  /** Hạn chứng chỉ của Secret TLS mà Ingress dùng ("ns/name" → ISO notAfter). Không đọc được → thiếu. */
  tlsExpiry?: Record<string, string>
}

// ——— Vùng theo mục đích ———

export type MapRegion =
  'Applications' | 'Ingress & networking' | 'Platform' | 'Monitoring' | 'System'

export const REGIONS: readonly MapRegion[] = [
  'Applications',
  'Ingress & networking',
  'Platform',
  'Monitoring',
  'System'
]

/** Namespace → vùng (đoán theo tên quen thuộc; còn lại là ứng dụng của bạn). */
export function regionOf(ns: string): MapRegion {
  const n = ns.toLowerCase()
  if (
    /^kube-|^kube$|-system$|^calico|^tigera|^openshift|^gatekeeper/.test(n) &&
    !/^cattle|^fleet/.test(n)
  )
    return 'System'
  if (
    /ingress|nginx|traefik|istio|gateway|kong|envoy|contour|haproxy|linkerd|cilium|metallb/.test(n)
  )
    return 'Ingress & networking'
  if (
    /monitor|prometheus|grafana|loki|tempo|jaeger|logging|elastic|kibana|opentelemetry|otel|datadog|newrelic|victoria|thanos|alert/.test(
      n
    )
  )
    return 'Monitoring'
  if (
    /^cattle|^fleet|^rancher|argo|flux|cert-manager|vault|operator|longhorn|local-path|velero|external-secrets|external-dns|keda|kyverno|crossplane|harbor|minio/.test(
      n
    )
  )
    return 'Platform'
  return 'Applications'
}

// ——— Gom vùng tuỳ chọn (cluster lớn: namespace đặt theo team / dự án) ———

/**
 * Cách gom namespace thành vùng: `purpose` — đoán theo tên quen thuộc (mặc định); `prefix` — theo
 * phần đầu tên (payment-core, payment-api → "payment"); `label:<key>` — theo một nhãn (nhãn của
 * namespace, không có thì nhãn phổ biến nhất của workload bên trong, vd. app.kubernetes.io/part-of).
 */
export type MapGrouping = 'purpose' | 'prefix' | `label:${string}`

/** Vùng của namespace không có nhãn / tiền tố riêng. */
export const OTHER_GROUP = 'Other'

/** Nhãn hệ thống trên namespace — không có ý nghĩa để gom. */
const NOISE_KEY =
  /^kubernetes\.io\/|^pod-security\.kubernetes\.io\/|^field\.cattle\.io\/|^objectset\.rio\.cattle\.io\/|^kustomize\.toolkit\.fluxcd\.io\/|^argocd\.argoproj\.io\/instance$/

/** Nhãn workload hay dùng để chia theo hệ thống / team. */
const WORKLOAD_GROUP_KEYS = ['app.kubernetes.io/part-of', 'team', 'owner', 'project', 'tier']

/** Namespace → tên vùng theo cách gom; namespace hệ thống không có nhãn → "System". */
export function groupNamespaces(data: MapData, grouping: MapGrouping): Map<string, string> {
  const names = [
    ...new Set([
      ...data.namespaces.map((n) => n.name),
      ...data.workloads.map((w) => w.ns),
      ...data.pods.map((p) => p.ns),
      ...data.services.map((s) => s.ns)
    ])
  ]
  const out = new Map<string, string>()
  if (grouping === 'purpose') {
    for (const ns of names) out.set(ns, regionOf(ns))
    return out
  }
  if (grouping === 'prefix') {
    const prefixOf = (ns: string): string => ns.split(/[-_.]/)[0] ?? ns
    const count = new Map<string, number>()
    for (const ns of names)
      if (regionOf(ns) !== 'System') count.set(prefixOf(ns), (count.get(prefixOf(ns)) ?? 0) + 1)
    for (const ns of names) {
      const p = prefixOf(ns)
      out.set(ns, regionOf(ns) === 'System' ? 'System' : (count.get(p) ?? 0) >= 2 ? p : OTHER_GROUP)
    }
    return out
  }
  const key = grouping.slice('label:'.length)
  const nsLabels = new Map(data.namespaces.map((n) => [n.name, n.labels ?? {}]))
  // Không có nhãn trên namespace → giá trị nhiều workload dùng nhất (hoà → theo tên).
  const votes = new Map<string, Map<string, number>>()
  for (const w of data.workloads) {
    const v = w.labels[key]
    if (!v) continue
    const m = votes.get(w.ns) ?? new Map<string, number>()
    m.set(v, (m.get(v) ?? 0) + 1)
    votes.set(w.ns, m)
  }
  for (const ns of names) {
    const own = nsLabels.get(ns)?.[key]
    const voted = [...(votes.get(ns) ?? new Map<string, number>()).entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0]?.[0]
    out.set(ns, own || voted || (regionOf(ns) === 'System' ? 'System' : OTHER_GROUP))
  }
  return out
}

/** Thứ tự vùng: theo mục đích thì cố định; còn lại theo tên, "Other" và "System" cuối. */
export function groupOrder(groups: Iterable<string>, grouping: MapGrouping): string[] {
  const set = new Set(groups)
  if (grouping === 'purpose') return REGIONS.filter((r) => set.has(r))
  const tail = (g: string): number => (g === 'System' ? 2 : g === OTHER_GROUP ? 1 : 0)
  return [...set].sort((a, b) => tail(a) - tail(b) || a.localeCompare(b))
}

/**
 * Nhãn gợi ý để gom: nhãn có trên ≥ 2 namespace (bỏ nhãn hệ thống), rồi các nhãn workload quen
 * (part-of, team…) nếu có workload dùng. Nhiều namespace dùng nhất trước.
 */
export function groupingKeys(data: MapData): string[] {
  const count = new Map<string, number>()
  for (const n of data.namespaces)
    for (const k of Object.keys(n.labels ?? {}))
      if (!NOISE_KEY.test(k)) count.set(k, (count.get(k) ?? 0) + 1)
  const fromNs = [...count.entries()]
    // Đang xem một namespace thì nhãn của nó cũng là gợi ý.
    .filter(([, c]) => c >= Math.min(2, data.namespaces.length))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k)
  const fromWorkloads = WORKLOAD_GROUP_KEYS.filter(
    (k) => !fromNs.includes(k) && data.workloads.some((w) => k in w.labels)
  )
  return [...fromNs, ...fromWorkloads].slice(0, 12)
}

// ——— Lọc theo nhãn (label selector kiểu kubectl) ———

export interface ParsedSelector {
  matchLabels: Record<string, string>
  matchExpressions: {
    key: string
    operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'
    values: string[]
  }[]
}

const KEY = String.raw`[A-Za-z0-9][-A-Za-z0-9_./]*`
const VALUE = String.raw`[-A-Za-z0-9_.]*`

/**
 * "tier=backend,app.kubernetes.io/part-of!=shop,env in (prod,staging),!canary" → selector; chuỗi
 * rỗng → null; sai cú pháp → { error }.
 */
export function parseLabelSelector(text: string): ParsedSelector | null | { error: string } {
  const src = text.trim()
  if (!src) return null
  // Tách theo dấu phẩy ngoài ngoặc.
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of src) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const out: ParsedSelector = { matchLabels: {}, matchExpressions: [] }
  for (const raw of parts) {
    const part = raw.trim()
    if (!part) continue
    let m: RegExpExecArray | null
    if ((m = new RegExp(`^(${KEY})\\s*(==|=)\\s*(${VALUE})$`).exec(part)))
      out.matchLabels[m[1] ?? ''] = m[3] ?? ''
    else if ((m = new RegExp(`^(${KEY})\\s*!=\\s*(${VALUE})$`).exec(part)))
      out.matchExpressions.push({ key: m[1] ?? '', operator: 'NotIn', values: [m[2] ?? ''] })
    else if ((m = new RegExp(`^(${KEY})\\s+(in|notin)\\s*\\(([^)]*)\\)$`, 'i').exec(part)))
      out.matchExpressions.push({
        key: m[1] ?? '',
        operator: (m[2] ?? '').toLowerCase() === 'in' ? 'In' : 'NotIn',
        values: (m[3] ?? '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      })
    else if ((m = new RegExp(`^!\\s*(${KEY})$`).exec(part)))
      out.matchExpressions.push({ key: m[1] ?? '', operator: 'DoesNotExist', values: [] })
    else if ((m = new RegExp(`^(${KEY})$`).exec(part)))
      out.matchExpressions.push({ key: m[1] ?? '', operator: 'Exists', values: [] })
    else
      return {
        error: t('Can’t read “{part}” — use key=value, key!=value, key in (a,b), key or !key', {
          part
        })
      }
  }
  return out
}

/**
 * Chỉ giữ workload khớp selector (nhãn pod template) cùng những gì nối tới chúng: pod, service
 * chọn chúng, route tới các service đó, gateway của route, PVC chúng dùng, policy áp lên chúng.
 * Namespace không còn gì → bỏ.
 */
export function filterMapData(data: MapData, selector: ParsedSelector): MapData {
  const keep = data.workloads.filter((w) => selectorMatches(selector, w.labels, true))
  const wKey = new Set(keep.map((w) => `${w.ns}|${KIND_LABEL[w.kind] ?? ''}|${w.name}`))
  const pods = data.pods.filter(
    (p) => p.owner && wKey.has(`${p.ns}|${p.owner.kind}|${p.owner.name}`)
  )
  const keepByNs = groupBy(keep, (w) => w.ns)
  const indexOf = new Map<string, LabelIndex<MapWorkload>>()
  const index = (ns: string): LabelIndex<MapWorkload> => {
    let ix = indexOf.get(ns)
    if (!ix) {
      ix = new LabelIndex(keepByNs.get(ns) ?? [])
      indexOf.set(ns, ix)
    }
    return ix
  }
  const services = data.services.filter(
    (s) => keepByNs.has(s.ns) && index(s.ns).match(s.selector).length > 0
  )
  const svcKey = new Set(services.map((s) => `${s.ns}/${s.name}`))
  const routes = data.routes.filter((r) => r.backends.some((b) => svcKey.has(`${r.ns}/${b}`)))
  const gwKey = new Set(routes.flatMap((r) => (r.parents ?? []).map((p) => `${p.ns}/${p.name}`)))
  const pvcKey = new Set(keep.flatMap((w) => w.pvcs.map((v) => `${w.ns}/${v}`)))
  const nsUsed = new Set([...keep.map((w) => w.ns), ...routes.map((r) => r.ns)])
  for (const g of gwKey) nsUsed.add(g.split('/')[0] ?? '')
  return {
    ...data,
    namespaces: data.namespaces.filter((n) => nsUsed.has(n.name)),
    workloads: keep,
    pods,
    services,
    routes,
    pvcs: data.pvcs.filter((v) => pvcKey.has(`${v.ns}/${v.name}`)),
    hpas: data.hpas.filter((h) => wKey.has(`${h.ns}|${h.target.kind}|${h.target.name}`)),
    policies: data.policies.filter(
      (p) => keepByNs.has(p.ns) && index(p.ns).match(p.selector, true).length > 0
    ),
    gateways: (data.gateways ?? []).filter((g) => gwKey.has(`${g.ns}/${g.name}`))
  }
}

// ——— Công nghệ (icon) ———

export interface TechInfo {
  label: string
  /** 1–2 ký tự vẽ trong huy hiệu. */
  short: string
  color: string
}

/** Thứ tự quan trọng: cụ thể trước chung (alertmanager trước prometheus, loki trước grafana…). */
const TECH_RULES: readonly (readonly [string, RegExp, TechInfo])[] = [
  ['alertmanager', /alertmanager/, { label: 'Alertmanager', short: 'Am', color: '#e6522c' }],
  ['node-exporter', /node-exporter/, { label: 'Node exporter', short: 'Ne', color: '#e6522c' }],
  [
    'kube-state-metrics',
    /kube-state-metrics/,
    { label: 'kube-state-metrics', short: 'Ks', color: '#326ce5' }
  ],
  ['prometheus', /prometheus/, { label: 'Prometheus', short: 'Pr', color: '#e6522c' }],
  ['loki', /\bloki\b/, { label: 'Loki', short: 'Lk', color: '#f2cc0c' }],
  [
    'promtail',
    /promtail|grafana-agent|\balloy\b/,
    { label: 'Grafana Agent', short: 'Ga', color: '#f46800' }
  ],
  ['tempo', /\btempo\b/, { label: 'Tempo', short: 'Tp', color: '#f46800' }],
  ['grafana', /grafana/, { label: 'Grafana', short: 'Gf', color: '#f46800' }],
  ['jaeger', /jaeger/, { label: 'Jaeger', short: 'Jg', color: '#60d0e4' }],
  [
    'otel',
    /opentelemetry|otel-collector|otelcol/,
    { label: 'OpenTelemetry', short: 'Ot', color: '#425cc7' }
  ],
  ['fluent', /fluent-?bit|fluentd/, { label: 'Fluent', short: 'Fl', color: '#0e83c8' }],
  ['elasticsearch', /elasticsearch/, { label: 'Elasticsearch', short: 'Es', color: '#00bfb3' }],
  [
    'opensearch',
    /opensearch(?!-dashboards)/,
    { label: 'OpenSearch', short: 'Os', color: '#005eb8' }
  ],
  ['kibana', /kibana|opensearch-dashboards/, { label: 'Kibana', short: 'Kb', color: '#e8478b' }],
  ['argocd', /argocd|argo-cd/, { label: 'Argo CD', short: 'Ar', color: '#ef7b4d' }],
  [
    'argo',
    /argoproj|workflow-controller|argo-rollouts/,
    { label: 'Argo', short: 'Ar', color: '#ef7b4d' }
  ],
  [
    'flux',
    /fluxcd|source-controller|kustomize-controller|helm-controller/,
    { label: 'Flux', short: 'Fx', color: '#5468ff' }
  ],
  ['coredns', /coredns|kube-dns/, { label: 'CoreDNS', short: 'Dn', color: '#2b7ccd' }],
  [
    'ingress-nginx',
    /ingress-nginx|nginx-ingress/,
    { label: 'NGINX Ingress', short: 'Ng', color: '#009639' }
  ],
  ['traefik', /traefik/, { label: 'Traefik', short: 'Tr', color: '#24a1c1' }],
  ['istio', /istio|pilot-discovery|proxyv2/, { label: 'Istio', short: 'Is', color: '#466bb0' }],
  ['linkerd', /linkerd/, { label: 'Linkerd', short: 'Ld', color: '#2beda7' }],
  ['envoy', /envoy|contour/, { label: 'Envoy', short: 'Ev', color: '#ac6199' }],
  ['haproxy', /haproxy/, { label: 'HAProxy', short: 'Ha', color: '#106da9' }],
  ['cilium', /cilium/, { label: 'Cilium', short: 'Ci', color: '#8061a9' }],
  ['calico', /calico|tigera/, { label: 'Calico', short: 'Ca', color: '#fb8c00' }],
  ['kube-proxy', /kube-proxy/, { label: 'kube-proxy', short: 'Kp', color: '#326ce5' }],
  ['metrics-server', /metrics-server/, { label: 'metrics-server', short: 'Ms', color: '#326ce5' }],
  ['etcd', /\betcd\b/, { label: 'etcd', short: 'Et', color: '#419eda' }],
  ['cert-manager', /cert-manager/, { label: 'cert-manager', short: 'Cm', color: '#326ce5' }],
  ['external-dns', /external-dns/, { label: 'ExternalDNS', short: 'Ed', color: '#326ce5' }],
  [
    'external-secrets',
    /external-secrets/,
    { label: 'External Secrets', short: 'Xs', color: '#326ce5' }
  ],
  ['vault', /\bvault\b/, { label: 'Vault', short: 'Va', color: '#ffd814' }],
  ['keda', /\bkeda\b/, { label: 'KEDA', short: 'Kd', color: '#326ce5' }],
  ['kyverno', /kyverno/, { label: 'Kyverno', short: 'Ky', color: '#ff8f00' }],
  ['gatekeeper', /gatekeeper/, { label: 'Gatekeeper', short: 'Gk', color: '#566366' }],
  ['velero', /velero/, { label: 'Velero', short: 'Vl', color: '#3f9cd6' }],
  ['longhorn', /longhorn/, { label: 'Longhorn', short: 'Lh', color: '#5f224b' }],
  ['minio', /minio/, { label: 'MinIO', short: 'Mn', color: '#c72e49' }],
  ['rancher', /rancher|cattle|fleet-agent/, { label: 'Rancher', short: 'Rc', color: '#2453ff' }],
  ['harbor', /harbor/, { label: 'Harbor', short: 'Hb', color: '#60b932' }],
  [
    'postgres',
    /postgres|postgis|cloudnative-pg|timescale/,
    { label: 'PostgreSQL', short: 'Pg', color: '#336791' }
  ],
  ['mysql', /mysql|percona/, { label: 'MySQL', short: 'My', color: '#00758f' }],
  ['mariadb', /mariadb/, { label: 'MariaDB', short: 'Md', color: '#003545' }],
  ['mongodb', /mongo/, { label: 'MongoDB', short: 'Mg', color: '#47a248' }],
  ['redis', /redis|valkey|keydb/, { label: 'Redis', short: 'Rd', color: '#dc382d' }],
  ['memcached', /memcached/, { label: 'Memcached', short: 'Mc', color: '#2a7bb5' }],
  ['kafka', /kafka|strimzi|redpanda/, { label: 'Kafka', short: 'Kf', color: '#231f20' }],
  ['zookeeper', /zookeeper/, { label: 'ZooKeeper', short: 'Zk', color: '#6b8e23' }],
  ['rabbitmq', /rabbitmq/, { label: 'RabbitMQ', short: 'Rb', color: '#ff6600' }],
  ['nats', /\bnats\b/, { label: 'NATS', short: 'Na', color: '#27aae1' }],
  ['keycloak', /keycloak/, { label: 'Keycloak', short: 'Kc', color: '#4d4d4d' }],
  ['jenkins', /jenkins/, { label: 'Jenkins', short: 'Jk', color: '#d24939' }],
  ['gitlab', /gitlab/, { label: 'GitLab', short: 'Gl', color: '#fc6d26' }],
  [
    'victoriametrics',
    /victoria-?metrics|vmagent|vmselect|vminsert|vmstorage/,
    { label: 'VictoriaMetrics', short: 'Vm', color: '#621773' }
  ],
  ['thanos', /thanos/, { label: 'Thanos', short: 'Th', color: '#6d41ff' }],
  ['clickhouse', /clickhouse/, { label: 'ClickHouse', short: 'Ch', color: '#ffcc01' }],
  ['cassandra', /cassandra|scylla/, { label: 'Cassandra', short: 'Cs', color: '#1287b1' }],
  ['couchbase', /couchbase/, { label: 'Couchbase', short: 'Cb', color: '#ea2328' }],
  ['cockroachdb', /cockroach/, { label: 'CockroachDB', short: 'Cr', color: '#6933ff' }],
  ['neo4j', /neo4j/, { label: 'Neo4j', short: 'N4', color: '#4581c3' }],
  ['influxdb', /influx/, { label: 'InfluxDB', short: 'If', color: '#22adf6' }],
  ['kong', /\bkong\b/, { label: 'Kong', short: 'Kg', color: '#003459' }],
  ['caddy', /\bcaddy\b/, { label: 'Caddy', short: 'Cd', color: '#1f88c0' }],
  ['nexus', /nexus|sonatype/, { label: 'Nexus', short: 'Nx', color: '#1b1c30' }],
  ['wordpress', /wordpress/, { label: 'WordPress', short: 'Wp', color: '#21759b' }],
  ['nextcloud', /nextcloud/, { label: 'Nextcloud', short: 'Nc', color: '#0082c9' }],
  [
    'registry',
    /(^|\s|\/)registry(\s|$)|distribution\/registry/,
    { label: 'Docker registry', short: 'Dr', color: '#2496ed' }
  ],
  ['nginx', /nginx/, { label: 'NGINX', short: 'Ng', color: '#009639' }],
  ['httpd', /\bhttpd\b|apache2/, { label: 'Apache HTTP', short: 'Ap', color: '#d22128' }],
  // Ngôn ngữ / runtime (image gốc) — đoán sau cùng.
  ['nodejs', /(^|\s|\/)node(js)?(\s|$)/, { label: 'Node.js', short: 'Js', color: '#5fa04e' }],
  [
    'python',
    /python|django|flask|fastapi|uvicorn|gunicorn/,
    { label: 'Python', short: 'Py', color: '#3776ab' }
  ],
  ['go', /golang|distroless\/static/, { label: 'Go', short: 'Go', color: '#00add8' }],
  [
    'java',
    /openjdk|temurin|corretto|\bjava\b|spring|tomcat|jetty/,
    { label: 'Java', short: 'Jv', color: '#6db33f' }
  ],
  ['php', /\bphp\b|php-fpm|laravel/, { label: 'PHP', short: 'Ph', color: '#777bb4' }],
  ['dotnet', /dotnet|aspnet/, { label: '.NET', short: 'Ne', color: '#512bd4' }],
  ['ruby', /\bruby\b|\brails\b/, { label: 'Ruby', short: 'Rb', color: '#cc342d' }]
]

export const TECH: Readonly<Record<string, TechInfo>> = Object.fromEntries(
  TECH_RULES.map(([id, , info]) => [id, info])
)

/** Nhận diện công nghệ từ image (bỏ tag / digest), nhãn app và tên workload. */
export function detectTech(
  images: readonly string[],
  labels: Readonly<Record<string, string>>,
  name: string
): string | undefined {
  const hay = [
    ...images.map(
      (i) =>
        i
          .toLowerCase()
          .split('@')[0]
          ?.replace(/:[^/]*$/, '') ?? ''
    ),
    labels['app.kubernetes.io/name'] ?? '',
    labels['app.kubernetes.io/part-of'] ?? '',
    labels['app'] ?? '',
    labels['k8s-app'] ?? '',
    name
  ]
    .join(' ')
    .toLowerCase()
  return TECH_RULES.find(([, re]) => re.test(hay))?.[0]
}

// ——— Selector ———

/** LabelSelector (matchLabels + matchExpressions) hoặc map phẳng của Service khớp nhãn không. */
export function selectorMatches(
  selector: unknown,
  labels: Record<string, string>,
  emptyMatchesAll = false
): boolean {
  const sel = (selector && typeof selector === 'object' ? selector : {}) as Record<string, unknown>
  const structured = 'matchLabels' in sel || 'matchExpressions' in sel
  const match = (structured ? (sel['matchLabels'] ?? {}) : sel) as Record<string, unknown>
  const exprs = (
    structured && Array.isArray(sel['matchExpressions']) ? sel['matchExpressions'] : []
  ) as { key?: string; operator?: string; values?: string[] }[]
  const pairs = Object.entries(match)
  if (pairs.length === 0 && exprs.length === 0) return emptyMatchesAll
  if (pairs.some(([k, v]) => labels[k] !== v)) return false
  return exprs.every((e) => {
    const key = e.key ?? ''
    // Object.hasOwn: nhãn "constructor" / "toString" không được coi là có sẵn.
    const has = Object.hasOwn(labels, key)
    const values = e.values ?? []
    switch (e.operator) {
      case 'In':
        return has && values.includes(labels[key] ?? '')
      case 'NotIn':
        return !has || !values.includes(labels[key] ?? '')
      case 'Exists':
        return has
      case 'DoesNotExist':
        return !has
      default:
        return false
    }
  })
}

/**
 * Tìm workload khớp selector nhanh: chỉ mục theo cặp nhãn `key=value` → chỉ so selector với
 * workload có cặp nhãn đầu tiên của selector (cluster lớn: không so mọi service với mọi workload).
 */
export class LabelIndex<T extends { labels: Record<string, string> }> {
  private readonly byPair = new Map<string, T[]>()

  constructor(private readonly items: readonly T[]) {
    for (const it of items)
      for (const [k, v] of Object.entries(it.labels)) {
        const key = `${k}\u0000${v}`
        const list = this.byPair.get(key)
        if (list) list.push(it)
        else this.byPair.set(key, [it])
      }
  }

  /** Như `items.filter((x) => selectorMatches(selector, x.labels, emptyMatchesAll))`, cùng thứ tự. */
  match(selector: unknown, emptyMatchesAll = false): T[] {
    const sel = (selector && typeof selector === 'object' ? selector : {}) as Record<
      string,
      unknown
    >
    const structured = 'matchLabels' in sel || 'matchExpressions' in sel
    const labels = (structured ? (sel['matchLabels'] ?? {}) : sel) as Record<string, unknown>
    const first = Object.entries(labels)[0]
    const pool =
      first && typeof first[1] === 'string'
        ? (this.byPair.get(`${first[0]}\u0000${first[1]}`) ?? [])
        : this.items
    return pool.filter((x) => selectorMatches(selector, x.labels, emptyMatchesAll))
  }
}

function groupBy<T>(items: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const list = out.get(k)
    if (list) list.push(it)
    else out.set(k, [it])
  }
  return out
}

// ——— Tên loại workload ———

const KIND_LABEL: Record<string, string> = {
  'deployments.apps': 'Deployment',
  'statefulsets.apps': 'StatefulSet',
  'daemonsets.apps': 'DaemonSet',
  'jobs.batch': 'Job',
  'cronjobs.batch': 'CronJob',
  pods: 'Pods'
}

export function workloadKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}
