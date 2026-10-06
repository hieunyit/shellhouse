import { t, tn } from '@shared/i18n'
import { formatDate } from '@shared/i18n/format'
import {
  LabelIndex,
  regionOf,
  selectorMatches,
  workloadKindLabel,
  type MapData,
  type MapPdb,
  type MapPod,
  type MapRoute,
  type MapRouteRule,
  type MapService,
  type MapTone,
  type MapWorkload
} from './map'

/**
 * Topology tĩnh của ứng dụng (nhân vật chính của Map): làn trái → phải
 *   Entry (Gateway + HTTPRoute / GRPCRoute xếp dưới nó, Ingress, LoadBalancer · NodePort)
 *   → Services → Workloads → Pods (gộp theo workload) → Config & storage
 * chia dải theo namespace. Không cần traffic: chỉ đọc cấu hình + trạng thái và tự chỉ ra lỗi cấu hình
 * (selector không khớp, targetPort không có, Service đích không tồn tại, thiếu Secret TLS…) bằng lời.
 * Thuần (renderer + test): cùng dữ liệu → cùng đồ thị, cùng toạ độ (làm mới không nhảy).
 */

export type TopoLane = 'entry' | 'route' | 'service' | 'workload' | 'pods' | 'deps'
export const TOPO_LANES: readonly TopoLane[] = [
  'entry',
  'route',
  'service',
  'workload',
  'pods',
  'deps'
]

export type TopoKind =
  | 'gateway'
  | 'ingress'
  | 'lb'
  | 'route'
  | 'service'
  | 'workload'
  | 'pods'
  | 'configmap'
  | 'secret'
  | 'pvc'
  | 'more'
  | 'namespace'

export type TopoSeverity = 'bad' | 'warn' | 'info'

export interface TopoProblem {
  /** Mã ổn định (lọc / test): svc-no-match, svc-no-ready, svc-target-port, ing-missing-svc… */
  code: string
  severity: TopoSeverity
  /** Câu giải thích (đã dịch). */
  text: string
  /** Gợi ý cách sửa (đã dịch) — một câu, hiện dưới lời giải thích. */
  fix?: string
}

/** Một dòng trong thẻ (luật Ingress, cổng Service, listener Gateway) — có điểm nối riêng. */
export interface TopoRow {
  text: string
  /** Phần phụ bên phải (→ web:80). */
  hint?: string
  tone?: MapTone
}

export interface TopoBadge {
  text: string
  tone?: MapTone | 'info'
  title?: string
}

export interface TopoNode {
  id: string
  kind: TopoKind
  lane: TopoLane
  ns: string
  name: string
  /** Tên loại để hiện (Ingress, Deployment, Service…). */
  title: string
  /** Dòng phụ ngắn (loại Service, ingress class, host…). */
  sub: string
  /** Dòng trạng thái (thẻ workload / service): "2/3 ready", lỗi đầu tiên… */
  status?: string
  tone: MapTone
  /** Tài nguyên thật (mở chi tiết, log, YAML). */
  ref?: { kind: string; ns?: string; name: string }
  rows?: TopoRow[]
  badges?: TopoBadge[]
  problems: TopoProblem[]
  /** Được tham chiếu nhưng không tồn tại. */
  missing?: boolean
  /** Workload: sẵn sàng / mong muốn. */
  replicas?: { ready: number; desired: number }
  tech?: string
  helm?: boolean
  /** Nhóm pod: danh sách pod (lỗi trước); `expanded` = hiện từng pod. */
  pods?: MapPod[]
  expanded?: boolean
  /** Nhãn (tìm theo key=value): workload = nhãn pod template. */
  labels?: Record<string, string>
  /** Thẻ "+N workloads" của namespace bị cắt bớt. */
  more?: number
  /** Thẻ tóm tắt namespace đang gập. */
  stats?: TopoNsStats
  /** Hàng trong dải namespace (sắp: công khai → nội bộ → chạy nền; không gắn → cuối). */
  row: number
  /** Dữ liệu gốc cho bảng chi tiết. */
  service?: MapService
  route?: MapRoute
  workload?: MapWorkload
  /** Workload: NetworkPolicy áp lên / HPA. */
  policies?: string[]
  hpa?: { name: string; min: number; max: number; current: number }
}

export type TopoEdgeKind = 'attach' | 'route' | 'expose' | 'select' | 'run' | 'uses' | 'mounts'

export interface TopoEdge {
  id: string
  from: string
  to: string
  kind: TopoEdgeKind
  /** Dòng (trong thẻ nguồn) phát ra cạnh này. */
  fromRow?: number
  /** Cạnh tới thứ không tồn tại / đang hỏng (nét đứt đỏ). */
  broken?: boolean
}

export interface TopoNsStats {
  workloads: number
  pods: number
  ok: number
  warn: number
  bad: number
  entries: number
  services: number
  problems: { bad: number; warn: number }
}

export interface TopoNamespace {
  name: string
  collapsed: boolean
  /** Workload không hiện vì cắt bớt. */
  hidden: number
  stats: TopoNsStats
}

export interface TopoProblemRef {
  node: string
  ns: string
  name: string
  title: string
  problem: TopoProblem
}

export interface TopoGraph {
  nodes: TopoNode[]
  edges: TopoEdge[]
  namespaces: TopoNamespace[]
  /** Mọi vấn đề (kể cả trong namespace đang gập / bị cắt) — xấu trước. */
  problems: TopoProblemRef[]
}

export interface TopoOptions {
  hideSystem: boolean
  /** Hiện làn Config & storage. */
  showDeps: boolean
  /** Workload (id) đang mở danh sách pod. */
  expanded: ReadonlySet<string>
  /** Namespace đang gập (chỉ còn thẻ tóm tắt). */
  collapsed: (ns: string) => boolean
  /** Namespace hiện đủ workload (không cắt). */
  showAll: ReadonlySet<string>
  /** Chế độ tập trung: chỉ đường đi qua node này (lên + xuống). */
  focus?: string | null
  /** Thời điểm tính hạn chứng chỉ (test); mặc định bây giờ. */
  now?: number
}

/** Workload tối đa mỗi namespace trước khi gộp "+N". */
export const MAX_ROWS_PER_NS = 30
/** Dòng tối đa trong thẻ (luật / cổng) trước "+N more". */
export const MAX_CARD_ROWS = 8
/** Pod tối đa khi mở danh sách. */
export const MAX_POD_ROWS = 24

const SEVERITY: Record<MapTone, number> = { bad: 3, warn: 2, muted: 1, ok: 0 }
const worst = (tones: readonly MapTone[]): MapTone =>
  tones.reduce<MapTone>((w, x) => (SEVERITY[x] > SEVERITY[w] ? x : w), 'ok')
const problemTone = (ps: readonly TopoProblem[], base: MapTone): MapTone =>
  worst([
    base,
    ...ps.map((p): MapTone =>
      p.severity === 'bad' ? 'bad' : p.severity === 'warn' ? 'warn' : 'ok'
    )
  ])

/**
 * So chuỗi theo mã ký tự: tên Kubernetes là chữ thường / số / '-' (DNS) — đủ ổn định, nhanh hơn
 * Intl.Collator nhiều lần khi sắp hàng chục nghìn pod.
 */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function groupBy<T>(items: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const x of items) {
    const k = key(x)
    const list = out.get(k)
    if (list) list.push(x)
    else out.set(k, [x])
  }
  return out
}

const KIND_ORDER: Record<string, number> = {
  'deployments.apps': 0,
  'statefulsets.apps': 1,
  'daemonsets.apps': 2,
  'cronjobs.batch': 3,
  'jobs.batch': 4,
  pods: 5
}

const ROUTE_TITLE: Record<string, string> = {
  'ingresses.networking.k8s.io': 'Ingress',
  'httproutes.gateway.networking.k8s.io': 'HTTPRoute',
  'grpcroutes.gateway.networking.k8s.io': 'GRPCRoute'
}

export const workloadId = (kind: string, ns: string, name: string): string =>
  `wl:${kind}:${ns}/${name}`
export const serviceId = (ns: string, name: string): string => `svc:${ns}/${name}`

/** Tên ngắn của selector ("app=web, tier=api"). */
export function selectorText(sel: Record<string, string>): string {
  return Object.entries(sel)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
}

const podSort = (a: MapPod, b: MapPod): number =>
  SEVERITY[b.tone] - SEVERITY[a.tone] || compare(a.name, b.name)

/** Lý do pod xấu → câu gọn ("2 pods in CrashLoopBackOff"). */
function podProblems(pods: readonly MapPod[]): TopoProblem[] {
  const byStatus = new Map<string, { n: number; tone: MapTone }>()
  let notReady = 0
  for (const p of pods) {
    if (p.notReady) {
      notReady++
      continue
    }
    if (p.tone !== 'bad' && p.tone !== 'warn') continue
    const prev = byStatus.get(p.status)
    byStatus.set(p.status, { n: (prev?.n ?? 0) + 1, tone: worst([prev?.tone ?? 'ok', p.tone]) })
  }
  const out: TopoProblem[] = [...byStatus.entries()]
    .sort((a, b) => SEVERITY[b[1].tone] - SEVERITY[a[1].tone] || b[1].n - a[1].n)
    .map(([status, x]) => ({
      code: /ImagePull|ErrImage/.test(status)
        ? 'pod-image'
        : /CrashLoop|Error|OOMKilled/.test(status)
          ? 'pod-crash'
          : /Pending|ContainerCreating|Init:/.test(status)
            ? 'pod-pending'
            : 'pod-status',
      severity: x.tone === 'bad' ? 'bad' : 'warn',
      text: tn(x.n, '{n} pod in {status}', '{n} pods in {status}', { status })
    }))
  if (notReady)
    out.push({
      code: 'pod-not-ready',
      severity: 'warn',
      text: tn(
        notReady,
        '{n} pod running but not ready (readiness probe failing)',
        '{n} pods running but not ready (readiness probe failing)'
      )
    })
  return out
}

