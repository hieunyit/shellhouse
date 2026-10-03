import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { ChevronRight, Maximize2, Minus, Plus, Search, X } from 'lucide-react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { cx } from '../../../renderer/src/components/ui'
import {
  BANDS,
  WORKLOAD_KIND_ID,
  bandOf,
  flowGraph,
  layoutFlow,
  peerKey,
  type FlowGraph,
  type FlowLayout,
  type FlowLayoutOptions,
  type FlowNode,
  type TrafficPeer,
  type TrafficRate
} from '../shared/traffic'
import { sides } from './MapFlow'
import type { MapRef } from './mapModel'
import { KindIcon } from './icons'
import { formatRelative, t, tn } from '../../registry/renderer-kit'
import { CARETTA_INSTALL, useElementWidth } from './MapControls'
import { trafficText } from './topology/text'
import type { TrafficState } from './useTraffic'

/**
 * Service map dựng từ Caretta: workload của các namespace đang chọn là node riêng, bên ngoài phạm
 * vi gộp theo namespace, địa chỉ ngoài cluster gộp "External (N)" (mở ra khi cần), đường idle ẩn,
 * chỉ giữ các đường lớn nhất. Trái → phải theo hướng gọi; bấm node → làm nổi đường vào / ra và bảng
 * tốc độ theo từng bên. Cùng thành phần đồ thị dùng cho bản đồ nhỏ trong tab Traffic của workload.
 */

/** Kind Caretta → id loại (icon, mở chi tiết). */
const PEER_KIND_ID: Record<string, string> = {
  ...WORKLOAD_KIND_ID,
  Pod: 'pods',
  Service: 'services',
  Node: 'nodes'
}

/** Bản đồ đầy đủ: thẻ đủ rộng cho tên dài, chữ ≥ 11px ở zoom mặc định (≥ 0.92). */
const MAP_LAYOUT: FlowLayoutOptions = {
  nodeW: 216,
  nodeH: 66,
  colGap: 88,
  rowGap: 12,
  maxRows: 7
}
const MIN_ZOOM_DEFAULT = 0.9
/** Số đường vẽ mặc định (lớn nhất theo tốc độ); "+N" để xem thêm. */
const TOP_EDGES = 30
/** Chiều cao tối thiểu lớp thanh công cụ nổi (khung hẹp: xuống dòng → đo thật). */
const TOOLBAR_H = 48
const LEGEND_H = 34
/** Màu theo băng / idle: token CSS của bản đồ (tự theo theme và nền tối riêng của canvas). */
const RAMP = ['var(--map-t0)', 'var(--map-t1)', 'var(--map-t2)', 'var(--map-t3)', 'var(--map-t4)']
const IDLE = 'var(--map-edge-muted)'

/** Trạng thái thay đổi thường (chọn, rê chuột, tìm) đi qua context — mảng node giữ nguyên. */
interface FlowCtx {
  selected: string | null
  related: ReadonlySet<string>
  hoverEdge: string | null
  matches: ReadonlySet<string> | null
  compact: boolean
  /** Phạm vi đúng một namespace: thẻ workload của nó không nhắc lại namespace. */
  homeNs: string | null
  /** Nhãn tốc độ luôn hiện (bản đồ nhỏ, ít đường). */
  labels: boolean
  onExpand: (id: string) => void
}
const FlowContext = createContext<FlowCtx | null>(null)
const useFlow = (): FlowCtx => {
  const c = useContext(FlowContext)
  if (!c) throw new Error('FlowContext missing')
  return c
}

type FNode = Node<{ n: FlowNode; rate?: number }, 'flow'>
type FEdge = Edge<{ rate: number; color: string; idle: boolean; ports: string[] }, 'flow'>

function Globe({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0 text-muted" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M3 12h18M12 3c3 2.7 3 15.3 0 18M12 3c-3 2.7-3 15.3 0 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
}

/** Tiêu đề node (dịch lúc render — node gộp không có tên từ server). */
export function flowTitle(n: FlowNode): string {
  if (n.kind === 'more') return tn(n.members.length, '+{n} more', '+{n} more')
  if (n.kind === 'external' && !n.label)
    return n.side === 'in' ? t('External clients') : t('External')
  return n.label
}

/** Dòng phụ: chỗ ở / số thành viên. */
export function flowSubtitle(n: FlowNode): string {
  const count = n.members.length
  switch (n.kind) {
    case 'namespace':
      return `${tn(count, '{n} workload', '{n} workloads')} · ${t('outside scope')}`
    case 'external':
      return n.peer ? t('outside the cluster') : tn(count, '{n} address', '{n} addresses')
    case 'more':
      return t('smaller peers')
    default:
      return n.peer?.ns ? `${n.peer.ns} · ${n.peer.kind}` : (n.peer?.kind ?? '')
  }
}

function NodeIcon({ n, size }: { n: FlowNode; size: number }): React.JSX.Element {
  if (n.kind === 'external') return <Globe size={size} />
  if (n.kind === 'namespace') return <KindIcon kind="namespaces" size={size} />
  if (n.kind === 'more')
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-subtle text-muted"
        style={{ width: size, height: size }}
      >
        <Plus size={size * 0.6} />
      </span>
    )
  return <KindIcon kind={PEER_KIND_ID[n.peer?.kind ?? ''] ?? 'pods'} size={size} />
}

