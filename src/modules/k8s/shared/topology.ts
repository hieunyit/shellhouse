import type { TopologyEdge, TopologyEdgeType, TopologyNode, TopologyResult } from './ops'

/**
 * Bố cục đồ thị Object Topology: cột theo vai trò (traffic → workload → pod → node / phụ thuộc →
 * RBAC), thứ tự trong cột theo trọng tâm hàng xóm để ít cắt nhau. Thuần — test được.
 */

export type TopologyCategory = 'ownership' | 'network' | 'config' | 'scheduling' | 'policy' | 'rbac'

export const EDGE_CATEGORY: Record<TopologyEdgeType, TopologyCategory> = {
  owns: 'ownership',
  selects: 'network',
  routes: 'network',
  attaches: 'network',
  uses: 'config',
  mounts: 'config',
  bound: 'config',
  'runs-on': 'scheduling',
  scales: 'policy',
  protects: 'policy',
  isolates: 'policy',
  identity: 'rbac',
  subject: 'rbac',
  grants: 'rbac'
}

export const CATEGORY_LABEL: Record<TopologyCategory, string> = {
  ownership: 'Ownership',
  network: 'Traffic',
  config: 'Config & storage',
  scheduling: 'Scheduling',
  policy: 'Policies',
  rbac: 'Access (RBAC)'
}

/** Cột theo loại. */
const RANK: Record<string, number> = {
  'gateways.gateway.networking.k8s.io': 0,
  'ingresses.networking.k8s.io': 1,
  'httproutes.gateway.networking.k8s.io': 1,
  'grpcroutes.gateway.networking.k8s.io': 1,
  services: 2,
  'horizontalpodautoscalers.autoscaling': 2,
  'poddisruptionbudgets.policy': 2,
  'networkpolicies.networking.k8s.io': 2,
  'deployments.apps': 3,
  'statefulsets.apps': 3,
  'daemonsets.apps': 3,
  'cronjobs.batch': 3,
  'replicasets.apps': 4,
  'jobs.batch': 4,
  pods: 5,
  nodes: 6,
  configmaps: 6,
  secrets: 6,
  persistentvolumeclaims: 6,
  serviceaccounts: 6,
  persistentvolumes: 7,
  'rolebindings.rbac.authorization.k8s.io': 7,
  'clusterrolebindings.rbac.authorization.k8s.io': 7,
  'roles.rbac.authorization.k8s.io': 8,
  'clusterroles.rbac.authorization.k8s.io': 8
}

/** Thứ tự nhóm trong một cột (node trước, rồi config, storage, danh tính). */
const GROUP: Record<string, number> = {
  nodes: 0,
  configmaps: 1,
  secrets: 2,
  persistentvolumeclaims: 3,
  serviceaccounts: 4
}

export const TOPO_NODE_W = 196
export const TOPO_NODE_H = 48
const COL_GAP = 84
const ROW_GAP = 14
const TB_RANK_GAP = 56
const TB_SIBLING_GAP = 16

export interface PlacedNode extends TopologyNode {
  x: number
  y: number
}

/** lr: cột trái → phải (khung rộng); tb: hàng trên → dưới (khung hẹp / cao). */
export type TopologyDirection = 'lr' | 'tb'

export interface TopologyLayout {
  nodes: PlacedNode[]
  edges: TopologyEdge[]
  width: number
  height: number
  direction: TopologyDirection
}

/** Gộp đồ thị mở rộng vào đồ thị đang có (node cũ giữ nguyên, cạnh hợp). */
export function mergeTopology(base: TopologyResult, extra: TopologyResult): TopologyResult {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]))
  for (const n of extra.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n)
  const key = (e: TopologyEdge): string => `${e.from}>${e.to}>${e.type}`
  const edges = new Map(base.edges.map((e) => [key(e), e]))
  for (const e of extra.edges) if (!edges.has(key(e))) edges.set(key(e), e)
  return {
    root: base.root,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    notes: [...new Set([...base.notes, ...extra.notes])]
  }
}

/**
 * Lọc theo nhóm quan hệ: chỉ giữ cạnh thuộc nhóm đang bật, và node còn nối được tới gốc qua các
 * cạnh đó (bỏ nhánh treo).
 */
export function filterTopology(
  graph: TopologyResult,
  hidden: ReadonlySet<TopologyCategory>
): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
  const edges = graph.edges.filter((e) => !hidden.has(EDGE_CATEGORY[e.type]))
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from])
  }
  const seen = new Set([graph.root])
  const queue = [graph.root]
  while (queue.length) {
    const id = queue.shift() ?? ''
    for (const next of adj.get(id) ?? [])
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
  }
  return {
    nodes: graph.nodes.filter((n) => seen.has(n.id)),
    edges: edges.filter((e) => seen.has(e.from) && seen.has(e.to))
  }
}

