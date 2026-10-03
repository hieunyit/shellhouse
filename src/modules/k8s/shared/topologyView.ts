import type { TopologyEdge, TopologyNode } from './ops'
import type { TopologyLayout } from './topology'

const edgeKey = (e: TopologyEdge): string => `${e.from}>${e.to}>${e.type}`

/**
 * Khoá cấu trúc của đồ thị (node + cạnh, không gồm nhãn / tóm tắt): cùng khoá → cùng bố cục.
 * Số traffic (nhãn cạnh "calls") đổi mỗi lần đọc nhưng không đổi khoá.
 */
export function topologyStructureKey(g: {
  nodes: readonly TopologyNode[]
  edges: readonly TopologyEdge[]
}): string {
  const nodes = g.nodes.map((n) => n.id).sort()
  const edges = g.edges.map(edgeKey).sort()
  return `${nodes.join('\n')}\n--\n${edges.join('\n')}`
}

/** Giữ vị trí của bố cục cũ, lấy nội dung (tóm tắt, nhãn cạnh, trạng thái) mới nhất. */
export function relabelLayout(
  base: TopologyLayout,
  g: { nodes: readonly TopologyNode[]; edges: readonly TopologyEdge[] }
): TopologyLayout {
  const latest = new Map(g.nodes.map((n) => [n.id, n]))
  const nodes = base.nodes.map((p) => {
    const n = latest.get(p.id)
    return n && n !== p ? { ...n, x: p.x, y: p.y } : p
  })
  const placed = new Set(nodes.map((n) => n.id))
  const edges = g.edges.filter((e) => placed.has(e.from) && placed.has(e.to))
  return { ...base, nodes, edges }
}