/** Gom dữ liệu theo namespace một lần (cluster lớn: không lọc lại cho từng namespace). */
interface Index {
  workloads: Map<string, MapWorkload[]>
  services: Map<string, MapService[]>
  routes: Map<string, MapRoute[]>
  pods: Map<string, MapPod[]>
  gateways: Map<string, NonNullable<MapData['gateways']>>
  pvcs: Map<string, MapData['pvcs']>
  policies: Map<string, MapData['policies']>
  hpas: Map<string, MapData['hpas'][number]>
  pdbs: Map<string, MapPdb[]>
  /** "class|host|path" của Ingress → các Ingress khai báo nó ("ns/name") — tìm host trùng. */
  ingressPaths: Map<string, string[]>
  now: number
}

/** Chứng chỉ TLS còn ít hơn chừng này ngày → cảnh báo. */
export const CERT_WARN_DAYS = 14
const DAY_MS = 86_400_000

/** Lớp của Ingress để so trùng host: không ghi → lớp mặc định. */
function ingressPathKeys(r: MapRoute, defaultClass: string): string[] {
  const cls = r.className || defaultClass
  return [
    ...new Set(
      (r.rules ?? [])
        .filter((x) => x.host && !x.default)
        .map((x) => `${cls}|${x.host}|${x.path || '/'}`)
    )
  ]
}

function indexData(data: MapData, now: number): Index {
  const workloadKeys = new Set(
    data.workloads.map((w) => `${w.ns}|${workloadKindLabel(w.kind)}|${w.name}`)
  )
  const hpas = new Map<string, MapData['hpas'][number]>()
  for (const h of data.hpas) {
    const key = `${h.ns}|${h.target.kind}|${h.target.name}`
    if (!hpas.has(key)) hpas.set(key, h)
  }
  const defaultClass = data.ingressClasses?.find((c) => c.default)?.name ?? ''
  const ingressPaths = new Map<string, string[]>()
  for (const r of data.routes)
    if (r.kind === 'ingresses.networking.k8s.io')
      for (const key of ingressPathKeys(r, defaultClass)) {
        const list = ingressPaths.get(key)
        if (list) list.push(`${r.ns}/${r.name}`)
        else ingressPaths.set(key, [`${r.ns}/${r.name}`])
      }
  return {
    workloads: groupBy(data.workloads, (w) => w.ns),
    services: groupBy(data.services, (s) => s.ns),
    routes: groupBy(data.routes, (r) => r.ns),
    // Pod của owner không có thẻ → nhóm pod lẻ của namespace.
    pods: groupBy(data.pods, (p) => {
      const key = p.owner ? `${p.ns}|${p.owner.kind}|${p.owner.name}` : ''
      return key && workloadKeys.has(key) ? key : `${p.ns}|standalone`
    }),
    gateways: groupBy(data.gateways ?? [], (g) => g.ns),
    pvcs: groupBy(data.pvcs, (v) => v.ns),
    policies: groupBy(data.policies, (p) => p.ns),
    hpas,
    pdbs: groupBy(data.pdbs ?? [], (p) => p.ns),
    ingressPaths,
    now
  }
}

interface NsGraph {
  nodes: TopoNode[]
  edges: TopoEdge[]
  stats: TopoNsStats
  /** Số hàng workload (không tính hàng "không gắn"). */
  rows: number
}

/** Hàng của mục không gắn workload nào (Service không có pod, Ingress tới Service không có…). */
const LOOSE_ROW = 1_000_000

