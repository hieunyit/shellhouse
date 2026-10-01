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
  namespaces: { name: string; active: boolean }[]
  workloads: MapWorkload[]
  pods: MapPod[]
  services: MapService[]
  routes: MapRoute[]
  pvcs: MapPvc[]
  hpas: MapHpa[]
  policies: MapPolicy[]
  nodes: { total: number; ready: number }
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

export type MapNodeKind = 'region' | 'namespace' | 'workload' | 'pod' | 'service' | 'route' | 'pvc'

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
}

export type MapEdgeKind = 'route' | 'select' | 'storage'

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
}

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

  for (const ns of nsNames) {
    const nsId = `n:${ns}`
    const children: MapNode[] = []
    // Hàng 1: route (Ingress / HTTPRoute…); hàng 2: service; hàng 3: workload; hàng 4: PVC.
    const workloads = data.workloads
      .filter((w) => w.ns === ns)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    // Service theo vị trí workload đích, route theo service đích, PVC theo workload dùng nó —
    // cạnh ngắn, ít cắt nhau (không có đích → cuối hàng, theo tên).
    const firstIndex = (indices: number[]): number =>
      indices.length ? Math.min(...indices) : Number.MAX_SAFE_INTEGER
    const services = orderBy(
      data.services.filter((x) => x.ns === ns),
      (svc) =>
        firstIndex(
          workloads.flatMap((w, i) => (selectorMatches(svc.selector, w.labels) ? [i] : []))
        )
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
    const rows = [routeNodes, serviceNodes, cards, pvcNodes].filter((r) => r.length > 0)
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
      ...routeNodes,
      ...serviceNodes,
      ...cards.map(withoutPods),
      ...podNodes,
      ...pvcNodes
    )

    // Cạnh: route → service → workload → PVC.
    for (const r of routes)
      for (const b of r.backends)
        if (services.some((s) => s.name === b))
          edges.push({ from: `r:${r.kind}:${ns}/${r.name}`, to: `s:${ns}/${b}`, kind: 'route' })
    for (const s of services)
      for (const w of workloads)
        if (selectorMatches(s.selector, w.labels))
          edges.push({
            from: `s:${ns}/${s.name}`,
            to: `w:${w.kind}:${ns}/${w.name}`,
            kind: 'select'
          })
    for (const w of workloads)
      for (const v of w.pvcs)
        if (pvcs.some((p) => p.name === v))
          edges.push({ from: `w:${w.kind}:${ns}/${w.name}`, to: `v:${ns}/${v}`, kind: 'storage' })

    islands.push({ ns, node, children, w, h })
  }

  // Vùng: đảo xếp kệ trong vùng; vùng xếp kệ trên toàn bản đồ.
  interface RegionBox extends Box {
    node: MapNode
    members: Island[]
    pos: { x: number; y: number }[]
  }
  const regions: RegionBox[] = []
  for (const region of REGIONS) {
    const members = islands.filter((i) => regionOf(i.ns) === region)
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