const FlowNodeView = memo(function FlowNodeView({ data }: NodeProps<FNode>): React.JSX.Element {
  const ctx = useFlow()
  const { n } = data
  const title = flowTitle(n)
  const group = !n.peer
  const dim =
    (ctx.related.size > 0 && !ctx.related.has(n.id)) ||
    (ctx.matches !== null && !ctx.matches.has(n.id))
  // Dòng phụ: workload trong phạm vi một namespace không nhắc lại namespace.
  const sub = n.peer
    ? n.peer.kind === 'external'
      ? ctx.compact
        ? ''
        : t('outside the cluster')
      : n.peer.ns === ctx.homeNs || !n.peer.ns
        ? n.peer.kind
        : ctx.compact
          ? n.peer.ns
          : `${n.peer.ns} · ${n.peer.kind}`
    : flowSubtitle(n)
  const tip = n.peer
    ? `${n.peer.ns ? `${n.peer.ns}/` : ''}${n.peer.name} (${n.peer.kind === 'external' ? t('external') : n.peer.kind})`
    : `${title} — ${flowSubtitle(n)}`
  const shell = cx(
    'k8s-card flex size-full items-center rounded-[11px] transition-opacity',
    ctx.selected === n.id && 'k8s-focus',
    n.focus && 'k8s-focus',
    dim && 'k8s-dim',
    !dim && !n.active && !n.focus && 'opacity-75'
  )
  const common = {
    style: n.scoped ? undefined : { borderStyle: 'dashed' as const },
    'data-testid': 'k8s-traffic-node',
    'data-name': n.peer?.name ?? title,
    'data-kind': n.kind,
    'data-id': n.id,
    title: tip
  }
  if (ctx.compact)
    return (
      <div className={cx(shell, 'gap-1.5 px-2')} {...common}>
        {n.kind === 'external' && <Globe size={13} />}
        <div className="min-w-0 flex-1 leading-[15px]">
          <div className="truncate text-[12px] font-medium text-fg">
            {title}
            {group && n.kind !== 'more' && (
              <span className="font-normal text-faint"> ({n.members.length})</span>
            )}
          </div>
          <div className="truncate text-[11px] text-faint tabular-nums">
            {data.rate !== undefined ? trafficText(data.rate) : sub}
          </div>
        </div>
        <Handles />
      </div>
    )
  return (
    <div className={cx(shell, 'gap-2.5 px-3')} {...common}>
      <NodeIcon n={n} size={18} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[14px] leading-[18px] font-medium text-fg">
          <span
            className={cx('min-w-0 truncate', (n.peer || n.kind === 'namespace') && 'font-mono')}
          >
            {title}
          </span>
          {n.expandable && (
            <button
              type="button"
              className="nodrag nopan flex shrink-0 items-center rounded bg-subtle pr-0.5 pl-1 text-[11px] leading-4 font-semibold text-muted tabular-nums hover:bg-hover hover:text-fg"
              title={t('Expand')}
              aria-label={t('Expand {name}', { name: title })}
              data-testid="k8s-traffic-expand"
              onClick={(e) => {
                e.stopPropagation()
                ctx.onExpand(n.id)
              }}
            >
              {n.members.length}
              <ChevronRight size={12} />
            </button>
          )}
        </div>
        {/* Ba dòng: tên · chỗ ở · tốc độ — không dòng nào phải nhường chỗ (cắt chữ) cho dòng khác. */}
        <div className="truncate text-[12px] leading-4 text-faint">{sub}</div>
        <div className="flex gap-2.5 overflow-hidden text-[12px] leading-4 whitespace-nowrap text-muted tabular-nums">
          {n.inRate >= 1 && <span title={t('Received')}>↓ {trafficText(n.inRate)}</span>}
          {n.outRate >= 1 && <span title={t('Sent')}>↑ {trafficText(n.outRate)}</span>}
          {!n.active && <span className="text-faint">{t('idle')}</span>}
        </div>
      </div>
      <Handles />
    </div>
  )
})

function Handles(): React.JSX.Element {
  const cls = '!pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'
  return (
    <>
      {(
        [
          ['l', Position.Left],
          ['r', Position.Right],
          ['t', Position.Top],
          ['b', Position.Bottom]
        ] as const
      ).map(([id, pos]) => (
        // Fragment (không bọc span): span là phần tử flex → cộng thêm khoảng gap, tên bị cắt sớm.
        <Fragment key={id}>
          <Handle id={`s${id}`} type="source" position={pos} className={cls} />
          <Handle id={`t${id}`} type="target" position={pos} className={cls} />
        </Fragment>
      ))}
    </>
  )
}

/** Độ dày theo băng (mảnh hơn bản đồ workload: nhiều đường song song vẫn tách bạch). */
const WIDTHS = [1.4, 2.2, 3.2, 4.4, 5.8, 7.4]

/** Điểm trên đường cong bậc ba ngang (điều khiển ở giữa như getBezierPath) tại hoành độ x. */
function pointAtX(sx: number, sy: number, tx: number, ty: number, x: number): [number, number] {
  const mx = (sx + tx) / 2
  const at = (t: number): [number, number] => {
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const c = 3 * u * t * t
    const d = t * t * t
    return [a * sx + (b + c) * mx + d * tx, (a + b) * sy + (c + d) * ty]
  }
  let lo = 0
  let hi = 1
  const up = tx >= sx
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (at(mid)[0] < x === up) lo = mid
    else hi = mid
  }
  return at((lo + hi) / 2)
}