/** Dựng đồ thị đầy đủ (chưa cắt / gập) của một namespace. */
function namespaceGraph(
  ns: string,
  ix: Index,
  data: MapData,
  options: Pick<TopoOptions, 'showDeps' | 'expanded'>
): NsGraph {
  const nodes: TopoNode[] = []
  const edges: TopoEdge[] = []
  const workloads = [...(ix.workloads.get(ns) ?? [])]
  const services = [...(ix.services.get(ns) ?? [])].sort((a, b) => compare(a.name, b.name))
  const routes = [...(ix.routes.get(ns) ?? [])].sort(
    (a, b) => compare(a.kind, b.kind) || compare(a.name, b.name)
  )
  const standalone = (ix.pods.get(`${ns}|standalone`) ?? []).slice().sort(podSort)
  const podCache = new Map<MapWorkload, MapPod[]>()
  const podsOf = (w: MapWorkload): MapPod[] => {
    let list = podCache.get(w)
    if (!list) {
      list = (ix.pods.get(`${ns}|${workloadKindLabel(w.kind)}|${w.name}`) ?? [])
        .slice()
        .sort(podSort)
      podCache.set(w, list)
    }
    return list
  }
  const knownCm = data.configMaps ? new Set(data.configMaps) : null
  const knownSecret = data.secrets ? new Set(data.secrets) : null
  const pvcByName = new Map((ix.pvcs.get(ns) ?? []).map((v) => [v.name, v]))
  const svcByName = new Map(services.map((s) => [s.name, s]))
  const labelIndex = new LabelIndex(workloads)
  const policies = ix.policies.get(ns) ?? []
  const policyTargets = policies.map((p) => new Set(labelIndex.match(p.selector, true)))
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  const addNode = (n: TopoNode): void => {
    nodeIds.add(n.id)
    nodes.push(n)
  }
  const addEdge = (e: TopoEdge): void => {
    if (edgeIds.has(e.id)) return
    edgeIds.add(e.id)
    edges.push(e)
  }

  // ——— Service → workload / pod lẻ ———
  const targets = new Map<MapService, MapWorkload[]>()
  const standaloneHit = new Map<MapService, MapPod[]>()
  for (const s of services) {
    const hasSelector = Object.keys(s.selector).length > 0
    targets.set(s, hasSelector ? labelIndex.match(s.selector) : [])
    standaloneHit.set(
      s,
      hasSelector ? standalone.filter((p) => selectorMatches(s.selector, p.labels ?? {})) : []
    )
  }
  const servicesOf = new Map<MapWorkload, MapService[]>()
  for (const s of services)
    for (const w of targets.get(s) ?? []) {
      const list = servicesOf.get(w)
      if (list) list.push(s)
      else servicesOf.set(w, [s])
    }

  // ——— Lối vào tới từng Service (Ingress / Route / LoadBalancer) ———
  const entriesOf = new Map<string, string[]>()
  const addEntry = (svc: string, label: string): void => {
    const list = entriesOf.get(svc)
    if (list) list.push(label)
    else entriesOf.set(svc, [label])
  }
  for (const r of routes) for (const b of r.backends) addEntry(b, `${r.kind}:${r.name}`)
  for (const s of services)
    if (s.type === 'LoadBalancer' || s.type === 'NodePort') addEntry(s.name, `lb:${s.name}`)

  // ——— Hàng: workload công khai trước, rồi nội bộ, rồi chạy nền; ổn định theo tên ———
  interface RowItem {
    w: MapWorkload | null
    key: string
  }
  const rowItems: RowItem[] = workloads.map((w) => {
    const svcs = (servicesOf.get(w) ?? []).map((s) => s.name).sort(compare)
    const entries = svcs.flatMap((n) => entriesOf.get(n) ?? []).sort(compare)
    const tier = entries.length ? 0 : svcs.length ? 1 : 2
    return {
      w,
      key: `${String(tier)}\u0000${entries[0] ?? ''}\u0000${svcs[0] ?? ''}\u0000${String(KIND_ORDER[w.kind] ?? 9)}\u0000${w.name}`
    }
  })
  if (standalone.length) {
    const svcs = services.filter((s) => (standaloneHit.get(s) ?? []).length).map((s) => s.name)
    const entries = svcs.flatMap((n) => entriesOf.get(n) ?? []).sort(compare)
    rowItems.push({
      w: null,
      key: `${entries.length ? '0' : svcs.length ? '1' : '2'}\u0000${entries[0] ?? ''}\u0000${svcs[0] ?? ''}\u0000${String(KIND_ORDER['pods'] ?? 9)}\u0000`
    })
  }
  rowItems.sort((a, b) => compare(a.key, b.key))
  const rowOfWorkload = new Map<MapWorkload | null, number>()
  rowItems.forEach((r, i) => rowOfWorkload.set(r.w, i))

  // ——— Workload + nhóm pod ———
  const wlNode = new Map<MapWorkload | null, TopoNode>()
  let podCount = 0
  const toneCount = { ok: 0, warn: 0, bad: 0 }
  for (const item of rowItems) {
    const w = item.w
    const row = rowOfWorkload.get(w) ?? LOOSE_ROW
    const pods = w ? podsOf(w) : standalone
    podCount += pods.length
    const id = w ? workloadId(w.kind, ns, w.name) : workloadId('pods', ns, 'standalone')
    const problems: TopoProblem[] = []
    let status: string
    const badges: TopoBadge[] = []
    let policiesOn: string[] = []
    let hpaInfo: TopoNode['hpa']
    if (w) {
      const cron = w.kind === 'cronjobs.batch'
      const job = w.kind === 'jobs.batch'
      if (cron) status = t('Schedule {schedule}', { schedule: w.status })
      else if (job) status = w.status
      else if (w.desired === 0) status = t('Scaled to zero')
      else status = t('{ready}/{desired} ready', { ready: w.ready, desired: w.desired })
      if (w.failed) problems.push({ code: 'job-failed', severity: 'bad', text: t('Job failed') })
      if (!cron && !job && w.desired > 0 && w.ready === 0)
        problems.push({
          code: 'wl-down',
          severity: 'bad',
          text: t('No pods ready ({ready}/{desired})', { ready: w.ready, desired: w.desired })
        })
      else if (!cron && !job && w.ready < w.desired)
        problems.push({
          code: 'wl-degraded',
          severity: 'warn',
          text: t('Only {ready} of {desired} pods ready', { ready: w.ready, desired: w.desired })
        })
      // Còn pod sẵn sàng → workload vẫn phục vụ: pod hỏng là "suy giảm", chưa phải "hỏng".
      const serving = w.ready > 0 || pods.some((p) => p.tone === 'ok' && !p.notReady)
      problems.push(
        ...podProblems(pods).map((p) =>
          serving && p.severity === 'bad' ? { ...p, severity: 'warn' as const } : p
        )
      )
      const restarts = pods.reduce((n, p) => n + p.restarts, 0)
      if (restarts > 5 && !problems.some((p) => p.code === 'pod-crash'))
        problems.push({
          code: 'pod-restarts',
          severity: 'warn',
          text: tn(restarts, '{n} container restart', '{n} container restarts')
        })
      // HPA ở mức tối đa: không còn chỗ để tăng khi tải lên.
      const hpa = ix.hpas.get(`${ns}|${workloadKindLabel(w.kind)}|${w.name}`)
      if (hpa) {
        hpaInfo = { name: hpa.name, min: hpa.min, max: hpa.max, current: hpa.current }
        const atMax = hpa.max > 0 && hpa.current >= hpa.max
        badges.push({
          text: `HPA ${String(hpa.min)}–${String(hpa.max)}`,
          tone: atMax ? 'warn' : 'info',
          title: t('HorizontalPodAutoscaler {name}: {current} replicas now', {
            name: hpa.name,
            current: hpa.current
          })
        })
        if (atMax)
          problems.push({
            code: 'hpa-max',
            severity: 'warn',
            text: t('HPA {name} is at its maximum ({max} replicas) — it cannot scale further', {
              name: hpa.name,
              max: hpa.max
            })
          })
      }
      // PVC / ConfigMap / Secret không có → pod không khởi động được.
      for (const claim of w.pvcs) {
        const v = pvcByName.get(claim)
        if (!v)
          problems.push({
            code: 'pvc-missing',
            severity: 'bad',
            text: t('PersistentVolumeClaim {name} not found', { name: claim })
          })
        else if (v.tone !== 'ok')
          problems.push({
            code: 'pvc-unbound',
            severity: v.tone === 'bad' ? 'bad' : 'warn',
            text: t('PersistentVolumeClaim {name} is {status}', {
              name: claim,
              status: v.status || t('not bound')
            })
          })
      }
      if (knownCm)
        for (const c of w.configMaps ?? [])
          if (!knownCm.has(`${ns}/${c}`))
            problems.push({
              code: 'cm-missing',
              severity: 'bad',
              text: t('ConfigMap {name} not found', { name: c })
            })
      if (knownSecret)
        for (const c of w.secrets ?? [])
          if (!knownSecret.has(`${ns}/${c}`))
            problems.push({
              code: 'secret-missing',
              severity: 'bad',
              text: t('Secret {name} not found', { name: c })
            })
      // NetworkPolicy: chặn hết chiều vào khi mọi policy (loại Ingress) áp lên nó không có luật.
      const applied = policies.filter((_, i) => policyTargets[i]?.has(w))
      policiesOn = applied.map((p) => p.name).sort(compare)
      const ingressPolicies = applied.filter((p) => (p.types ?? ['Ingress']).includes('Ingress'))
      const isolated =
        ingressPolicies.length > 0 && ingressPolicies.every((p) => (p.ingressRules ?? 1) === 0)
      if (applied.length)
        badges.push({
          text: isolated ? t('Isolated') : tn(applied.length, '{n} policy', '{n} policies'),
          tone: isolated ? 'warn' : 'info',
          title: `NetworkPolicy: ${policiesOn.join(', ')}`
        })
      if (isolated)
        problems.push({
          code: 'np-isolated',
          // Có Service trỏ tới mà mọi đường vào bị chặn → gần như chắc chắn là lỗi.
          severity: (servicesOf.get(w) ?? []).length ? 'warn' : 'info',
          text: t('All inbound traffic is blocked by NetworkPolicy {names}', {
            names: ingressPolicies.map((p) => p.name).join(', ')
          })
        })
      // PDB không cho evict pod nào: drain node / nâng cấp node pool đứng chờ mãi.
      for (const b of ix.pdbs.get(ns) ?? [])
        if (b.expected > 0 && b.allowed === 0 && selectorMatches(b.selector, w.labels))
          problems.push({
            code: 'pdb-blocking',
            severity: 'warn',
            text: t(
              'PodDisruptionBudget {name} ({rule}) allows no disruptions — draining a node with these pods will hang',
              { name: b.name, rule: b.rule || '—' }
            ),
            fix:
              w.ready < w.desired
                ? t('Get the pods healthy first; the budget opens up once they are ready.')
                : t('Run more replicas or relax minAvailable / maxUnavailable.')
          })
    } else {
      status = tn(pods.length, '{n} pod without a controller', '{n} pods without a controller')
      problems.push(...podProblems(pods))
    }
    const tone = problemTone(
      problems,
      w ? (w.desired === 0 && !pods.length ? 'muted' : w.tone) : worst(pods.map((p) => p.tone))
    )
    if (tone === 'bad') toneCount.bad++
    else if (tone === 'warn') toneCount.warn++
    else toneCount.ok++
    const first = problems.find((p) => p.severity !== 'info')
    const node: TopoNode = {
      id,
      kind: 'workload',
      lane: 'workload',
      ns,
      name: w ? w.name : t('Standalone pods'),
      title: w ? workloadKindLabel(w.kind) : t('Pods'),
      sub: w ? workloadKindLabel(w.kind) : t('No controller'),
      status: first ? first.text : status,
      tone,
      ...(w ? { ref: { kind: w.kind, ns, name: w.name } } : {}),
      ...(badges.length ? { badges } : {}),
      problems,
      ...(w && w.kind !== 'cronjobs.batch' && w.kind !== 'jobs.batch'
        ? { replicas: { ready: w.ready, desired: w.desired } }
        : {}),
      ...(w?.tech ? { tech: w.tech } : {}),
      ...(w?.helm ? { helm: true } : {}),
      ...(w ? { labels: w.labels, workload: w } : {}),
      ...(policiesOn.length ? { policies: policiesOn } : {}),
      ...(hpaInfo ? { hpa: hpaInfo } : {}),
      row
    }
    addNode(node)
    wlNode.set(w, node)
    // Nhóm pod (CronJob chưa chạy / scale 0 không có pod → không có thẻ).
    if (pods.length || (w && w.desired > 0 && w.kind !== 'cronjobs.batch')) {
      const pid = `pods:${id}`
      const expanded = options.expanded.has(id)
      addNode({
        id: pid,
        kind: 'pods',
        lane: 'pods',
        ns,
        // Tên = số pod (thẻ tự ghi "3 pods" lúc vẽ — tn() tạo formatter, đắt khi lặp hàng nghìn lần).
        name: String(pods.length),
        title: t('Pods'),
        sub: '',
        tone: pods.length ? worst(pods.map((p) => p.tone)) : 'bad',
        problems: [],
        pods,
        ...(expanded ? { expanded } : {}),
        row
      })
      addEdge({ id: `${id}>${pid}`, from: id, to: pid, kind: 'run' })
      // Phụ thuộc: ConfigMap / Secret / PVC mà pod dùng.
      if (options.showDeps && w) {
        const dep = (
          kind: 'configmap' | 'secret' | 'pvc',
          name: string,
          exists: boolean | null
        ): void => {
          const prefix = kind === 'configmap' ? 'cm' : kind === 'secret' ? 'sec' : 'pvc'
          const did = `${prefix}:${ns}/${name}`
          if (!nodeIds.has(did)) {
            const pvc = kind === 'pvc' ? pvcByName.get(name) : undefined
            const missing = exists === false
            addNode({
              id: did,
              kind,
              lane: 'deps',
              ns,
              name,
              title:
                kind === 'configmap'
                  ? 'ConfigMap'
                  : kind === 'secret'
                    ? 'Secret'
                    : 'PersistentVolumeClaim',
              sub: missing
                ? t('Not found')
                : pvc
                  ? [pvc.status, pvc.capacity, pvc.storageClass].filter(Boolean).join(' · ')
                  : '',
              tone: missing ? 'bad' : (pvc?.tone ?? 'ok'),
              ...(missing
                ? {}
                : {
                    ref: {
                      kind:
                        kind === 'configmap'
                          ? 'configmaps'
                          : kind === 'secret'
                            ? 'secrets'
                            : 'persistentvolumeclaims',
                      ns,
                      name
                    }
                  }),
              problems: missing
                ? [{ code: `${prefix}-missing`, severity: 'bad', text: t('Not found') }]
                : pvc && pvc.tone !== 'ok'
                  ? [
                      {
                        code: 'pvc-unbound',
                        severity: pvc.tone === 'bad' ? 'bad' : 'warn',
                        text: t('Claim is {status}', { status: pvc.status || t('not bound') })
                      }
                    ]
                  : [],
              ...(missing ? { missing } : {}),
              row
            })
          }
          addEdge({
            id: `${pid}>${did}`,
            from: pid,
            to: did,
            kind: kind === 'pvc' ? 'mounts' : 'uses',
            ...(exists === false ? { broken: true } : {})
          })
        }
        for (const c of w.configMaps ?? [])
          dep('configmap', c, knownCm ? knownCm.has(`${ns}/${c}`) : null)
        for (const c of w.secrets ?? [])
          dep('secret', c, knownSecret ? knownSecret.has(`${ns}/${c}`) : null)
        for (const c of w.pvcs) dep('pvc', c, pvcByName.has(c))
      }
    }
  }

  // ——— Service ———
  const svcRow = new Map<string, number>()
  const missingSvc = new Map<string, TopoNode>()
  for (const s of services) {
    const ws = targets.get(s) ?? []
    const loose = standaloneHit.get(s) ?? []
    const rows = [
      ...ws.map((w) => rowOfWorkload.get(w) ?? LOOSE_ROW),
      ...(loose.length ? [rowOfWorkload.get(null) ?? LOOSE_ROW] : [])
    ]
    const row = rows.length ? Math.min(...rows) : LOOSE_ROW
    svcRow.set(s.name, row)
    const id = serviceId(ns, s.name)
    const problems: TopoProblem[] = []
    const hasSelector = Object.keys(s.selector).length > 0
    const headless = s.clusterIP === 'None'
    const matched = [...ws.flatMap(podsOf), ...loose]
    const readyPods = matched.filter((p) => p.tone === 'ok' && !p.notReady).length
    const ep = s.endpoints
    if (s.type === 'ExternalName') {
      // Không có endpoint — chỉ là tên DNS.
    } else if (hasSelector && !ws.length && !loose.length) {
      problems.push({
        code: 'svc-no-match',
        severity: 'warn',
        text: t('Selector {selector} matches no pods — the Service has no endpoints', {
          selector: selectorText(s.selector)
        })
      })
    } else if (
      (ep ? ep.ready === 0 && (ep.notReady > 0 || matched.length > 0) : false) ||
      (!ep && hasSelector && matched.length > 0 && readyPods === 0)
    ) {
      problems.push({
        code: 'svc-no-ready',
        severity: 'bad',
        text: t('No ready endpoints — requests to this Service fail')
      })
    } else if (!hasSelector && ep && ep.ready === 0) {
      problems.push({
        code: 'svc-no-ready',
        severity: 'warn',
        text: t('No selector and no endpoints — nothing receives its traffic')
      })
    }
    // targetPort: tên phải là tên cổng container của workload; số thì nên được khai báo.
    const rows2: TopoRow[] = []
    for (const p of s.portList ?? []) {
      let tone: MapTone | undefined
      const named = !/^\d+$/.test(p.targetPort)
      const declared = ws.filter((w) => (w.ports ?? []).length > 0)
      if (named && ws.length) {
        const without = ws.filter((w) => !(w.ports ?? []).some((c) => c.name === p.targetPort))
        if (without.length) {
          tone = 'bad'
          problems.push({
            code: 'svc-target-port',
            severity: 'bad',
            text: t('targetPort “{port}” is not a named port in {workload}', {
              port: p.targetPort,
              workload: without.map((w) => w.name).join(', ')
            })
          })
        }
      } else if (!named && declared.length) {
        const n = Number(p.targetPort)
        const without = declared.filter((w) => !(w.ports ?? []).some((c) => c.port === n))
        if (without.length) {
          tone = 'warn'
          problems.push({
            code: 'svc-target-port',
            severity: 'warn',
            text: t('targetPort {port} is not exposed by any container of {workload}', {
              port: p.targetPort,
              workload: without.map((w) => w.name).join(', ')
            })
          })
        }
      }
      // Tên cổng → số thật của container (dễ đọc: "http · 8080").
      const resolved = named
        ? ws
            .flatMap((w) => w.ports ?? [])
            .find((c) => c.name === p.targetPort)
            ?.port.toString()
        : undefined
      rows2.push({
        text: `${String(p.port)}${p.protocol && p.protocol !== 'TCP' ? `/${p.protocol}` : ''}${p.name ? ` ${p.name}` : ''}`,
        hint: `→ ${p.targetPort}${resolved ? ` · ${resolved}` : ''}${p.nodePort ? ` · node ${String(p.nodePort)}` : ''}`,
        ...(tone ? { tone } : {})
      })
    }
    if (s.type === 'LoadBalancer' && !(s.external ?? []).length)
      problems.push({
        code: 'svc-lb-pending',
        severity: 'warn',
        text: t('LoadBalancer has no external address yet')
      })
    const typeText = headless
      ? t('Headless')
      : s.type === 'ExternalName'
        ? `ExternalName → ${s.externalName ?? ''}`
        : s.type
    const status =
      s.type === 'ExternalName'
        ? (s.externalName ?? '')
        : !hasSelector
          ? ep
            ? tn(ep.ready, '{n} endpoint (manual)', '{n} endpoints (manual)')
            : t('No selector — endpoints managed manually')
          : ep
            ? t('{ready}/{total} endpoints ready', {
                ready: ep.ready,
                total: ep.ready + ep.notReady
              })
            : t('{ready}/{total} pods ready', { ready: readyPods, total: matched.length })
    addNode({
      id,
      kind: 'service',
      lane: 'service',
      ns,
      name: s.name,
      title: 'Service',
      sub: typeText,
      status,
      tone: problemTone(problems, 'ok'),
      ref: { kind: 'services', ns, name: s.name },
      ...(rows2.length ? { rows: rows2 } : {}),
      problems,
      ...(hasSelector ? { labels: s.selector } : {}),
      service: s,
      row
    })
    // Đường đứt chỉ khi request qua Service này thật sự hỏng (không endpoint nào sẵn sàng).
    const dead = problems.some((p) => p.code === 'svc-no-ready' && p.severity === 'bad')
    for (const w of ws) {
      const target = wlNode.get(w)
      if (target)
        addEdge({
          id: `${id}>${target.id}`,
          from: id,
          to: target.id,
          kind: 'select',
          ...(dead ? { broken: true } : {})
        })
    }
    const standaloneNode = wlNode.get(null)
    if (loose.length && standaloneNode)
      addEdge({ id: `${id}>${standaloneNode.id}`, from: id, to: standaloneNode.id, kind: 'select' })
    // LoadBalancer / NodePort: lối vào từ ngoài cluster.
    if (s.type === 'LoadBalancer' || s.type === 'NodePort') {
      const lid = `lb:${ns}/${s.name}`
      const addr = s.external ?? []
      addNode({
        id: lid,
        kind: 'lb',
        lane: 'entry',
        ns,
        name: s.name,
        title: s.type,
        sub: addr.length
          ? addr.join(', ')
          : s.type === 'LoadBalancer'
            ? t('Address pending')
            : t('Every node'),
        tone: s.type === 'LoadBalancer' && !addr.length ? 'warn' : 'ok',
        ref: { kind: 'services', ns, name: s.name },
        rows: (s.portList ?? []).map((p) => ({
          text:
            s.type === 'NodePort' || !addr.length
              ? `:${String(p.nodePort ?? p.port)}`
              : `${addr[0] ?? ''}:${String(p.port)}`,
          hint: `→ ${String(p.port)}`
        })),
        problems: [],
        service: s,
        row
      })
      addEdge({ id: `${lid}>${id}`, from: lid, to: id, kind: 'expose' })
    }
  }
  const ensureMissingService = (name: string, row: number): TopoNode => {
    let n = missingSvc.get(name)
    if (!n) {
      n = {
        id: serviceId(ns, name),
        kind: 'service',
        lane: 'service',
        ns,
        name,
        title: 'Service',
        sub: t('Not found'),
        status: t('Referenced but does not exist'),
        tone: 'bad',
        problems: [
          { code: 'svc-missing', severity: 'bad', text: t('This Service does not exist') }
        ],
        missing: true,
        row
      }
      missingSvc.set(name, n)
      addNode(n)
    } else n.row = Math.min(n.row, row)
    return n
  }

  // ——— Ingress / HTTPRoute / GRPCRoute ———
  const routeRowOf = new Map<string, number>()
  const gatewayKnown = data.gateways !== undefined
  const gatewayNames = new Set((data.gateways ?? []).map((g) => `${g.ns}/${g.name}`))
  for (const r of routes) {
    const ingress = r.kind === 'ingresses.networking.k8s.io'
    const id = ingress ? `ing:${ns}/${r.name}` : `rt:${r.kind}:${ns}/${r.name}`
    const problems: TopoProblem[] = []
    const rules: MapRouteRule[] = r.rules?.length
      ? r.rules
      : r.backends.map((b) => ({ host: r.hosts[0] ?? '', path: '/', service: b }))
    const backRows = rules.map((x) => svcRow.get(x.service) ?? LOOSE_ROW)
    const row = backRows.length ? Math.min(...backRows) : LOOSE_ROW
    routeRowOf.set(id, row)
    const shown = rules.slice(0, MAX_CARD_ROWS)
    const rows: TopoRow[] = shown.map((x) => {
      const svc = svcByName.get(x.service)
      const missing = !svc
      const portBad =
        svc && x.port
          ? !(svc.portList ?? []).some((p) => String(p.port) === x.port || p.name === x.port)
          : false
      return {
        text: x.default
          ? t('default backend')
          : `${x.host || '*'}${x.path && x.path !== '/' ? x.path : x.host ? '/' : x.path || '/'}`,
        hint: `→ ${x.service}${x.port ? `:${x.port}` : ''}`,
        ...(missing ? { tone: 'bad' as const } : portBad ? { tone: 'warn' as const } : {})
      }
    })
    if (rules.length > MAX_CARD_ROWS)
      rows.push({
        text: tn(rules.length - MAX_CARD_ROWS, '+{n} more rule', '+{n} more rules')
      })
    const missingNames = [...new Set(rules.map((x) => x.service))].filter((n) => !svcByName.has(n))
    for (const n of missingNames)
      problems.push({
        code: ingress ? 'ing-missing-svc' : 'route-missing-svc',
        severity: 'bad',
        text: t('Backend Service {name} does not exist — these requests fail', { name: n })
      })
    for (const x of rules) {
      const svc = svcByName.get(x.service)
      if (
        svc &&
        x.port &&
        !(svc.portList ?? []).some((p) => String(p.port) === x.port || p.name === x.port) &&
        (svc.portList ?? []).length
      )
        problems.push({
          code: 'ing-bad-port',
          severity: 'warn',
          text: t('Service {name} has no port {port}', { name: x.service, port: x.port })
        })
    }
    if (ingress && data.ingressClasses) {
      const classes = data.ingressClasses
      if (r.className && !classes.some((c) => c.name === r.className))
        problems.push({
          code: 'ing-class-missing',
          severity: 'bad',
          text: t('IngressClass {name} does not exist — no controller serves this Ingress', {
            name: r.className
          }),
          fix: t('Use one of: {names}', {
            names: classes.map((c) => c.name).join(', ') || t('(no IngressClass installed)')
          })
        })
      else if (!r.className && !classes.some((c) => c.default))
        problems.push({
          code: 'ing-no-class',
          severity: 'warn',
          text: t('No ingress class and no default IngressClass — the controller may ignore it'),
          ...(classes.length
            ? { fix: t('Set spec.ingressClassName: {name}', { name: classes[0]?.name ?? '' }) }
            : {})
        })
    }
    if (ingress) {
      const defaultClass = data.ingressClasses?.find((c) => c.default)?.name ?? ''
      const self = `${ns}/${r.name}`
      for (const key of ingressPathKeys(r, defaultClass)) {
        const others = (ix.ingressPaths.get(key) ?? []).filter((x) => x !== self)
        if (!others.length) continue
        const [, host = '', path = '/'] = key.split('|')
        problems.push({
          code: 'ing-host-conflict',
          severity: 'warn',
          text: t(
            '{host}{path} is also defined by Ingress {others} — the controller picks only one',
            {
              host,
              path,
              others: others
                .map((x) => (x.startsWith(`${ns}/`) ? x.slice(ns.length + 1) : x))
                .join(', ')
            }
          )
        })
      }
    }
    if (ingress && data.tlsExpiry)
      for (const x of r.tls ?? []) {
        const at = x.secret ? data.tlsExpiry[`${ns}/${x.secret}`] : undefined
        if (!at) continue
        const left = (Date.parse(at) - ix.now) / DAY_MS
        if (left < 0)
          problems.push({
            code: 'ing-tls-expired',
            severity: 'bad',
            text: t('Certificate in {name} expired on {date} — browsers reject HTTPS', {
              name: x.secret,
              date: formatDate(at)
            }),
            fix: t('Renew the certificate (cert-manager: check the Certificate resource).')
          })
        else if (left < CERT_WARN_DAYS)
          problems.push({
            code: 'ing-tls-expiring',
            severity: 'warn',
            text: tn(
              Math.max(1, Math.floor(left)),
              'Certificate in {name} expires in {n} day ({date})',
              'Certificate in {name} expires in {n} days ({date})',
              { name: x.secret, date: formatDate(at) }
            )
          })
      }
    const badges: TopoBadge[] = []
    if (ingress && r.tls?.length) {
      const missingTls = data.secrets
        ? r.tls.filter((x) => x.secret && !(data.secrets ?? []).includes(`${ns}/${x.secret}`))
        : []
      for (const x of missingTls)
        problems.push({
          code: 'ing-missing-tls',
          severity: 'bad',
          text: t('TLS Secret {name} not found — HTTPS falls back to a default certificate', {
            name: x.secret
          })
        })
      badges.push({
        text: 'TLS',
        tone:
          missingTls.length || problems.some((p) => p.code === 'ing-tls-expired')
            ? 'bad'
            : problems.some((p) => p.code === 'ing-tls-expiring')
              ? 'warn'
              : 'ok',
        title: r.tls
          .map((x) => `${x.hosts.join(', ') || '*'} → ${x.secret || t('default certificate')}`)
          .join('\n')
      })
    }
    if (!ingress && gatewayKnown)
      for (const p of r.parents ?? [])
        if (!gatewayNames.has(`${p.ns}/${p.name}`))
          problems.push({
            code: 'route-missing-gw',
            severity: 'warn',
            text: t('Parent Gateway {name} not found — the route is not attached', {
              name: p.ns === ns ? p.name : `${p.ns}/${p.name}`
            })
          })
    const sub = ingress
      ? [r.className, ...(r.address ?? [])].filter(Boolean).join(' · ') || t('No ingress class')
      : r.hosts.join(', ') || t('Any host')
    addNode({
      id,
      kind: ingress ? 'ingress' : 'route',
      lane: ingress ? 'entry' : 'route',
      ns,
      name: r.name,
      title: ROUTE_TITLE[r.kind] ?? 'Route',
      sub,
      tone: problemTone(problems, 'ok'),
      ref: { kind: r.kind, ns, name: r.name },
      rows,
      ...(badges.length ? { badges } : {}),
      problems,
      route: r,
      row
    })
    rules.forEach((x, i) => {
      const sid = serviceId(ns, x.service)
      const missing = !svcByName.has(x.service)
      if (missing) ensureMissingService(x.service, row)
      const fromRow = Math.min(i, MAX_CARD_ROWS)
      addEdge({
        id: `${id}#${String(fromRow)}>${sid}`,
        from: id,
        to: sid,
        kind: 'route',
        fromRow,
        ...(missing ? { broken: true } : {})
      })
    })
  }

  // ——— Gateway (route của namespace khác gắn vào: nối ở bước toàn cục) ———
  for (const g of [...(ix.gateways.get(ns) ?? [])].sort((a, b) => compare(a.name, b.name))) {
    const id = `gw:${ns}/${g.name}`
    addNode({
      id,
      kind: 'gateway',
      lane: 'entry',
      ns,
      name: g.name,
      title: 'Gateway',
      sub: [g.className, ...(g.addresses ?? [])].filter(Boolean).join(' · '),
      tone: 'ok',
      ref: { kind: 'gateways.gateway.networking.k8s.io', ns, name: g.name },
      rows: g.listeners
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, MAX_CARD_ROWS)
        .map((x) => ({ text: x })),
      problems: [],
      row: LOOSE_ROW
    })
  }

  const entries = nodes.filter((n) => n.lane === 'entry').length
  const problems = nodes.flatMap((n) => n.problems)
  return {
    nodes,
    edges,
    rows: rowItems.length,
    stats: {
      workloads: workloads.length,
      pods: podCount,
      ok: toneCount.ok,
      warn: toneCount.warn,
      bad: toneCount.bad,
      entries,
      services: services.length,
      problems: {
        bad: problems.filter((p) => p.severity === 'bad').length,
        warn: problems.filter((p) => p.severity === 'warn').length
      }
    }
  }
}

