import { MarkerType } from '@xyflow/react'
import type { MapLayout, MapNode } from '../shared/map'
import { bandOf } from '../shared/traffic'
import { sides, type Band, type MapFlowEdge } from './MapFlow'
import { EDGE_Z, type Palette } from './mapModel'

export interface TrafficLink {
  from: string
  to: string
  rate: number
}

/**
 * Cạnh cho React Flow: quan hệ cấu trúc (route → service → workload → PVC, policy) khi nhìn gần,
 * và đường traffic live. Hàm thuần — tách khỏi MapView để đọc / kiểm thử riêng.
 */
export function buildMapEdges({
  band,
  layout,
  byId,
  related,
  focusId,
  palette,
  structural,
  traffic
}: {
  band: Band
  layout: MapLayout | null
  byId: ReadonlyMap<string, MapNode>
  /** Mục liên quan tới mục đang chọn / trỏ (đường nổi bật). */
  related: ReadonlySet<string>
  focusId: string | null
  palette: Palette
  /** Vẽ quan hệ cấu trúc (tuỳ chọn Edges). */
  structural: boolean
  /** Traffic đã quy về node trên bản đồ (rỗng = tắt). */
  traffic: readonly TrafficLink[]
}): MapFlowEdge[] {
  const out: MapFlowEdge[] = []
  // Mũi tên cỡ cố định (không phình theo độ dày đường traffic).
  const arrow = (color: string): MapFlowEdge['markerEnd'] => ({
    type: MarkerType.ArrowClosed,
    color,
    width: 14,
    height: 14,
    markerUnits: 'userSpaceOnUse'
  })
  if (band === 'near' && structural && layout)
    for (const e of layout.edges) {
      const hot = related.has(e.from) && related.has(e.to)
      // Policy áp lên cả namespace → rất nhiều cạnh; chỉ vẽ đường của chính mục đang chọn.
      if (e.kind === 'policy' && !(hot && focusId && (e.from === focusId || e.to === focusId)))
        continue
      const color =
        e.kind === 'storage' ? palette.edgeMuted : e.kind === 'policy' ? palette.warn : palette.edge
      // Khác cột (vd. Ingress frontend → Service backend): nối cạnh bên → cạnh bên bằng đường
      // cong — thấy trọn đường đi, không chạy ngầm dưới thẻ.
      const sa = byId.get(e.from)
      const sb = byId.get(e.to)
      const cross =
        sa !== undefined && sb !== undefined && Math.abs(sa.x + sa.w / 2 - (sb.x + sb.w / 2)) > 24
      out.push({
        id: `${e.kind}:${e.from}>${e.to}`,
        source: e.from,
        target: e.to,
        ...(cross ? sides(sa, sb) : { sourceHandle: 'sb', targetHandle: 'tt' }),
        type: 'map',
        zIndex: EDGE_Z,
        data: {
          kind: e.kind,
          color,
          ...(cross ? { cross: true } : {}),
          ...(e.label ? { label: e.label } : {})
        },
        ...(e.kind === 'storage' || e.kind === 'policy' ? {} : { markerEnd: arrow(color) })
      })
    }
  if (traffic.length) {
    // Nhìn xa: khác namespace gộp thành đường giữa hai đảo. Nhìn gần / vừa: đường đúng từ thẻ
    // workload gọi tới thẻ workload nhận (cong, kể cả khác namespace) — thấy rõ ai gọi ai;
    // cùng namespace chỉ vẽ khi nhìn gần.
    const cross = new Map<string, { from: string; to: string; rate: number }>()
    const local: { from: string; to: string; rate: number; cross?: boolean }[] = []
    for (const tr of traffic) {
      const a = byId.get(tr.from)?.ns
      const b = byId.get(tr.to)?.ns
      if (!a || !b) continue
      if (a === b) {
        if (band === 'near' && tr.from !== tr.to) local.push(tr)
        continue
      }
      if (band !== 'far') {
        local.push({ ...tr, cross: true })
        continue
      }
      const key = `n:${a}>n:${b}`
      cross.set(key, {
        from: `n:${a}`,
        to: `n:${b}`,
        rate: (cross.get(key)?.rate ?? 0) + tr.rate
      })
    }
    const list = [...local, ...cross.values()]
    for (const t of list) {
      const color = palette.ramp[bandOf(t.rate)] ?? palette.edge
      const sa = byId.get(t.from)
      const sb = byId.get(t.to)
      // Thẻ ở hai namespace khác nhau (nhìn gần): đi vòng ra bên phải hai đảo rồi vào cạnh phải
      // thẻ đích — không cắt ngang tiêu đề đảo hay các thẻ khác trong làn.
      const loop =
        'cross' in t && t.cross && sa && sb && sa.kind !== 'namespace' && sb.kind !== 'namespace'
          ? loopOffset(sa, sb, byId)
          : 0
      out.push({
        id: `traffic:${t.from}>${t.to}`,
        source: t.from,
        target: t.to,
        ...(loop
          ? { sourceHandle: 'sr', targetHandle: 'tr' }
          : sa && sb
            ? sides(sa, sb)
            : { sourceHandle: 'sr', targetHandle: 'tl' }),
        type: 'map',
        // Dưới mọi thẻ (thẻ che phần đường đi qua) — không đè chữ.
        zIndex: EDGE_Z,
        data: {
          kind: 'traffic',
          rate: t.rate,
          color,
          ...('cross' in t && t.cross ? { cross: true } : {}),
          ...(loop ? { loop } : {})
        },
        markerEnd: arrow(color)
      })
    }
  }
  return out
}

/** Khoảng đi vòng sang phải (px) để vượt qua mép phải của cả hai đảo namespace. */
function loopOffset(a: MapNode, b: MapNode, byId: ReadonlyMap<string, MapNode>): number {
  const right = (n: MapNode): number => {
    const island = n.ns ? byId.get(`n:${n.ns}`) : undefined
    return island ? island.x + island.w : n.x + n.w
  }
  const edge = Math.max(right(a), right(b))
  return Math.max(48, edge + 40 - Math.max(a.x + a.w, b.x + b.w))
}