const FlowEdgeView = memo(function FlowEdgeView(props: EdgeProps<FEdge>): React.JSX.Element {
  const ctx = useFlow()
  const d = props.data
  const [path, mx, my] = getBezierPath(props)
  const focusing = ctx.related.size > 0
  const hot =
    focusing &&
    ctx.selected !== null &&
    (props.source === ctx.selected || props.target === ctx.selected)
  const hovered = ctx.hoverEdge === props.id
  const faded = (focusing && !hot) || (ctx.matches !== null && !hovered)
  const band = bandOf(d?.rate ?? 0)
  const width = d?.idle ? 1.4 : (WIDTHS[band] ?? 1.4)
  const color = d?.color ?? 'currentColor'
  const showLabel = hovered || hot || ctx.labels
  // Nhãn của đường đang làm nổi đặt sát đầu BÊN KIA (không chụm cả chục nhãn quanh node đang chọn,
  // không đè lên thẻ ở cột giữa khi đường vượt cột).
  let lx = mx
  let ly = my
  const horizontal =
    (props.sourcePosition === Position.Right && props.targetPosition === Position.Left) ||
    (props.sourcePosition === Position.Left && props.targetPosition === Position.Right)
  if (hot && !hovered && horizontal) {
    const dx = props.targetX - props.sourceX
    const off = Math.sign(dx) * Math.min(46, Math.abs(dx) / 2)
    ;[lx, ly] = pointAtX(
      props.sourceX,
      props.sourceY,
      props.targetX,
      props.targetY,
      props.target === ctx.selected ? props.sourceX + off : props.targetX - off
    )
  }
  return (
    <g
      data-testid="k8s-traffic-edge"
      data-source={props.source}
      data-target={props.target}
      data-idle={d?.idle ? 'true' : 'false'}
      style={{
        opacity: faded ? 0.08 : d?.idle && !hot && !hovered ? 0.75 : 1,
        transition: 'opacity 160ms ease'
      }}
    >
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={14}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
        style={{
          stroke: color,
          strokeWidth: hovered || hot ? width + 0.8 : width,
          // Đường rất nhỏ (< 1 KB/s) nhạt hơn: đường chính nổi lên, đường scrape / DNS lùi lại.
          strokeOpacity: hot || hovered ? 1 : band === 0 && !d?.idle ? 0.5 : 0.9,
          strokeLinecap: 'round',
          ...(d?.idle ? { strokeDasharray: '4 4' } : {})
        }}
      />
      {showLabel && d && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded-md border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-fg tabular-nums shadow"
            style={{
              transform: `translate(-50%, -50%) translate(${String(lx)}px, ${String(ly)}px)`,
              background: 'var(--map-card)',
              borderColor: color,
              zIndex: hovered ? 1002 : 1001
            }}
            data-testid="k8s-traffic-edge-label"
          >
            {trafficText(d.rate)}
            {hovered && d.ports.length > 0 && (
              <span className="ml-1 font-normal text-faint">
                :{d.ports.slice(0, 3).join(', :')}
                {d.ports.length > 3 ? '…' : ''}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  )
})

const NODE_TYPES = { flow: FlowNodeView }
const EDGE_TYPES = { flow: FlowEdgeView }

/** Node / cạnh React Flow từ đồ thị đã xếp chỗ. */
function toFlow(
  graph: FlowGraph,
  layout: FlowLayout,
  rateOf?: (n: FlowNode) => number | undefined
): { nodes: FNode[]; edges: FEdge[] } {
  const nodes: FNode[] = []
  for (const n of graph.nodes) {
    const p = layout.nodes.get(n.id)
    if (!p) continue
    const rate = rateOf?.(n)
    nodes.push({
      id: n.id,
      type: 'flow',
      position: { x: p.x, y: p.y },
      width: p.w,
      height: p.h,
      data: { n, ...(rate !== undefined ? { rate } : {}) },
      draggable: false,
      selectable: false,
      connectable: false
    })
  }
  const edges: FEdge[] = []
  for (const e of graph.edges) {
    const a = layout.nodes.get(e.from)
    const b = layout.nodes.get(e.to)
    if (!a || !b) continue
    const idle = e.rate < 1
    const color = idle ? IDLE : (RAMP[Math.min(bandOf(e.rate), RAMP.length - 1)] ?? IDLE)
    edges.push({
      id: e.id,
      source: e.from,
      target: e.to,
      ...sides(a, b),
      type: 'flow',
      data: { rate: e.rate, color, idle, ports: e.ports },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
        width: 13,
        height: 13,
        markerUnits: 'userSpaceOnUse'
      }
    })
  }
  return { nodes, edges }
}

export function TrafficMap(props: {
  traffic: TrafficState
  /** Namespace đang chọn ở bộ chọn namespace ([] = mọi namespace) — phạm vi mặc định. */
  scope: readonly string[]
  onOpen: (ref: MapRef) => void
}): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <TrafficMapInner {...props} />
    </ReactFlowProvider>
  )
}