/**
 * Tập liên quan theo hướng (không quay đầu): xuôi theo cạnh từ `id` và ngược lên từ `id`. Chọn
 * Ingress A không làm sáng Ingress B chỉ vì cùng tới một Service.
 */
export function pathThrough(
  edges: readonly { from: string; to: string }[],
  id: string
): Set<string> {
  const down = new Map<string, string[]>()
  const up = new Map<string, string[]>()
  for (const e of edges) {
    const d = down.get(e.from)
    if (d) d.push(e.to)
    else down.set(e.from, [e.to])
    const u = up.get(e.to)
    if (u) u.push(e.from)
    else up.set(e.to, [e.from])
  }
  const out = new Set([id])
  for (const adj of [down, up]) {
    const queue = [id]
    const seen = new Set([id])
    for (let i = 0; i < queue.length; i++)
      for (const next of adj.get(queue[i] ?? '') ?? [])
        if (!seen.has(next)) {
          seen.add(next)
          out.add(next)
          queue.push(next)
        }
  }
  return out
}

/** Đồ thị hiện trên màn hình: gom namespace, cắt bớt / gập, chế độ tập trung. */
/** Gợi ý sửa chung theo mã lỗi (mã có gợi ý riêng theo ngữ cảnh thì đặt ngay lúc phát hiện). */
const FIXES: Partial<Record<string, () => string>> = {
  'svc-no-match': () =>
    t('Compare the selector with the pod labels of the workload it should reach.'),
  'svc-no-ready': () => t('Check the readiness probe and the logs of the selected pods.'),
  'svc-target-port': () =>
    t('Point targetPort at a port the container listens on (number or containerPort name).'),
  'svc-lb-pending': () =>
    t(
      'The cluster needs a load-balancer controller (cloud provider, MetalLB…) — or use NodePort / Ingress.'
    ),
  'ing-missing-svc': () => t('Create the Service, or fix the backend name in the Ingress.'),
  'route-missing-svc': () => t('Create the Service, or fix the backend name in the route.'),
  'ing-bad-port': () => t('Use a port number or port name that the Service declares.'),
  'ing-missing-tls': () =>
    t('Create the Secret (kubectl create secret tls …) or let cert-manager issue it.'),
  'route-missing-gw': () => t('Fix parentRefs or create the Gateway.'),
  'cm-missing': () =>
    t('Create it in this namespace — pods wait in CreateContainerConfigError until then.'),
  'secret-missing': () =>
    t('Create it in this namespace — pods wait in CreateContainerConfigError until then.'),
  'pvc-missing': () => t('Create the PersistentVolumeClaim or fix the claim name.'),
  'pvc-unbound': () =>
    t('Check the StorageClass and the provisioner — the claim waits for a volume.'),
  'hpa-max': () => t('Raise maxReplicas, or give each pod more CPU / memory.'),
  'pod-image': () => t('Check the image name / tag and the imagePullSecrets for the registry.'),
  'pod-crash': () => t('Open the logs of the previous container run to see why it exits.'),
  'pod-pending': () =>
    t('Open the pod events — usually not enough CPU / memory, or a volume / node selector.'),
  'pod-not-ready': () =>
    t('Check the readiness probe — path, port and how long the app takes to start.')
}