export function layoutTopology(
  nodes: readonly TopologyNode[],
  edges: readonly TopologyEdge[],
  direction: TopologyDirection = 'lr'
): TopologyLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const neighbors = new Map<string, string[]>()
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    neighbors.set(e.from, [...(neighbors.get(e.from) ?? []), e.to])
    neighbors.set(e.to, [...(neighbors.get(e.to) ?? []), e.from])
  }
  // Cột: theo loại; nhóm gộp ("+N more") cạnh node nó gắn vào.
  const rank = new Map<string, number>()
  for (const n of nodes) if (n.kind in RANK) rank.set(n.id, RANK[n.kind] ?? 0)
  for (const n of nodes) {
    if (rank.has(n.id)) continue
    const e = edges.find((x) => x.from === n.id || x.to === n.id)
    const other = e ? (e.from === n.id ? e.to : e.from) : undefined
    const r = other !== undefined ? (rank.get(other) ?? 3) : 3
    rank.set(n.id, e && e.to === n.id ? r + 1 : Math.max(0, r - 1))
  }
  // Bỏ cột trống.
  const used = [...new Set(rank.values())].sort((p, q) => p - q)
  const colOf = new Map(used.map((r, i) => [r, i]))
  const columns: TopologyNode[][] = used.map(() => [])
  for (const n of nodes) columns[colOf.get(rank.get(n.id) ?? 0) ?? 0]?.push(n)
  for (const col of columns)
    col.sort(
      (p, q) =>
        (GROUP[p.kind] ?? 0) - (GROUP[q.kind] ?? 0) ||
        Number(p.kind === '') - Number(q.kind === '') ||
        p.name.localeCompare(q.name)
    )
  // Trọng tâm: vài lượt trái → phải rồi phải → trái.
  const index = new Map<string, number>()
  const reindex = (): void => {
    for (const col of columns) col.forEach((n, i) => index.set(n.id, i))
  }
  reindex()
  const sweep = (order: number[]): void => {
    for (const c of order) {
      const col = columns[c]
      if (!col || col.length < 2) continue
      const center = (n: TopologyNode): number => {
        const ns = (neighbors.get(n.id) ?? []).filter((id) => {
          const r = colOf.get(rank.get(id) ?? -1)
          return r !== undefined && r !== c
        })
        if (!ns.length) return index.get(n.id) ?? 0
        return ns.reduce((sum, id) => sum + (index.get(id) ?? 0), 0) / ns.length
      }
      const keyed = col.map((n, i) => ({ n, k: center(n), i }))
      keyed.sort(
        (p, q) => p.k - q.k || (GROUP[p.n.kind] ?? 0) - (GROUP[q.n.kind] ?? 0) || p.i - q.i
      )
      columns[c] = keyed.map((x) => x.n)
      reindex()
    }
  }
  const forward = columns.map((_, i) => i)
  for (let pass = 0; pass < 3; pass++) {
    sweep(forward)
    sweep([...forward].reverse())
  }
  // Bước theo cấp (along) và trong cùng cấp (cross).
  const lr = direction === 'lr'
  const along = lr ? TOPO_NODE_W + COL_GAP : TOPO_NODE_H + TB_RANK_GAP
  const cross = lr ? TOPO_NODE_H + ROW_GAP : TOPO_NODE_W + TB_SIBLING_GAP
  const longest = Math.max(1, ...columns.map((c) => c.length))
  const span = longest * cross - (cross - (lr ? TOPO_NODE_H : TOPO_NODE_W))
  const placed: PlacedNode[] = []
  columns.forEach((col, c) => {
    const len = col.length * cross - (cross - (lr ? TOPO_NODE_H : TOPO_NODE_W))
    const start = (span - len) / 2
    col.forEach((n, i) => {
      const a = c * along
      const b = start + i * cross
      placed.push({ ...n, x: lr ? a : b, y: lr ? b : a })
    })
  })
  const depth = columns.length * along - (along - (lr ? TOPO_NODE_W : TOPO_NODE_H))
  return {
    nodes: placed,
    edges: edges.filter((e) => byId.has(e.from) && byId.has(e.to)),
    width: lr ? depth : span,
    height: lr ? span : depth,
    direction
  }
}

/**
 * Phạm vi ảnh hưởng (blast radius) khi đổi một node: con của nó (owns), thứ nó điều khiển (HPA /
 * PDB / NetworkPolicy → workload), và mọi thứ dựa vào nó (dùng ConfigMap / Secret / PVC, chạy trên
 * node, đi traffic qua nó, mang danh tính / quyền của nó) — lan tiếp theo cùng quy tắc.
 */
export function dependentsOf(graph: { edges: readonly TopologyEdge[] }, id: string): Set<string> {
  const downstream = new Set<TopologyEdgeType>(['owns', 'scales', 'protects', 'isolates'])
  const out = new Set<string>()
  const queue = [id]
  while (queue.length) {
    const cur = queue.shift() ?? ''
    for (const e of graph.edges) {
      const next = downstream.has(e.type)
        ? e.from === cur
          ? e.to
          : null
        : e.to === cur
          ? e.from
          : null
      if (next && next !== id && !out.has(next)) {
        out.add(next)
        queue.push(next)
      }
    }
  }
  return out
}