function TrafficMapInner({
  traffic,
  scope,
  onOpen
}: {
  traffic: TrafficState
  scope: readonly string[]
  onOpen: (ref: MapRef) => void
}): React.JSX.Element {
  const rf = useReactFlow<FNode, FEdge>()
  const [selected, setSelected] = useState<string | null>(null)
  const [showIdle, setShowIdle] = useState(false)
  const [allNs, setAllNs] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [limit, setLimit] = useState(TOP_EDGES)
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  const toolbarEl = useRef<HTMLDivElement>(null)
  /** React Flow đã sẵn sàng (đặt khung nhìn trước lúc này không có tác dụng). */
  const [ready, setReady] = useState(false)
  const [canvasRef, canvasWidth] = useElementWidth()
  const scopeKey = scope.join(',')
  const effScope = useMemo(
    () => (allNs ? [] : scopeKey ? scopeKey.split(',') : []),
    [allNs, scopeKey]
  )
  // Đổi phạm vi → bỏ chọn / mở rộng của phạm vi cũ (đặt lại ngay lúc render, không qua effect).
  const scopeId = `${scopeKey}#${String(allNs)}`
  const [seenScope, setSeenScope] = useState(scopeId)
  if (seenScope !== scopeId) {
    setSeenScope(scopeId)
    setSelected(null)
    setExpanded(new Set())
    setLimit(TOP_EDGES)
  }

  const graph = useMemo(
    () => flowGraph(traffic.rates, { scope: effScope, expanded, showIdle, limit }),
    [traffic.rates, effScope, expanded, showIdle, limit]
  )
  // Toàn cluster có kết nối nhưng phạm vi không có → gợi ý xem mọi namespace.
  const clusterHasLinks = traffic.rates.length > 0
  const layout = useMemo(() => layoutFlow(graph, MAP_LAYOUT), [graph])
  const flow = useMemo(() => toFlow(graph, layout), [graph, layout])
  // Canvas bị gỡ (phạm vi trống) → lần gắn lại đợi onInit mới.
  if (ready && !graph.nodes.length) setReady(false)
  const byId = useMemo(() => new Map(graph.allNodes.map((n) => [n.id, n])), [graph])
  // Chọn node đã biến mất (gập lại / ra khỏi top-N) → bỏ chọn.
  const sel = selected ? byId.get(selected) : undefined
  const related = useMemo(() => {
    const set = new Set<string>()
    if (!sel) return set
    set.add(sel.id)
    for (const e of graph.edges) {
      if (e.from === sel.id) set.add(e.to)
      if (e.to === sel.id) set.add(e.from)
    }
    return set
  }, [sel, graph])
  const q = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!q) return null
    const set = new Set<string>()
    for (const n of graph.nodes)
      if (
        flowTitle(n).toLowerCase().includes(q) ||
        n.members.some((m) => `${m.peer.ns}/${m.peer.name}`.toLowerCase().includes(q))
      )
        set.add(n.id)
    return set
  }, [q, graph])

  /** Vừa mở node gộp này → đưa các node con vào giữa khung (chúng có thể ở ngoài màn hình). */
  const reveal = useRef<string | null>(null)
  const expand = useCallback((id: string) => {
    reveal.current = id
    setExpanded((prev) => new Set([...prev, id]))
  }, [])
  const collapse = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      // Gập cả các nhóm con đã mở bên trong.
      for (const k of prev) if (k === id || k.startsWith(`${id}:`)) next.delete(k)
      return next
    })
    setSelected(id)
  }, [])

  // Đường của node đang chọn vẽ trên các thẻ (thấy trọn đường đi khi vượt cột).
  const edges = useMemo(
    () =>
      sel
        ? flow.edges.map((e) =>
            e.source === sel.id || e.target === sel.id ? { ...e, zIndex: 1000 } : e
          )
        : flow.edges,
    [flow.edges, sel]
  )
  const ctx = useMemo<FlowCtx>(
    () => ({
      selected: sel?.id ?? null,
      related,
      hoverEdge,
      matches,
      compact: false,
      homeNs: effScope.length === 1 ? (effScope[0] ?? null) : null,
      labels: false,
      onExpand: expand
    }),
    [sel, related, hoverEdge, matches, expand, effScope]
  )

  // Đặt khung nhìn khi cấu trúc đổi (không theo từng lượt tốc độ — kéo / zoom của người dùng giữ
  // nguyên): zoom đủ đọc (chữ ≥ 11px); đồ thị lớn hơn khung → canh trái / trên (bên gọi tới ở đầu),
  // kéo để xem phần còn lại. Chọn node nằm ngoài khung (vd. bảng bên phải vừa mở) → đưa vào giữa.
  const structure = graph.nodes.map((n) => n.id).join('|')
  const lastView = useRef({ structure: '', sel: '', width: 0 })
  const selId = sel?.id ?? ''
  useEffect(() => {
    const el = wrap.current
    const lay = layout
    if (!el || !lay.width || !ready) return
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    // Thanh công cụ nổi có thể xuống dòng (khung hẹp) — đặt đồ thị dưới phần nó thật sự chiếm.
    const bar = toolbarEl.current?.getBoundingClientRect()
    const top = Math.max(TOOLBAR_H, bar ? bar.bottom - r.top + 8 : 0)
    const structural = lastView.current.structure !== structure
    // Đổi bề ngang (bảng bên phải mở / đóng) chỉ giữ node đang chọn trong khung — không đặt lại.
    if (!structural && lastView.current.sel === selId && lastView.current.width === canvasWidth)
      return
    lastView.current = { structure, sel: selId, width: canvasWidth }
    let vp = rf.getViewport()
    if (structural) {
      const pad = 28
      const availH = r.height - top - LEGEND_H - pad
      const fit = Math.min((r.width - pad * 2) / lay.width, availH / lay.height)
      const zoom = Math.max(MIN_ZOOM_DEFAULT, Math.min(1.1, fit))
      const w = lay.width * zoom
      const h = lay.height * zoom
      vp = {
        zoom,
        x: w <= r.width - pad * 2 ? (r.width - w) / 2 : pad,
        y: h <= availH ? top + (availH - h) / 2 + pad / 2 : top + pad / 2
      }
    }
    const opened = reveal.current
    reveal.current = null
    const kids = opened
      ? graph.nodes.filter((n) => n.parent === opened || n.parent?.startsWith(`${opened}:`))
      : []
    const boxes = kids.flatMap((n) => {
      const b = lay.nodes.get(n.id)
      return b ? [b] : []
    })
    if (boxes.length) {
      const x0 = Math.min(...boxes.map((b) => b.x))
      const x1 = Math.max(...boxes.map((b) => b.x + b.w))
      const y0 = Math.min(...boxes.map((b) => b.y))
      const y1 = Math.max(...boxes.map((b) => b.y + b.h))
      vp = {
        zoom: vp.zoom,
        x: r.width / 2 - ((x0 + x1) / 2) * vp.zoom,
        y: r.height / 2 - ((y0 + y1) / 2) * vp.zoom
      }
    }
    const p = selId && !boxes.length ? lay.nodes.get(selId) : undefined
    if (p) {
      const left = p.x * vp.zoom + vp.x
      const y0 = p.y * vp.zoom + vp.y
      if (
        left < 8 ||
        left + p.w * vp.zoom > r.width - 8 ||
        y0 < top ||
        y0 + p.h * vp.zoom > r.height - LEGEND_H
      )
        vp = {
          zoom: vp.zoom,
          x: r.width / 2 - (p.x + p.w / 2) * vp.zoom,
          y: r.height / 2 - (p.y + p.h / 2) * vp.zoom
        }
    }
    void rf.setViewport(vp, { duration: 200 })
    // layout đổi mỗi lượt tốc độ — chặn ở trên (chỉ chạy khi cấu trúc / mục chọn đổi).
  }, [structure, selId, canvasWidth, layout, graph, rf, ready])

  // Chọn (tìm, bảng bên phải): khung nhìn tự đưa node vào nếu nó đang ở ngoài (effect ở trên).
  const focusNode = (id: string): void => {
    setSelected(id)
  }

  if (traffic.status === 'unavailable')
    return (
      <Empty>
        <span className="block text-[13px] font-medium text-fg">{t('No live traffic data')}</span>
        <span className="mt-1 block">
          {t(
            '{reason}. The service map is drawn from Caretta (eBPF) — no Prometheus or sidecars needed. The Topology view works without it.',
            {
              reason: traffic.reason ?? t('Caretta is not installed')
            }
          )}
        </span>
        <code className="mt-3 block rounded-md bg-subtle px-2 py-1.5 text-left font-mono text-[11px] break-all text-fg select-all">
          {CARETTA_INSTALL}
        </code>
      </Empty>
    )
  if (traffic.status !== 'live')
    return (
      <Empty>
        <span className="block text-[13px] font-medium text-fg">
          {t('Measuring traffic from Caretta…')}
        </span>
        <span className="mt-1 block">{t('Rates appear after two samples (a few seconds).')}</span>
      </Empty>
    )
  if (!clusterHasLinks)
    return (
      <Empty>
        <span className="block text-[13px] font-medium text-fg">{t('No connections yet')}</span>
        <span className="mt-1 block">
          {t('Caretta is running but saw no connections in the last minute.')}
        </span>
      </Empty>
    )

  const scopeLabel = !effScope.length
    ? t('All namespaces')
    : effScope.length <= 2
      ? effScope.join(', ')
      : tn(effScope.length, '{n} namespace', '{n} namespaces')

  return (
    <div className="flex min-h-0 flex-1" data-testid="k8s-traffic-map">
      <div ref={wrap} className="relative min-w-0 flex-1">
        <div ref={canvasRef} className="absolute inset-0">
          {/* Thanh công cụ nổi: phạm vi, tìm, idle, top-N. */}
          <div
            ref={toolbarEl}
            className="pointer-events-none absolute inset-x-2 top-2 z-10 flex flex-wrap items-center gap-2"
          >
            <div
              className="pointer-events-auto flex h-8 items-center gap-1 rounded-md border border-line bg-surface/95 pr-1 pl-2 text-xs shadow-sm"
              data-testid="k8s-traffic-scope"
              data-scope={effScope.join(',')}
              title={effScope.length > 1 ? effScope.join(', ') : undefined}
            >
              <KindIcon kind="namespaces" size={14} />
              <span className="text-faint">{t('Scope')}</span>
              <span className="max-w-48 truncate font-medium text-fg">{scopeLabel}</span>
              {scopeKey && (
                <button
                  type="button"
                  className="ml-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-hover"
                  data-testid="k8s-traffic-scope-toggle"
                  onClick={() => {
                    setAllNs(!allNs)
                  }}
                >
                  {allNs ? t('Only selected') : t('All namespaces')}
                </button>
              )}
            </div>
            <label className="pointer-events-auto flex h-8 w-48 items-center gap-1.5 rounded-md border border-line bg-surface/95 px-2 text-xs shadow-sm focus-within:border-accent">
              <Search size={13} className="shrink-0 text-faint" />
              <input
                value={query}
                placeholder={t('Find service…')}
                aria-label={t('Find service')}
                className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-faint"
                data-testid="k8s-traffic-search"
                onChange={(e) => {
                  setQuery(e.target.value)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matches?.size) {
                    const first = graph.nodes.find((n) => matches.has(n.id))
                    if (first) focusNode(first.id)
                  }
                  if (e.key === 'Escape') setQuery('')
                }}
              />
              {query && (
                <button
                  type="button"
                  aria-label={t('Clear')}
                  className="text-faint hover:text-fg"
                  onClick={() => {
                    setQuery('')
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </label>
            {(graph.hiddenIdle > 0 || showIdle) && !graph.allIdle && (
              <button
                type="button"
                aria-pressed={showIdle}
                data-testid="k8s-traffic-show-idle"
                className={cx(
                  'pointer-events-auto h-8 rounded-md border px-2.5 text-xs font-medium shadow-sm',
                  showIdle
                    ? 'border-accent bg-accent-soft text-fg'
                    : 'border-line bg-surface/95 text-muted hover:text-fg'
                )}
                onClick={() => {
                  setShowIdle(!showIdle)
                }}
              >
                {showIdle
                  ? t('Hide idle')
                  : tn(graph.hiddenIdle, 'Show idle ({n})', 'Show idle ({n})')}
              </button>
            )}
            {(graph.hiddenMore > 0 || limit > TOP_EDGES) && (
              <button
                type="button"
                data-testid="k8s-traffic-more"
                className="pointer-events-auto h-8 rounded-md border border-line bg-surface/95 px-2.5 text-xs font-medium text-muted shadow-sm hover:text-fg"
                onClick={() => {
                  setLimit(graph.hiddenMore > 0 ? Number.POSITIVE_INFINITY : TOP_EDGES)
                }}
              >
                {graph.hiddenMore > 0
                  ? tn(graph.hiddenMore, '+{n} more connection', '+{n} more connections')
                  : tn(TOP_EDGES, 'Top {n} only', 'Top {n} only')}
              </button>
            )}
            {expanded.size > 0 && (
              <button
                type="button"
                data-testid="k8s-traffic-collapse-all"
                className="pointer-events-auto h-8 rounded-md border border-line bg-surface/95 px-2.5 text-xs font-medium text-muted shadow-sm hover:text-fg"
                onClick={() => {
                  setExpanded(new Set())
                }}
              >
                {t('Collapse all')}
              </button>
            )}
          </div>
          {graph.allIdle && (
            <div
              className="pointer-events-none absolute inset-x-0 top-12 z-10 flex justify-center"
              data-testid="k8s-traffic-all-idle"
            >
              <span className="rounded-md border border-line bg-surface/95 px-2.5 py-1 text-xs text-muted shadow-sm">
                {t(
                  'No traffic in the last minute — showing the connections Caretta has seen, dimmed.'
                )}
              </span>
            </div>
          )}
          {!graph.nodes.length ? (
            <Empty>
              <span className="block text-[13px] font-medium text-fg">
                {t('No connections in {scope}', { scope: scopeLabel })}
              </span>
              <span className="mt-1 block">
                {t('Caretta saw traffic elsewhere in the cluster, but none to or from this scope.')}
              </span>
              {effScope.length > 0 && (
                <button
                  type="button"
                  className="mt-3 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-fg hover:bg-hover"
                  data-testid="k8s-traffic-scope-all"
                  onClick={() => {
                    setAllNs(true)
                  }}
                >
                  {t('Show all namespaces')}
                </button>
              )}
            </Empty>
          ) : (
            <FlowContext.Provider value={ctx}>
              <ReactFlow<FNode, FEdge>
                nodes={flow.nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                minZoom={0.15}
                maxZoom={2.5}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
                onInit={() => {
                  setReady(true)
                }}
                onNodeClick={(_, n) => {
                  setSelected(n.id === selected ? null : n.id)
                }}
                onNodeDoubleClick={(_, n) => {
                  const node = byId.get(n.id)
                  if (node?.expandable) {
                    expand(node.id)
                    return
                  }
                  const p = node?.peer
                  const kind = p ? WORKLOAD_KIND_ID[p.kind] : undefined
                  if (p && kind) onOpen({ kind, ns: p.ns, name: p.name })
                }}
                onEdgeMouseEnter={(_, e) => {
                  setHoverEdge(e.id)
                }}
                onEdgeMouseLeave={() => {
                  setHoverEdge(null)
                }}
                onPaneClick={() => {
                  setSelected(null)
                }}
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
              </ReactFlow>
            </FlowContext.Provider>
          )}
          <Legend
            onZoom={(dir) => {
              if (dir === 'fit') void rf.fitView({ padding: 0.06, duration: 250 })
              else if (dir === 'in') void rf.zoomIn({ duration: 150 })
              else void rf.zoomOut({ duration: 150 })
            }}
            stats={[
              tn(
                graph.nodes.filter((n) => n.kind === 'peer').length,
                '{n} service',
                '{n} services'
              ),
              tn(graph.edges.length, '{n} connection', '{n} connections'),
              tn(traffic.agents, '{n} Caretta agent', '{n} Caretta agents'),
              t('updated {when}', { when: formatRelative(traffic.updated) })
            ].join(' · ')}
          />
        </div>
      </div>
      {sel && (
        <Panel
          node={sel}
          graph={graph}
          byId={byId}
          onSelect={(id) => {
            if (layout.nodes.has(id)) focusNode(id)
            else setSelected(id)
          }}
          onExpand={expand}
          onCollapse={collapse}
          onOpen={onOpen}
          onClose={() => {
            setSelected(null)
          }}
        />
      )}
    </div>
  )
}

/** Chú giải: độ dày theo băng cố định, đường idle, viền đứt = ngoài phạm vi; kèm số liệu. */
function Legend({
  stats,
  onZoom
}: {
  stats: string
  onZoom: (dir: 'in' | 'out' | 'fit') => void
}): React.JSX.Element {
  const shown = [0, 2, 4, 5] as const
  return (
    <div
      className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex items-end justify-between gap-2"
      data-testid="k8s-traffic-legend"
    >
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface/95 px-2.5 py-1.5 text-[11px] text-muted shadow-sm">
        {shown.map((b) => (
          <span key={b} className="flex items-center gap-1.5">
            <svg width="22" height="10" aria-hidden>
              <line
                x1="1"
                y1="5"
                x2="21"
                y2="5"
                stroke={RAMP[Math.min(b, RAMP.length - 1)] ?? IDLE}
                strokeWidth={WIDTHS[b]}
                strokeLinecap="round"
              />
            </svg>
            {BANDS[b].label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <svg width="22" height="10" aria-hidden>
            <line
              x1="1"
              y1="5"
              x2="21"
              y2="5"
              stroke={IDLE}
              strokeWidth={1.4}
              strokeDasharray="4 3"
            />
          </svg>
          {t('idle')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-[3px] border border-dashed border-line-strong" />
          {t('outside scope')}
        </span>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <div className="pointer-events-auto flex overflow-hidden rounded-md border border-line bg-surface/95 shadow-sm">
          {(
            [
              ['out', <Minus key="o" size={13} />, t('Zoom out')],
              ['in', <Plus key="i" size={13} />, t('Zoom in')],
              ['fit', <Maximize2 key="f" size={12} />, t('Fit everything')]
            ] as const
          ).map(([dir, icon, label]) => (
            <button
              key={dir}
              type="button"
              title={label}
              aria-label={label}
              data-testid={`k8s-traffic-zoom-${dir}`}
              className="flex size-7 items-center justify-center border-l border-line text-muted first:border-l-0 hover:bg-hover hover:text-fg"
              onClick={() => {
                onZoom(dir)
              }}
            >
              {icon}
            </button>
          ))}
        </div>
        <span className="rounded-md border border-line bg-surface/95 px-2 py-1 text-[11px] text-faint shadow-sm">
          {stats}
        </span>
      </div>
    </div>
  )
}

/** Bảng bên phải: tổng vào / ra, từng bên gọi tới / được gọi kèm tốc độ, thành viên của node gộp. */
function Panel({
  node,
  graph,
  byId,
  onSelect,
  onExpand,
  onCollapse,
  onOpen,
  onClose
}: {
  node: FlowNode
  graph: FlowGraph
  byId: ReadonlyMap<string, FlowNode>
  onSelect: (id: string) => void
  onExpand: (id: string) => void
  onCollapse: (id: string) => void
  onOpen: (ref: MapRef) => void
  onClose: () => void
}): React.JSX.Element {
  const flows = graph.allEdges.filter((e) => e.from === node.id || e.to === node.id)
  const kind = node.peer ? WORKLOAD_KIND_ID[node.peer.kind] : undefined
  const group = !node.peer && node.kind !== 'peer'
  return (
    <aside
      className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-line bg-surface text-xs"
      data-testid="k8s-traffic-panel"
    >
      <div className="flex items-start gap-2 border-b border-line p-3">
        <NodeIcon n={node} size={20} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px] font-semibold text-fg">
            {flowTitle(node)}
          </div>
          <div className="text-faint">{flowSubtitle(node)}</div>
        </div>
        <button
          type="button"
          aria-label={t('Close')}
          className="rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 border-b border-line p-3">
        <Stat label={t('Received')} value={node.inRate} />
        <Stat label={t('Sent')} value={node.outRate} />
      </div>
      <div className="flex flex-wrap gap-1.5 border-b border-line p-3 empty:hidden">
        {node.expandable && (
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-line px-2 py-1 font-medium text-fg hover:bg-hover"
            data-testid="k8s-traffic-panel-expand"
            onClick={() => {
              onExpand(node.id)
            }}
          >
            <Plus size={12} />
            {tn(node.members.length, 'Expand {n}', 'Expand {n}')}
          </button>
        )}
        {node.parent && (
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-line px-2 py-1 font-medium text-fg hover:bg-hover"
            data-testid="k8s-traffic-panel-collapse"
            onClick={() => {
              if (node.parent) onCollapse(node.parent)
            }}
          >
            <Minus size={12} />
            {t('Collapse group')}
          </button>
        )}
        {node.peer && kind && (
          <button
            type="button"
            className="rounded-md border border-line px-2 py-1 font-medium text-fg hover:bg-hover"
            onClick={() => {
              if (node.peer) onOpen({ kind, ns: node.peer.ns, name: node.peer.name })
            }}
          >
            {t('Open {kind}', { kind: node.peer.kind })}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {(['in', 'out'] as const).map((dir) => {
          const list = flows
            .filter((e) => (dir === 'in' ? e.to : e.from) === node.id)
            .sort((x, y) => y.rate - x.rate)
          return (
            <section key={dir} className="mb-3">
              <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
                {dir === 'in' ? t('Called by') : t('Calls')}{' '}
                <span className="font-normal">{list.length}</span>
              </h4>
              {list.length === 0 && <p className="text-faint">{t('None')}</p>}
              {list.map((e) => {
                const otherId = dir === 'in' ? e.from : e.to
                const other = byId.get(otherId)
                if (!other) return null
                return (
                  <button
                    key={otherId}
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-hover"
                    data-testid="k8s-traffic-panel-peer"
                    data-name={other.peer?.name ?? flowTitle(other)}
                    onClick={() => {
                      onSelect(otherId)
                    }}
                  >
                    <NodeIcon n={other} size={14} />
                    <span className="min-w-0 flex-1 truncate font-mono text-fg">
                      {other.peer?.ns ? `${other.peer.ns}/` : ''}
                      {flowTitle(other)}
                    </span>
                    <span
                      className={cx(
                        'shrink-0 tabular-nums',
                        e.rate >= 1 ? 'text-fg' : 'text-faint'
                      )}
                    >
                      {trafficText(e.rate)}
                    </span>
                  </button>
                )
              })}
            </section>
          )
        })}
        {group && (
          <section>
            <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
              {t('Contains')} <span className="font-normal">{node.members.length}</span>
            </h4>
            {node.members.slice(0, 200).map((m) => (
              <div
                key={peerKey(m.peer)}
                className="flex items-center gap-2 px-1 py-0.5"
                data-testid="k8s-traffic-panel-member"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-muted">{m.peer.name}</span>
                <span className="shrink-0 text-faint tabular-nums">{trafficText(m.rate)}</span>
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  )
}

function Stat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-md border border-line px-2 py-1.5">
      <div className="text-[11px] text-faint">{label}</div>
      <div className="text-[13px] font-semibold text-fg tabular-nums">{trafficText(value)}</div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="flex size-full flex-1 items-center justify-center p-6 text-center text-xs text-faint"
      data-testid="k8s-traffic-map-empty"
    >
      <div className="max-w-md">{children}</div>
    </div>
  )
}

// ——— Bản đồ nhỏ của một workload (tab Traffic): bên gọi trái, workload giữa, bên được gọi phải ———

/** Số bên tối đa mỗi phía (phần còn lại gộp "+N"; danh sách bên dưới có đủ số). */
const FOCUS_PER_SIDE = 5

export function TrafficFocusMap(props: {
  rates: readonly TrafficRate[]
  focus: TrafficPeer
  onNavigate?: (kind: string, name: string, namespace?: string) => void
}): React.JSX.Element | null {
  return (
    <ReactFlowProvider>
      <FocusInner {...props} />
    </ReactFlowProvider>
  )
}

function FocusInner({
  rates,
  focus,
  onNavigate
}: {
  rates: readonly TrafficRate[]
  focus: TrafficPeer
  onNavigate?: (kind: string, name: string, namespace?: string) => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  const [boxRef, width] = useElementWidth()
  const graph = useMemo(
    () => flowGraph(rates, { scope: [], focus, expanded, showIdle: true, perSide: FOCUS_PER_SIDE }),
    [rates, focus, expanded]
  )
  // Ba cột chia đều bề ngang khung (bảng chi tiết hẹp) — zoom 1, chữ giữ nguyên cỡ.
  const colGap = width < 520 ? 26 : 56
  // Workload trung tâm hẹp hơn (đã biết là ai) — hai bên rộng hơn cho tên bên gọi / được gọi.
  const avail = width - 16 - colGap * 2
  const center = Math.round(Math.max(80, Math.min(200, avail * 0.28)))
  const side = Math.max(92, Math.min(220, Math.floor((avail - center) / 2)))
  const opts: FlowLayoutOptions = {
    nodeW: side,
    colWidths: [side, center, side],
    nodeH: 46,
    colGap,
    rowGap: 8,
    maxRows: 99
  }
  const layout = useMemo(
    () => layoutFlow(graph, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, side, center, colGap]
  )
  const focusId = `p:${peerKey(focus)}`
  const flow = useMemo(
    () =>
      toFlow(graph, layout, (n) => {
        if (n.focus) return undefined
        const e = graph.edges.find(
          (x) => (x.from === n.id && x.to === focusId) || (x.to === n.id && x.from === focusId)
        )
        return e?.rate
      }),
    [graph, layout, focusId]
  )
  const ctx = useMemo<FlowCtx>(
    () => ({
      selected: null,
      related: new Set(),
      hoverEdge,
      matches: null,
      compact: true,
      homeNs: null,
      labels: false,
      onExpand: (id) => {
        setExpanded((prev) => new Set([...prev, id]))
      }
    }),
    [hoverEdge]
  )
  const height = layout.height + 16
  return (
    <div
      ref={boxRef}
      className="k8s-map relative overflow-hidden rounded-md border border-line"
      style={{ height: graph.nodes.length ? height : 0 }}
      data-testid="k8s-traffic-focus-map"
    >
      {width > 0 && graph.nodes.length > 0 && (
        <FlowContext.Provider value={ctx}>
          <ReactFlow<FNode, FEdge>
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            viewport={{ x: Math.max(8, (width - layout.width) / 2), y: 8, zoom: 1 }}
            panOnDrag={false}
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            onEdgeMouseEnter={(_, e) => {
              setHoverEdge(e.id)
            }}
            onEdgeMouseLeave={() => {
              setHoverEdge(null)
            }}
            onNodeClick={(_, n) => {
              const node = graph.nodes.find((x) => x.id === n.id)
              if (!node || node.focus) return
              if (node.expandable) {
                setExpanded((prev) => new Set([...prev, node.id]))
                return
              }
              const p = node.peer
              const kind = p ? (PEER_KIND_ID[p.kind] ?? '') : ''
              if (p && kind && kind !== 'nodes' && kind !== 'services' && onNavigate)
                onNavigate(kind, p.name, p.ns)
            }}
          />
        </FlowContext.Provider>
      )}
    </div>
  )
}