export function buildTopology(data: MapData, options: TopoOptions): TopoGraph {
  const ix = indexData(data, options.now ?? Date.now())
  const nsNames = [
    ...new Set([
      ...data.namespaces.map((n) => n.name),
      ...data.workloads.map((w) => w.ns),
      ...data.services.map((s) => s.ns),
      ...data.routes.map((r) => r.ns),
      ...data.pods.map((p) => p.ns)
    ])
  ]
    .filter((ns) => ns && !(options.hideSystem && regionOf(ns) === 'System'))
    .sort(compare)
  const nodes: TopoNode[] = []
  const edges: TopoEdge[] = []
  const namespaces: TopoNamespace[] = []
  const problems: TopoProblemRef[] = []
  const focus = options.focus ?? null
  const full = new Map<string, NsGraph>()
  for (const ns of nsNames) full.set(ns, namespaceGraph(ns, ix, data, options))

  // Gateway → Route (cả khác namespace — Gateway dùng chung).
  const crossEdges: TopoEdge[] = []
  for (const r of data.routes) {
    if (r.kind === 'ingresses.networking.k8s.io') continue
    for (const p of r.parents ?? []) {
      const from = `gw:${p.ns}/${p.name}`
      const to = `rt:${r.kind}:${r.ns}/${r.name}`
      if (full.get(p.ns)?.nodes.some((n) => n.id === from) && full.has(r.ns))
        crossEdges.push({ id: `${from}>${to}`, from, to, kind: 'attach' })
    }
  }
  // Gateway nằm cùng hàng với route đầu tiên gắn vào nó (cùng namespace).
  for (const g of full.values()) {
    const byId = new Map(g.nodes.map((n) => [n.id, n]))
    for (const e of crossEdges) {
      const gw = byId.get(e.from)
      const route = byId.get(e.to)
      if (gw && route) gw.row = Math.min(gw.row, route.row)
    }
  }

  for (const ns of nsNames) {
    const g = full.get(ns)
    if (!g) continue
    for (const n of g.nodes)
      for (const p of n.problems) {
        if (!p.fix) {
          const fix = FIXES[p.code]?.()
          if (fix) p.fix = fix
        }
        problems.push({ node: n.id, ns, name: n.name, title: n.title, problem: p })
      }
  }
  const rank = { bad: 0, warn: 1, info: 2 }
  problems.sort(
    (a, b) =>
      rank[a.problem.severity] - rank[b.problem.severity] ||
      compare(a.ns, b.ns) ||
      compare(a.name, b.name)
  )

  if (focus) {
    // Tập trung: mọi namespace mở, không cắt — chỉ giữ đường đi qua node được chọn.
    const allNodes = [...full.values()].flatMap((g) => g.nodes)
    const allEdges = [...[...full.values()].flatMap((g) => g.edges), ...crossEdges]
    // Nhóm pod luôn đi cùng workload của nó; phụ thuộc của nhóm pod chỉ khi đang xem chính nó.
    const keep = pathThrough(allEdges, focus)
    const nsShown = new Set<string>()
    for (const n of allNodes)
      if (keep.has(n.id)) {
        nodes.push(n)
        nsShown.add(n.ns)
      }
    for (const e of allEdges) if (keep.has(e.from) && keep.has(e.to)) edges.push(e)
    for (const ns of nsNames) {
      const g = full.get(ns)
      if (g && nsShown.has(ns))
        namespaces.push({ name: ns, collapsed: false, hidden: 0, stats: g.stats })
    }
    return { nodes, edges, namespaces, problems }
  }

  for (const ns of nsNames) {
    const g = full.get(ns)
    if (!g) continue
    if (options.collapsed(ns)) {
      nodes.push({
        id: `ns:${ns}`,
        kind: 'namespace',
        lane: 'entry',
        ns,
        name: ns,
        title: 'Namespace',
        sub: '',
        tone: g.stats.bad ? 'bad' : g.stats.warn ? 'warn' : 'ok',
        ref: { kind: 'namespaces', name: ns },
        problems: [],
        stats: g.stats,
        row: 0
      })
      namespaces.push({ name: ns, collapsed: true, hidden: 0, stats: g.stats })
      continue
    }
    // Cắt bớt: chỉ MAX_ROWS_PER_NS hàng workload đầu (công khai trước) — phần còn lại "+N".
    const cap = options.showAll.has(ns) ? Number.POSITIVE_INFINITY : MAX_ROWS_PER_NS
    const hiddenRows = Math.max(0, g.rows - cap)
    const kept = g.nodes.filter(
      (n) => n.row < cap || (n.row === LOOSE_ROW && n.lane !== 'workload')
    )
    const keptIds = new Set(kept.map((n) => n.id))
    nodes.push(...kept)
    for (const e of g.edges) if (keptIds.has(e.from) && keptIds.has(e.to)) edges.push(e)
    if (hiddenRows > 0)
      nodes.push({
        id: `more:${ns}`,
        kind: 'more',
        lane: 'workload',
        ns,
        name: tn(hiddenRows, '+{n} more workload', '+{n} more workloads'),
        title: '',
        sub: '',
        tone: 'muted',
        problems: [],
        more: hiddenRows,
        row: cap
      })
    namespaces.push({ name: ns, collapsed: false, hidden: hiddenRows, stats: g.stats })
  }
  const shown = new Set(nodes.map((n) => n.id))
  for (const e of crossEdges) if (shown.has(e.from) && shown.has(e.to)) edges.push(e)
  return { nodes, edges, namespaces, problems }
}

