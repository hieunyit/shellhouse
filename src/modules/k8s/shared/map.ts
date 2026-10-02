/**
 * Bản đồ cluster (Map — kiểu "Google Maps cho Kubernetes"): dữ liệu gọn từ Session Host, gom vùng
 * theo mục đích, dựng quan hệ (route → service → workload → PVC) và bố cục cố định (cùng dữ liệu →
 * cùng toạ độ: làm mới không làm bản đồ nhảy). Thuần — Session Host, renderer và test dùng chung.
 */

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
}

export interface MapRoute {
  /** ingresses.networking.k8s.io | httproutes.gateway.networking.k8s.io | grpcroutes… */
  kind: string
  ns: string
  name: string
  hosts: string[]
  /** Tên service phía sau (cùng namespace). */
  backends: string[]
  /** Gateway API: Gateway cha (parentRefs). */
  parents?: { ns: string; name: string }[]
}

export interface MapGateway {
  ns: string
  name: string
  className: string
  /** "HTTPS:443, HTTP:80". */
  listeners: string
}

export interface MapPvc {
  ns: string
  name: string
  status: string
  capacity: string
  tone: MapTone
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
    const t = raw.trim()
    if (!t) continue
    let m: RegExpExecArray | null
    if ((m = new RegExp(`^(${KEY})\\s*(==|=)\\s*(${VALUE})$`).exec(t)))
      out.matchLabels[m[1] ?? ''] = m[3] ?? ''
    else if ((m = new RegExp(`^(${KEY})\\s*!=\\s*(${VALUE})$`).exec(t)))
      out.matchExpressions.push({ key: m[1] ?? '', operator: 'NotIn', values: [m[2] ?? ''] })
    else if ((m = new RegExp(`^(${KEY})\\s+(in|notin)\\s*\\(([^)]*)\\)$`, 'i').exec(t)))
      out.matchExpressions.push({
        key: m[1] ?? '',
        operator: (m[2] ?? '').toLowerCase() === 'in' ? 'In' : 'NotIn',
        values: (m[3] ?? '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      })
    else if ((m = new RegExp(`^!\\s*(${KEY})$`).exec(t)))
      out.matchExpressions.push({ key: m[1] ?? '', operator: 'DoesNotExist', values: [] })
    else if ((m = new RegExp(`^(${KEY})$`).exec(t)))
      out.matchExpressions.push({ key: m[1] ?? '', operator: 'Exists', values: [] })
    else
      return { error: `Can't read "${t}" — use key=value, key!=value, key in (a,b), key or !key` }
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
  const services = data.services.filter((s) =>
    keep.some((w) => w.ns === s.ns && selectorMatches(s.selector, w.labels))
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
    hpas: data.hpas.filter((h) =>
      keep.some(
        (w) => w.ns === h.ns && w.name === h.target.name && KIND_LABEL[w.kind] === h.target.kind
      )
    ),
    policies: data.policies.filter((p) =>
      keep.some((w) => w.ns === p.ns && selectorMatches(p.selector, w.labels, true))
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
    const has = key in labels
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

// ——— Bố cục ———

export type MapNodeKind =
  'region' | 'namespace' | 'workload' | 'pod' | 'gateway' | 'service' | 'route' | 'pvc' | 'policy'

export interface MapNode {
  id: string
  kind: MapNodeKind
  /** Khung (toạ độ thế giới, px ở zoom 1). */
  x: number
  y: number
  w: number
  h: number
  label: string
  /** Dòng phụ (1/3 ready, ClusterIP · 80/TCP…). */
  sub: string
  tone: MapTone
  ns?: string
  /** Tài nguyên thật để mở / xem chi tiết (id loại kiểu kubectl). */
  ref?: { kind: string; ns?: string; name: string }
  /** Id node cha (pod → workload, workload → namespace, namespace → region). */
  parent?: string
  /** Nhãn nhỏ: "HPA 2–6", "2 policies". */
  badges?: string[]
  /** Namespace / region: số liệu cho nhìn xa. */
  stats?: { workloads: number; pods: number; warn: number; bad: number }
  /** Workload: công nghệ (TECH); namespace: vài công nghệ chính bên trong. */
  tech?: string
  techs?: string[]
  /** Workload: số pod sẵn sàng / mong muốn (nhãn trên thẻ). */
  replicas?: { ready: number; desired: number }
  /** Workload: tên loại ngắn (Deployment…), trạng thái (CronJob: lịch chạy). */
  status?: string
  /** Namespace đang gập. */
  collapsed?: boolean
}

/**
 * route: route → service; select: service → workload; storage: workload → PVC; attach: gateway →
 * route; policy: workload → NetworkPolicy áp lên nó.
 */
export type MapEdgeKind = 'route' | 'select' | 'storage' | 'attach' | 'policy'

export interface MapEdge {
  from: string
  to: string
  kind: MapEdgeKind
}

export interface MapLayout {
  nodes: MapNode[]
  edges: MapEdge[]
  width: number
  height: number
  /** NetworkPolicy áp lên mỗi workload (id workload → tên policy). */
  policies: Record<string, string[]>
}

export interface MapOptions {
  /** Ẩn vùng System (kube-system…). */
  hideSystem: boolean
  /** Cách gom vùng (mặc định: theo mục đích). */
  grouping?: MapGrouping
  /** Namespace đang gập (chỉ còn thẻ tóm tắt — không thẻ con, không cạnh). */
  collapsed?: (ns: string) => boolean
}

/** Cỡ đảo namespace khi gập. */
const COLLAPSED_W = 300
const COLLAPSED_H = 96

const POD = 10
const POD_GAP = 4
const CARD_MIN_W = 176
const CARD_HEADER = 46
const PILL_W = 176
const PILL_H = 28
const GAP = 12
const PAD = 16
const NS_HEADER = 34
const REGION_HEADER = 44
const REGION_PAD = 24

const SEVERITY: Record<MapTone, number> = { bad: 3, warn: 2, muted: 1, ok: 0 }
const worst = (tones: readonly MapTone[]): MapTone =>
  tones.reduce<MapTone>((w, t) => (SEVERITY[t] > SEVERITY[w] ? t : w), 'ok')

interface Box {
  w: number
  h: number
}

/** Xếp kệ (shelf): trái → phải, xuống dòng khi vượt `maxWidth`. Trả vị trí tương đối + kích thước. */
function shelf(
  items: readonly Box[],
  maxWidth: number,
  gap: number
): { pos: { x: number; y: number }[]; w: number; h: number } {
  const pos: { x: number; y: number }[] = []
  let x = 0
  let y = 0
  let rowH = 0
  let w = 0
  for (const it of items) {
    if (x > 0 && x + it.w > maxWidth) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    pos.push({ x, y })
    x += it.w + gap
    rowH = Math.max(rowH, it.h)
    w = Math.max(w, x - gap)
  }
  return { pos, w, h: items.length ? y + rowH : 0 }
}

const area = (items: readonly Box[]): number => items.reduce((n, b) => n + b.w * b.h, 0)
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Lưới chấm pod trong thẻ workload. */
export function podGrid(n: number): { cols: number; rows: number } {
  if (n === 0) return { cols: 0, rows: 0 }
  const cols = clamp(Math.ceil(Math.sqrt(n * 2.2)), 1, 16)
  return { cols, rows: Math.ceil(n / cols) }
}

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

/** Sắp theo khoá số rồi theo tên (ổn định). */
function orderBy<T extends { name: string }>(items: T[], key: (x: T) => number): T[] {
  return items
    .map((x) => ({ x, k: key(x) }))
    .sort((a, b) => a.k - b.k || a.x.name.localeCompare(b.x.name))
    .map((e) => e.x)
}

/** Thẻ workload (đã đặt chỗ) → node, bỏ danh sách pod dùng lúc xếp. */
function withoutPods(card: MapNode & { pods: MapPod[] }): MapNode {
  const node: MapNode & { pods?: MapPod[] } = { ...card }
  delete node.pods
  return node
}

/** Dữ liệu → node + cạnh + toạ độ. Cùng dữ liệu → cùng kết quả (sắp theo tên). */
export function layoutMap(data: MapData, options: MapOptions): MapLayout {
  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)
  const nsNames = [
    ...new Set([
      ...data.namespaces.map((n) => n.name),
      ...data.workloads.map((w) => w.ns),
      ...data.pods.map((p) => p.ns),
      ...data.services.map((s) => s.ns)
    ])
  ]
    .filter((ns) => !(options.hideSystem && regionOf(ns) === 'System'))
    .sort()
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const policies: Record<string, string[]> = {}

  const podsByOwner = new Map<string, MapPod[]>()
  for (const p of data.pods) {
    const key = p.owner ? `${p.ns}|${p.owner.kind}|${p.owner.name}` : `${p.ns}|standalone`
    podsByOwner.set(key, [...(podsByOwner.get(key) ?? []), p])
  }

  interface Island {
    ns: string
    node: MapNode
    children: MapNode[]
    w: number
    h: number
  }
  const islands: Island[] = []

  const nsWorkloadsOf = new Map<string, MapWorkload[]>()
  for (const w of data.workloads) {
    const list = nsWorkloadsOf.get(w.ns)
    if (list) list.push(w)
    else nsWorkloadsOf.set(w.ns, [w])
  }
  const nsServicesOf = new Map<string, MapService[]>()
  for (const s of data.services) {
    const list = nsServicesOf.get(s.ns)
    if (list) list.push(s)
    else nsServicesOf.set(s.ns, [s])
  }

  for (const ns of nsNames) {
    const nsId = `n:${ns}`
    const children: MapNode[] = []
    const edgeStart = edges.length
    // Hàng 1: route (Ingress / HTTPRoute…); hàng 2: service; hàng 3: workload; hàng 4: PVC.
    // Workload có service trỏ tới đứng đầu (ngay dưới service của nó — đường nối ngắn, không
    // chạy ngầm dưới thẻ khác); còn lại theo loại rồi tên.
    const nsServices = [...(nsServicesOf.get(ns) ?? [])].sort(byName)
    // Service → workload nó chọn: so selector một lần, dùng cho sắp xếp và cạnh.
    const targets = new Map<MapService, MapWorkload[]>()
    const rank = new Map<MapWorkload, number>()
    nsServices.forEach((s, i) => {
      const hit = (nsWorkloadsOf.get(ns) ?? []).filter((w) => selectorMatches(s.selector, w.labels))
      targets.set(s, hit)
      for (const w of hit) if (!rank.has(w)) rank.set(w, i)
    })
    const workloads = [...(nsWorkloadsOf.get(ns) ?? [])].sort(
      (a, b) =>
        (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
        a.kind.localeCompare(b.kind) ||
        a.name.localeCompare(b.name)
    )
    // Service theo vị trí workload đích, route theo service đích, PVC theo workload dùng nó —
    // cạnh ngắn, ít cắt nhau (không có đích → cuối hàng, theo tên).
    const firstIndex = (indices: number[]): number =>
      indices.length ? Math.min(...indices) : Number.MAX_SAFE_INTEGER
    const position = new Map(workloads.map((w, i) => [w, i]))
    const services = orderBy(nsServices, (svc) =>
      firstIndex((targets.get(svc) ?? []).map((w) => position.get(w) ?? 0))
    )
    const routes = orderBy(
      data.routes.filter((r) => r.ns === ns),
      (r) =>
        firstIndex(
          r.backends.map((b) => services.findIndex((x) => x.name === b)).filter((i) => i >= 0)
        )
    )
    const pvcs = orderBy(
      data.pvcs.filter((v) => v.ns === ns),
      (v) => firstIndex(workloads.flatMap((w, i) => (w.pvcs.includes(v.name) ? [i] : [])))
    )
    const standalone = podsByOwner.get(`${ns}|standalone`) ?? []

    const cards: (MapNode & { pods: MapPod[] })[] = []
    for (const w of workloads) {
      const pods = (podsByOwner.get(`${ns}|${KIND_LABEL[w.kind] ?? ''}|${w.name}`) ?? []).sort(
        byName
      )
      const g = podGrid(pods.length)
      const id = `w:${w.kind}:${ns}/${w.name}`
      const hpa = data.hpas.find(
        (h) => h.ns === ns && h.target.name === w.name && h.target.kind === KIND_LABEL[w.kind]
      )
      const pol = data.policies
        .filter((p) => p.ns === ns && selectorMatches(p.selector, w.labels, true))
        .map((p) => p.name)
      if (pol.length) policies[id] = pol
      const badges = [
        ...(w.helm ? ['Helm'] : []),
        ...(hpa ? [`HPA ${hpa.min}–${hpa.max}`] : []),
        ...(pol.length ? [`${pol.length} polic${pol.length === 1 ? 'y' : 'ies'}`] : [])
      ]
      cards.push({
        id,
        kind: 'workload',
        x: 0,
        y: 0,
        w: Math.max(CARD_MIN_W, g.cols * (POD + POD_GAP) - POD_GAP + 2 * 10),
        h: CARD_HEADER + (g.rows ? g.rows * (POD + POD_GAP) - POD_GAP + 10 : 0),
        label: w.name,
        sub: `${KIND_LABEL[w.kind] ?? w.kind} · ${w.status}`,
        tone: w.tone,
        ns,
        ref: { kind: w.kind, ns, name: w.name },
        parent: nsId,
        ...(badges.length ? { badges } : {}),
        ...(w.tech ? { tech: w.tech } : {}),
        replicas: { ready: w.ready, desired: w.desired },
        status: w.status,
        pods
      })
    }
    if (standalone.length) {
      const g = podGrid(standalone.length)
      cards.push({
        id: `w:pods:${ns}/standalone`,
        kind: 'workload',
        x: 0,
        y: 0,
        w: Math.max(CARD_MIN_W, g.cols * (POD + POD_GAP) - POD_GAP + 20),
        h: CARD_HEADER + g.rows * (POD + POD_GAP) - POD_GAP + 10,
        label: 'Standalone pods',
        sub: `${standalone.length} pod${standalone.length === 1 ? '' : 's'}`,
        tone: worst(standalone.map((p) => p.tone)),
        ns,
        parent: nsId,
        pods: standalone.sort(byName)
      })
    }
    const pill = (
      id: string,
      kind: MapNodeKind,
      label: string,
      sub: string,
      tone: MapTone,
      ref: MapNode['ref'],
      w = PILL_W
    ): MapNode => ({ id, kind, x: 0, y: 0, w, h: PILL_H, label, sub, tone, ns, ref, parent: nsId })
    const gatewayNodes = (data.gateways ?? [])
      .filter((g) => g.ns === ns)
      .sort(byName)
      .map((g) =>
        pill(
          `gw:${ns}/${g.name}`,
          'gateway',
          g.name,
          [g.className, g.listeners].filter(Boolean).join(' · '),
          'ok',
          { kind: 'gateways.gateway.networking.k8s.io', ns, name: g.name }
        )
      )
    const nsPolicies = data.policies.filter((p) => p.ns === ns).sort(byName)
    const policyNodes = nsPolicies.map((p) =>
      pill(
        `np:${ns}/${p.name}`,
        'policy',
        p.name,
        (() => {
          const n = workloads.filter((w) => selectorMatches(p.selector, w.labels, true)).length
          return `NetworkPolicy · ${n} workload${n === 1 ? '' : 's'}`
        })(),
        'muted',
        { kind: 'networkpolicies.networking.k8s.io', ns, name: p.name },
        150
      )
    )
    const routeNodes = routes.map((r) =>
      pill(`r:${r.kind}:${ns}/${r.name}`, 'route', r.name, r.hosts.join(', ') || 'any host', 'ok', {
        kind: r.kind,
        ns,
        name: r.name
      })
    )
    const serviceNodes = services.map((s) =>
      pill(
        `s:${ns}/${s.name}`,
        'service',
        s.name,
        [s.type, s.ports].filter(Boolean).join(' · '),
        'ok',
        {
          kind: 'services',
          ns,
          name: s.name
        }
      )
    )
    const pvcNodes = pvcs.map((v) =>
      pill(
        `v:${ns}/${v.name}`,
        'pvc',
        v.name,
        [v.status, v.capacity].filter(Boolean).join(' · '),
        v.tone,
        {
          kind: 'persistentvolumeclaims',
          ns,
          name: v.name
        }
      )
    )

    // Chiều rộng hàng: theo diện tích thẻ (đảo vuông vừa phải), trong [380, 1600].
    const width = clamp(Math.sqrt(area(cards)) * 1.6, 380, 1600)
    const rows = [
      [...gatewayNodes, ...routeNodes],
      serviceNodes,
      cards,
      [...pvcNodes, ...policyNodes]
    ].filter((r) => r.length > 0)
    let y = NS_HEADER
    let w = 260
    for (const row of rows) {
      const s = shelf(row, width, GAP)
      row.forEach((n, i) => {
        const p = s.pos[i] ?? { x: 0, y: 0 }
        n.x = PAD + p.x
        n.y = y + p.y
      })
      y += s.h + GAP
      w = Math.max(w, s.w + 2 * PAD)
    }
    const h = Math.max(y - GAP + PAD, NS_HEADER + 40)
    const podCount = cards.reduce((n, c) => n + c.pods.length, 0)
    // Công nghệ chính (nhiều workload nhất) cho nhìn xa.
    const techCount = new Map<string, number>()
    for (const c of cards) if (c.tech) techCount.set(c.tech, (techCount.get(c.tech) ?? 0) + 1)
    const techs = [...techCount.entries()]
      .sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0]))
      .slice(0, 4)
      .map(([id]) => id)
    const tones = [...cards.map((c) => c.tone), ...pvcNodes.map((p) => p.tone)]
    const node: MapNode = {
      id: nsId,
      kind: 'namespace',
      x: 0,
      y: 0,
      w,
      h,
      label: ns,
      sub: `${cards.length} workload${cards.length === 1 ? '' : 's'} · ${podCount} pod${podCount === 1 ? '' : 's'}`,
      tone: worst(tones),
      ns,
      ref: { kind: 'namespaces', name: ns },
      ...(techs.length ? { techs } : {}),
      stats: {
        workloads: cards.length,
        pods: podCount,
        warn: tones.filter((t) => t === 'warn').length,
        bad: tones.filter((t) => t === 'bad').length
      }
    }
    // Pod: chấm trong thẻ workload (toạ độ tương đối thẻ, cộng sau).
    const podNodes: MapNode[] = []
    for (const c of cards) {
      const g = podGrid(c.pods.length)
      c.pods.forEach((p, i) => {
        podNodes.push({
          id: `p:${ns}/${p.name}`,
          kind: 'pod',
          x: c.x + 10 + (i % g.cols) * (POD + POD_GAP),
          y: c.y + CARD_HEADER + Math.floor(i / g.cols) * (POD + POD_GAP),
          w: POD,
          h: POD,
          label: p.name,
          sub: `${p.status}${p.restarts ? ` · ${p.restarts} restarts` : ''}${p.node ? ` · ${p.node}` : ''}`,
          tone: p.tone,
          ns,
          ref: { kind: 'pods', ns, name: p.name },
          parent: c.id
        })
      })
    }
    children.push(
      ...gatewayNodes,
      ...routeNodes,
      ...serviceNodes,
      ...cards.map(withoutPods),
      ...podNodes,
      ...pvcNodes,
      ...policyNodes
    )

    // Cạnh: route → service → workload → PVC.
    for (const r of routes)
      for (const b of r.backends)
        if (services.some((s) => s.name === b))
          edges.push({ from: `r:${r.kind}:${ns}/${r.name}`, to: `s:${ns}/${b}`, kind: 'route' })
    for (const s of services)
      for (const w of targets.get(s) ?? [])
        edges.push({
          from: `s:${ns}/${s.name}`,
          to: `w:${w.kind}:${ns}/${w.name}`,
          kind: 'select'
        })
    for (const w of workloads)
      for (const v of w.pvcs)
        if (pvcs.some((p) => p.name === v))
          edges.push({ from: `w:${w.kind}:${ns}/${w.name}`, to: `v:${ns}/${v}`, kind: 'storage' })
    for (const p of nsPolicies)
      for (const w of workloads)
        if (selectorMatches(p.selector, w.labels, true))
          edges.push({
            from: `w:${w.kind}:${ns}/${w.name}`,
            to: `np:${ns}/${p.name}`,
            kind: 'policy'
          })

    if (options.collapsed?.(ns)) {
      // Gập: chỉ thẻ tóm tắt — bỏ thẻ con và cạnh trong namespace.
      edges.length = edgeStart
      node.collapsed = true
      node.w = COLLAPSED_W
      node.h = COLLAPSED_H
      islands.push({ ns, node, children: [], w: COLLAPSED_W, h: COLLAPSED_H })
    } else islands.push({ ns, node, children, w, h })
  }

  // Gateway → route (gateway có thể ở namespace khác — vd. gateway dùng chung).
  const shown = new Set(nsNames)
  const gatewayIds = new Set(
    (data.gateways ?? []).filter((g) => shown.has(g.ns)).map((g) => `gw:${g.ns}/${g.name}`)
  )
  const folded = (ns: string): boolean => options.collapsed?.(ns) ?? false
  for (const r of data.routes) {
    if (!shown.has(r.ns) || folded(r.ns)) continue
    for (const p of r.parents ?? []) {
      const gid = `gw:${p.ns}/${p.name}`
      if (gatewayIds.has(gid) && !folded(p.ns))
        edges.push({ from: gid, to: `r:${r.kind}:${r.ns}/${r.name}`, kind: 'attach' })
    }
  }

  // Vùng: đảo xếp kệ trong vùng; vùng xếp kệ trên toàn bản đồ.
  interface RegionBox extends Box {
    node: MapNode
    members: Island[]
    pos: { x: number; y: number }[]
  }
  const regions: RegionBox[] = []
  const grouping = options.grouping ?? 'purpose'
  const groupOfNs = groupNamespaces(data, grouping)
  const groupOf = (ns: string): string => groupOfNs.get(ns) ?? OTHER_GROUP
  for (const region of groupOrder(
    islands.map((i) => groupOf(i.ns)),
    grouping
  )) {
    const members = islands.filter((i) => groupOf(i.ns) === region)
    if (!members.length) continue
    const width = clamp(Math.sqrt(area(members)) * 1.5, 700, 4200)
    const s = shelf(members, width, 32)
    const stats = members.reduce(
      (acc, m) => ({
        workloads: acc.workloads + (m.node.stats?.workloads ?? 0),
        pods: acc.pods + (m.node.stats?.pods ?? 0),
        warn: acc.warn + (m.node.stats?.warn ?? 0),
        bad: acc.bad + (m.node.stats?.bad ?? 0)
      }),
      { workloads: 0, pods: 0, warn: 0, bad: 0 }
    )
    regions.push({
      w: s.w + 2 * REGION_PAD,
      h: s.h + REGION_HEADER + REGION_PAD,
      members,
      pos: s.pos,
      node: {
        id: `g:${region}`,
        kind: 'region',
        x: 0,
        y: 0,
        w: s.w + 2 * REGION_PAD,
        h: s.h + REGION_HEADER + REGION_PAD,
        label: region,
        sub: `${members.length} namespace${members.length === 1 ? '' : 's'} · ${stats.workloads} workloads · ${stats.pods} pods`,
        tone: worst(members.map((m) => m.node.tone)),
        stats
      }
    })
  }
  const total = clamp(Math.sqrt(area(regions)) * 1.4, 1200, 9000)
  const placed = shelf(regions, total, 80)
  regions.forEach((r, ri) => {
    const rp = placed.pos[ri] ?? { x: 0, y: 0 }
    r.node.x = rp.x
    r.node.y = rp.y
    nodes.push(r.node)
    r.members.forEach((m, mi) => {
      const mp = r.pos[mi] ?? { x: 0, y: 0 }
      const ox = rp.x + REGION_PAD + mp.x
      const oy = rp.y + REGION_HEADER + mp.y
      m.node.x = ox
      m.node.y = oy
      m.node.parent = r.node.id
      nodes.push(m.node)
      for (const c of m.children) nodes.push({ ...c, x: c.x + ox, y: c.y + oy })
    })
  })
  return { nodes, edges, width: placed.w, height: placed.h, policies }
}

/**
 * Phạm vi ảnh hưởng (blast radius) khi một node đổi / hỏng: pod của workload, route gắn vào
 * gateway, và mọi thứ dựa vào nó — service chọn workload, route tới service, workload dùng PVC /
 * chịu NetworkPolicy — lan tiếp theo cùng quy tắc.
 */
export function impactOf(layout: Pick<MapLayout, 'nodes' | 'edges'>, id: string): Set<string> {
  const out = new Set<string>()
  const children = new Map<string, string[]>()
  for (const n of layout.nodes)
    if (n.kind === 'pod' && n.parent)
      children.set(n.parent, [...(children.get(n.parent) ?? []), n.id])
  const queue = [id]
  const push = (x: string): void => {
    if (x === id || out.has(x)) return
    out.add(x)
    queue.push(x)
  }
  while (queue.length) {
    const cur = queue.shift() ?? ''
    for (const c of children.get(cur) ?? []) push(c)
    for (const e of layout.edges) {
      if (e.kind === 'attach') {
        if (e.from === cur) push(e.to)
      } else if (e.to === cur) push(e.from)
    }
  }
  return out
}