// ——— Bố cục ———

export interface PlacedTopoNode extends TopoNode {
  x: number
  y: number
  w: number
  h: number
}

export interface PlacedTopoEdge extends TopoEdge {
  /** Điểm nối: lệch so với tâm dọc của thẻ nguồn / đích (px). */
  sOff: number
  tOff: number
  /** Đoạn dọc của đường gấp khúc: cách mép phải thẻ nguồn (px). */
  bend: number
  /**
   * Gateway → Route cùng cột: nối kiểu cây (từ mép dưới Gateway xuống Route) thay vì đi vòng.
   * Cỡ thẻ nguồn / đích để vẽ từ điểm nối (thẻ kéo đi chỗ khác vẫn đúng).
   */
  tree?: { sw: number; sh: number; th: number }
}

export interface TopoBand {
  ns: string
  x: number
  y: number
  w: number
  h: number
  collapsed: boolean
}

export interface TopoLayout {
  nodes: PlacedTopoNode[]
  edges: PlacedTopoEdge[]
  bands: TopoBand[]
  columns: { lane: TopoLane; x: number; w: number }[]
  width: number
  height: number
}

export const LANE_W: Record<TopoLane, number> = {
  entry: 240,
  route: 240,
  service: 232,
  workload: 240,
  pods: 196,
  deps: 212
}
/**
 * Khoảng giữa làn này và làn kế tiếp (chỗ cho đường gấp khúc + nhãn traffic) — vừa đủ để đường
 * nối dễ đọc: Entry → Pods của cluster cỡ vừa lọt ~1150 px (zoom 0,8 vẫn thấy trọn chuỗi).
 */
const LANE_GAP: Record<TopoLane, number> = {
  entry: 64,
  route: 0,
  service: 88,
  workload: 40,
  pods: 56,
  deps: 0
}
/** Route (HTTPRoute / GRPCRoute) không có cột riêng: xếp ngay dưới Gateway của nó, thụt vào. */
export const ROUTE_INDENT = 24
const columnLane = (lane: TopoLane): TopoLane => (lane === 'route' ? 'entry' : lane)
/** Thẻ: đầu (icon, tên, loại) và mỗi dòng. */
export const CARD_HEAD = 50
export const CARD_ROW = 22
export const CARD_FOOT = 26
const WORKLOAD_H = 92
const DEP_H = 52
const MORE_H = 40
const NS_SUMMARY_H = 66
/** Chấm pod: 16 mỗi hàng, tối đa 2 hàng (cố định — số pod đổi không làm bản đồ nhảy). */
export const POD_DOTS_PER_ROW = 16
export const POD_DOT_ROWS = 2
const PODS_COLLAPSED_H = 86
export const POD_ROW_H = 24
const ITEM_GAP = 14
const ROW_GAP = 22
const BAND_HEAD = 40
const BAND_PAD = 16
const BAND_GAP = 20
const PAD = 24

/** Cao của thẻ theo loại / số dòng. */
export function topoNodeHeight(n: TopoNode): number {
  switch (n.kind) {
    case 'workload':
      return WORKLOAD_H
    case 'pods':
      return n.expanded
        ? CARD_HEAD +
            Math.min(n.pods?.length ?? 0, MAX_POD_ROWS) * POD_ROW_H +
            ((n.pods?.length ?? 0) > MAX_POD_ROWS ? CARD_ROW : 0) +
            10
        : PODS_COLLAPSED_H
    case 'service':
      return CARD_HEAD + (n.rows?.length ?? 0) * CARD_ROW + CARD_FOOT + 6
    case 'ingress':
    case 'route':
    case 'lb':
    case 'gateway':
      return CARD_HEAD + (n.rows?.length ?? 0) * CARD_ROW + 8
    case 'more':
      return MORE_H
    case 'namespace':
      return NS_SUMMARY_H
    default:
      return DEP_H
  }
}

/** Toạ độ điểm nối của dòng `i` (lệch so với tâm thẻ). */
function rowAnchor(n: { h: number }, i: number): number {
  return CARD_HEAD + i * CARD_ROW + CARD_ROW / 2 - n.h / 2
}

/**
 * Bố cục: cột cố định theo làn (chung mọi namespace), dải namespace xếp dọc, trong dải xếp theo
 * hàng workload — thẻ đầu của mỗi làn canh tâm với thẻ workload để đường đi thẳng.
 */
export function layoutTopology(
  graph: Pick<TopoGraph, 'nodes' | 'edges' | 'namespaces'>
): TopoLayout {
  const present = new Set(
    graph.nodes.filter((n) => n.kind !== 'namespace').map((n) => columnLane(n.lane))
  )
  if (graph.nodes.some((n) => n.kind === 'namespace')) {
    present.add('entry')
    present.add('workload')
  }
  const lanes = TOPO_LANES.filter((l) => present.has(l))
  const columns: { lane: TopoLane; x: number; w: number }[] = []
  let cx = PAD
  for (const lane of lanes) {
    columns.push({ lane, x: cx, w: LANE_W[lane] })
    cx += LANE_W[lane] + LANE_GAP[lane]
  }
  const last = columns.at(-1)
  const contentRight = last ? last.x + last.w : PAD
  const width = contentRight + PAD
  const colOf = new Map(columns.map((c) => [c.lane, c]))
  // Route → Gateway đầu tiên gắn vào (để xếp route ngay dưới Gateway).
  const parentOf = new Map<string, string>()
  for (const e of graph.edges)
    if (e.kind === 'attach' && !parentOf.has(e.to)) parentOf.set(e.to, e.from)
  const byNs = groupBy(graph.nodes, (n) => n.ns)
  const placed: PlacedTopoNode[] = []
  const bands: TopoBand[] = []
  let y = PAD
  for (const ns of graph.namespaces) {
    const list = byNs.get(ns.name) ?? []
    const top = y
    let bottom = top + BAND_HEAD
    if (ns.collapsed) {
      const n = list[0]
      if (n) {
        const first = columns[0]
        placed.push({
          ...n,
          x: first?.x ?? PAD,
          y: top + BAND_HEAD,
          w: Math.min(contentRight - (first?.x ?? PAD), 1100),
          h: NS_SUMMARY_H
        })
        bottom = top + BAND_HEAD + NS_SUMMARY_H
      }
    } else {
      const rows = groupBy(list, (n) => String(n.row))
      const order = [...rows.keys()].map(Number).sort((a, b) => a - b)
      let ry = top + BAND_HEAD
      for (const r of order) {
        const items = rows.get(String(r)) ?? []
        const byLane = groupBy(items, (n) => columnLane(n.lane))
        // Đường tâm của hàng: mỗi làn có một điểm "dẫn" (tâm thẻ đầu, hoặc dòng đầu của thẻ có
        // luật Ingress / Route) — canh mọi điểm dẫn về cùng một độ cao để đường đi thẳng.
        const stacks = lanes
          .map((lane) => ({ lane, col: colOf.get(lane), stack: byLane.get(lane) ?? [] }))
          .filter((x) => x.col && x.stack.length)
        for (const x of stacks) {
          x.stack.sort((a, b) => compare(a.title, b.title) || compare(a.name, b.name))
          if (x.lane === 'entry') x.stack = nestRoutes(x.stack, parentOf)
        }
        const leadOf = (lane: TopoLane, head: TopoNode | undefined): number =>
          !head
            ? 0
            : lane === 'entry' && head.rows?.length
              ? CARD_HEAD + CARD_ROW / 2
              : topoNodeHeight(head) / 2
        const center = Math.max(0, ...stacks.map((x) => leadOf(x.lane, x.stack[0])))
        let rowBottom = ry
        for (const { lane, col, stack } of stacks) {
          if (!col) continue
          let sy = ry + center - leadOf(lane, stack[0])
          let prevGateway: string | null = null
          for (const n of stack) {
            const h = topoNodeHeight(n)
            // Route ngay dưới Gateway của nó (hoặc dưới route anh em): thụt vào như cây.
            const nested =
              n.kind === 'route' && prevGateway !== null && parentOf.get(n.id) === prevGateway
            if (n.kind === 'gateway') prevGateway = n.id
            else if (!nested) prevGateway = null
            placed.push({
              ...n,
              x: nested ? col.x + ROUTE_INDENT : col.x,
              y: sy,
              w: n.kind === 'more' ? Math.min(col.w, 220) : nested ? col.w - ROUTE_INDENT : col.w,
              h
            })
            sy += h + ITEM_GAP
          }
          rowBottom = Math.max(rowBottom, sy - ITEM_GAP)
        }
        ry = rowBottom + ROW_GAP
      }
      bottom = Math.max(bottom, ry - ROW_GAP)
    }
    bottom += BAND_PAD
    bands.push({
      ns: ns.name,
      x: PAD / 2,
      y: top,
      w: width - PAD,
      h: bottom - top,
      collapsed: ns.collapsed
    })
    y = bottom + BAND_GAP
  }
  const height = y - BAND_GAP + PAD

  // ——— Điểm nối: chia đều trên mép thẻ, theo thứ tự đầu bên kia (ít cắt nhau) ———
  const at = new Map(placed.map((n) => [n.id, n]))
  const centerY = (n: PlacedTopoNode): number => n.y + n.h / 2
  const kept = graph.edges.filter((e) => at.has(e.from) && at.has(e.to))
  const sOff = new Map<string, number>()
  const tOff = new Map<string, number>()
  const outBy = groupBy(
    kept.filter((e) => e.fromRow === undefined),
    (e) => e.from
  )
  for (const [from, list] of outBy) {
    const n = at.get(from)
    if (!n) continue
    list.sort((a, b) => centerY(at.get(a.to) ?? n) - centerY(at.get(b.to) ?? n))
    spread(list, n.h, sOff)
  }
  for (const e of kept) {
    const n = at.get(e.from)
    if (n && e.fromRow !== undefined) sOff.set(e.id, rowAnchor(n, e.fromRow))
  }
  const inBy = groupBy(kept, (e) => e.to)
  for (const [to, list] of inBy) {
    const n = at.get(to)
    if (!n) continue
    const srcY = (e: TopoEdge): number => {
      const s = at.get(e.from)
      return s ? centerY(s) + (sOff.get(e.id) ?? 0) : 0
    }
    list.sort((a, b) => srcY(a) - srcY(b) || compare(a.id, b.id))
    // Mỗi cổng nguồn (thẻ + dòng luật) một điểm vào riêng ở đích — các đường chỉ gặp nhau ở thẻ
    // đích, không nhập vào nhau trước đó. Cạnh trùng cổng nguồn (hiếm) dùng chung điểm.
    const port = (e: TopoEdge): string => `${e.from}#${String(e.fromRow ?? '')}`
    const groups: TopoEdge[][] = []
    for (const e of list) {
      const g = groups.at(-1)
      if (g?.[0] && port(g[0]) === port(e)) g.push(e)
      else groups.push([e])
    }
    const offs = new Map<string, number>()
    spread(
      groups.map((g) => ({ id: g[0]?.id ?? '' })),
      n.h,
      offs
    )
    for (const g of groups) {
      const off = offs.get(g[0]?.id ?? '') ?? 0
      for (const e of g) tOff.set(e.id, off)
    }
  }
  // Đoạn dọc: mỗi cạnh một làn dọc riêng trong khe giữa hai cột (xem `routeChannels`).
  const gapOf = new Map<TopoLane, { from: number; to: number }>()
  columns.forEach((c, i) => {
    const next = columns[i + 1]
    gapOf.set(c.lane, { from: c.x + c.w, to: next ? next.x : c.x + c.w + 48 })
  })
  const wires: Wire[] = []
  for (const e of kept) {
    const s = at.get(e.from)
    const tg = at.get(e.to)
    if (!s || !tg || columnLane(s.lane) === columnLane(tg.lane)) continue
    if (tg.x - (s.x + s.w) <= 16) continue
    const sy = centerY(s) + (sOff.get(e.id) ?? 0)
    const ty = centerY(tg) + (tOff.get(e.id) ?? 0)
    if (Math.abs(ty - sy) < 0.5) continue
    wires.push({
      id: e.id,
      gap: columnLane(s.lane),
      sy,
      ty,
      sPort: `${e.from}#${String(e.fromRow ?? '')}`,
      tPort: `${e.to}@${String(tOff.get(e.id) ?? 0)}`
    })
  }
  const trackX = routeChannels(wires, gapOf)
  const edges: PlacedTopoEdge[] = kept.map((e) => {
    const s = at.get(e.from)
    const tg = at.get(e.to)
    const gap = s && tg ? Math.max(24, tg.x - (s.x + s.w)) : 60
    const tree = s && tg && columnLane(s.lane) === columnLane(tg.lane)
    const x = trackX.get(e.id)
    return {
      ...e,
      sOff: sOff.get(e.id) ?? 0,
      tOff: tOff.get(e.id) ?? 0,
      // Đường thẳng (không đoạn dọc) / đi lùi: giữ khoảng mặc định.
      bend: s && x !== undefined ? x - (s.x + s.w) : Math.min(28, gap / 3),
      ...(tree ? { tree: { sw: s.w, sh: s.h, th: tg.h } } : {})
    }
  })
  return { nodes: placed, edges, bands, columns, width, height }
}

/**
 * Làn Entry: mỗi Gateway kéo các route gắn vào nó (cùng hàng) xuống ngay dưới — đọc như cây,
 * không cần cột Route riêng. Thứ tự còn lại giữ nguyên (ổn định).
 */
function nestRoutes(stack: TopoNode[], parentOf: ReadonlyMap<string, string>): TopoNode[] {
  const ids = new Set(stack.map((n) => n.id))
  const children = new Map<string, TopoNode[]>()
  for (const n of stack) {
    const p = n.kind === 'route' ? parentOf.get(n.id) : undefined
    if (p && ids.has(p)) children.set(p, [...(children.get(p) ?? []), n])
  }
  const out: TopoNode[] = []
  for (const n of stack) {
    const p = n.kind === 'route' ? parentOf.get(n.id) : undefined
    if (p && ids.has(p)) continue
    out.push(n)
    if (n.kind === 'gateway') out.push(...(children.get(n.id) ?? []))
  }
  return out
}

/** Chia đều `list.length` điểm trên phần giữa của mép cao `h` (lệch so với tâm). */
function spread(list: readonly { id: string }[], h: number, out: Map<string, number>): void {
  const n = list.length
  if (!n) return
  const usable = Math.max(0, h - 24)
  const step = n > 1 ? Math.min(14, usable / (n - 1)) : 0
  const start = -((n - 1) * step) / 2
  list.forEach((e, i) => out.set(e.id, start + i * step))
}

/** Cạnh có đoạn dọc, cần một làn dọc (track) trong khe sau cột nguồn. */
export interface Wire {
  id: string
  /** Cột nguồn — khe ngay sau cột này chứa đoạn dọc. */
  gap: TopoLane
  sy: number
  ty: number
  /** Cổng nguồn (thẻ + dòng) / điểm vào ở đích. */
  sPort: string
  tPort: string
}

const lo = (w: Wire): number => Math.min(w.sy, w.ty)
const hi = (w: Wire): number => Math.max(w.sy, w.ty)
/** Khoảng đệm: hai đoạn dọc gần sát nhau (< 4 px) cũng coi là chồng. */
const WIRE_PAD = 4

/**
 * Hai cạnh không được dùng chung một làn dọc khi đoạn dọc của chúng chồng nhau. Ngoại lệ: chung
 * cổng nguồn (hoặc chung điểm vào ở đích) và đi ngược chiều — chỉ chạm nhau ở đúng cổng đó (rẽ nhánh).
 */
function wiresClash(a: Wire, b: Wire): boolean {
  if (lo(a) >= hi(b) + WIRE_PAD || lo(b) >= hi(a) + WIRE_PAD) return false
  const opposite = a.ty > a.sy !== b.ty > b.sy
  if (opposite && (a.sPort === b.sPort || a.tPort === b.tPort)) return false
  return true
}

/**
 * Số chỗ cắt khi `a` dùng làn bên trái `b` (đường ngang → dọc → ngang). Đoạn ngang cuối của `a`
 * cắt đoạn dọc của `b` khi `a.ty` nằm trong khoảng dọc của `b`; đoạn ngang đầu của `b` cắt đoạn
 * dọc của `a` khi `b.sy` nằm trong khoảng dọc của `a`. Chạm ở đầu mút (chung cổng) không tính.
 */
function crossLeft(a: Wire, b: Wire): number {
  return (lo(b) < a.ty && a.ty < hi(b) ? 1 : 0) + (lo(a) < b.sy && b.sy < hi(a) ? 1 : 0)
}

/** Nhóm lớn hơn thế này: bỏ bước chèn tối ưu (O(n²)), giữ thứ tự theo độ cao đích. */
const MAX_ORDERED_WIRES = 400

/**
 * Định tuyến trực giao trong từng khe giữa hai cột: mỗi cạnh một làn dọc riêng — hai cạnh khác
 * đích không bao giờ chung một đoạn dọc. Thứ tự làn (trái → phải) chọn để ít chỗ cắt nhất: xếp
 * theo độ cao đích rồi chèn từng cạnh vào vị trí ít cắt nhất (tham lam, tất định). Làn được dùng
 * lại khi đoạn dọc không chồng nhau (cạnh ở hàng / namespace khác). Trả về x tuyệt đối của làn.
 */
export function routeChannels(
  wires: readonly Wire[],
  gaps: ReadonlyMap<string, { from: number; to: number }>
): Map<string, number> {
  const out = new Map<string, number>()
  for (const [lane, list] of groupBy(wires, (w) => w.gap)) {
    const gap = gaps.get(lane)
    if (!gap) continue
    // Thứ tự gốc: theo đích (trên → dưới), rồi nguồn, rồi id — ổn định giữa các lần vẽ.
    const sorted = [...list].sort((a, b) => a.ty - b.ty || a.sy - b.sy || compare(a.id, b.id))
    // Tách thành các cụm có đoạn dọc chồng nhau (quét theo đầu trên) — mỗi cụm xếp làn riêng.
    const byTop = [...sorted].sort((a, b) => lo(a) - lo(b) || compare(a.id, b.id))
    const clusterOf = new Map<string, number>()
    let cluster = -1
    let reach = -Infinity
    for (const w of byTop) {
      if (lo(w) >= reach + WIRE_PAD) cluster++
      reach = Math.max(reach, hi(w))
      clusterOf.set(w.id, cluster)
    }
    for (const group of groupBy(sorted, (w) => String(clusterOf.get(w.id))).values()) {
      // Chèn tham lam: vị trí p làm tổng chỗ cắt với các cạnh đã xếp nhỏ nhất (hoà → cuối).
      let order: Wire[] = []
      if (group.length > MAX_ORDERED_WIRES) order = group
      else
        for (const w of group) {
          let cost = order.reduce((sum, x) => sum + crossLeft(x, w), 0)
          let best = cost
          let at = order.length
          for (let p = order.length - 1; p >= 0; p--) {
            const x = order[p]
            if (!x) continue
            cost += crossLeft(w, x) - crossLeft(x, w)
            if (cost < best) {
              best = cost
              at = p
            }
          }
          order = [...order.slice(0, at), w, ...order.slice(at)]
        }
      // Gán làn theo thứ tự: mỗi cạnh nằm bên phải mọi cạnh đã xếp mà nó chồng lên.
      const track = new Map<string, number>()
      let tracks = 0
      for (let i = 0; i < order.length; i++) {
        const w = order[i]
        if (!w) continue
        let k = 0
        for (let j = 0; j < i; j++) {
          const x = order[j]
          if (x && wiresClash(x, w)) k = Math.max(k, (track.get(x.id) ?? 0) + 1)
        }
        track.set(w.id, k)
        tracks = Math.max(tracks, k + 1)
      }
      // Làn chia đều quanh giữa khe, cách hai mép ≥ 12 px (chỗ cho góc bo + mũi tên).
      const left = gap.from + 12
      const right = Math.max(left, gap.to - 14)
      const step = tracks > 1 ? Math.min(10, (right - left) / (tracks - 1)) : 0
      const first = (left + right) / 2 - (step * (tracks - 1)) / 2
      for (const w of group) out.set(w.id, first + (track.get(w.id) ?? 0) * step)
    }
  }
  return out
}

/** Khoá cấu trúc (id node + cạnh + cỡ thẻ): cùng khoá → cùng bố cục. */
export function topoStructureKey(graph: Pick<TopoGraph, 'nodes' | 'edges'>): string {
  return `${graph.nodes
    .map((n) => `${n.id}:${String(n.row)}:${String(topoNodeHeight(n))}`)
    .sort()
    .join('\n')}\n--\n${graph.edges
    .map((e) => e.id)
    .sort()
    .join('\n')}`
}
