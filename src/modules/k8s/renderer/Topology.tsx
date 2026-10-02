import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Background,
  BackgroundVariant,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import {
  ExternalLink,
  Maximize,
  Minus,
  Plus,
  RefreshCw,
  Target,
  UnfoldHorizontal,
  Zap
} from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { KindIcon } from './icons'
import { useTraffic } from './useTraffic'
import { formatRate } from '../shared/traffic'
import type { K8sOp, TopologyEdge, TopologyNode, TopologyResult } from '../shared/ops'
import type { K8sObject } from '../shared/resources'
import {
  CATEGORY_LABEL,
  EDGE_CATEGORY,
  TOPO_NODE_H,
  TOPO_NODE_W,
  dependentsOf,
  filterTopology,
  layoutTopology,
  liveTopology,
  mergeTopology,
  type PlacedNode,
  type TopologyCategory
} from '../shared/topology'

type Request = <T>(op: K8sOp) => Promise<T>

/** Loại có tab Topology. */
export const TOPOLOGY_KINDS = new Set([
  'pods',
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'replicasets.apps',
  'jobs.batch',
  'cronjobs.batch',
  'services',
  'ingresses.networking.k8s.io',
  'gateways.gateway.networking.k8s.io',
  'httproutes.gateway.networking.k8s.io',
  'grpcroutes.gateway.networking.k8s.io',
  'configmaps',
  'secrets',
  'persistentvolumeclaims',
  'serviceaccounts',
  'nodes'
])

/** Màu + nét theo nhóm quan hệ. */
const STYLE: Record<TopologyCategory, { color: string; dash?: string }> = {
  ownership: { color: 'text-faint' },
  network: { color: 'text-accent' },
  live: { color: 'text-sky-500' },
  config: { color: 'text-muted', dash: '5 3' },
  scheduling: { color: 'text-faint', dash: '1.5 3' },
  policy: { color: 'text-warning', dash: '6 3' },
  rbac: { color: 'text-danger', dash: '8 3 2 3' }
}

const EDGE_TEXT: Record<TopologyEdge['type'], string> = {
  owns: 'owns',
  selects: 'selects',
  routes: 'routes to',
  attaches: 'attaches',
  uses: 'uses',
  mounts: 'mounts',
  bound: 'bound to',
  'runs-on': 'runs on',
  scales: 'scales',
  protects: 'protects',
  isolates: 'isolates',
  identity: 'runs as',
  subject: 'bound by',
  grants: 'grants',
  calls: 'calls'
}

/** Tỉ lệ nhỏ nhất khi vừa khung mà chữ còn đọc được. */
const MIN_READABLE = 0.85

interface View {
  x: number
  y: number
  k: number
}

/** Workload có traffic Caretta (id loại → tên loại như Caretta báo). */
const LIVE_KINDS: Record<string, string> = {
  'deployments.apps': 'Deployment',
  'statefulsets.apps': 'StatefulSet',
  'daemonsets.apps': 'DaemonSet'
}

/**
 * Object Topology: đồ thị quan hệ của một đối tượng (owner, pod, node, traffic, config, storage,
 * chính sách, RBAC). Mũi tên có hướng; đối tượng dùng chung chỉ mở rộng khi người dùng chọn.
 */
export function TopologyOf({
  kindId,
  obj,
  request,
  onNavigate
}: {
  kindId: string
  obj: K8sObject
  request: Request
  onNavigate?: (kind: string, name: string, namespace?: string) => void
}): React.JSX.Element {
  const ns = obj.metadata.namespace
  const name = obj.metadata.name
  const [graph, setGraph] = useState<TopologyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  // Mặc định tắt RBAC (ServiceAccount → Role…) và Scheduling (Node, PriorityClass…): nhiều mà ít
  // khi cần — bật ở thanh lọc khi muốn xem.
  const [hidden, setHidden] = useState<Set<TopologyCategory>>(
    () => new Set<TopologyCategory>(['rbac', 'scheduling'])
  )
  const [selectedRaw, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [impact, setImpact] = useState(false)
  const [expanding, setExpanding] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [view, setView] = useState<View | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    request<TopologyResult>({
      op: 'topology',
      kind: kindId,
      ...(ns ? { namespace: ns } : {}),
      name
    }).then(
      (g) => {
        if (cancelled) return
        setGraph(g)
        setError(null)
        setExpanded(new Set())
        setView(null)
      },
      (e: unknown) => {
        if (!cancelled) setError(cleanError(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [request, kindId, ns, name, tick])

  // Traffic thật (Caretta) quanh workload: bên gọi tới / được gọi, kể cả namespace khác / ngoài cluster.
  const liveKind = LIVE_KINDS[kindId]
  const traffic = useTraffic(request, Boolean(liveKind) && !hidden.has('live'))
  const withLive = useMemo(() => {
    if (!graph || !liveKind || traffic.status !== 'live') return graph
    const extra = liveTopology(
      { id: graph.root, kindLabel: liveKind, namespace: ns ?? '', name },
      traffic.rates,
      formatRate
    )
    return extra.edges.length ? mergeTopology(graph, extra) : graph
  }, [graph, liveKind, traffic.status, traffic.rates, ns, name])
  const filtered = useMemo(
    () => (withLive ? filterTopology(withLive, hidden) : null),
    [withLive, hidden]
  )
  // Khung đổi cỡ (thu / phóng bảng) → chọn lại hướng và vừa khung.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => {
      setSize((s) => {
        const w = wrap.clientWidth
        const h = wrap.clientHeight
        return s && // Thanh chọn hiện / ẩn đổi chiều cao chút ít — không tính.
          Math.abs(s.w - w) < 40 &&
          Math.abs(s.h - h) < 150
          ? s
          : { w, h }
      })
    })
    ro.observe(wrap)
    return () => {
      ro.disconnect()
    }
  }, [graph])
  /** Hướng cho chữ to nhất khi vừa khung (khung rộng → ngang, khung hẹp → dọc). */
  const layout = useMemo(() => {
    if (!filtered) return null
    const lr = layoutTopology(filtered.nodes, filtered.edges, 'lr')
    if (!size) return lr
    const tb = layoutTopology(filtered.nodes, filtered.edges, 'tb')
    const scale = (l: { width: number; height: number }): number =>
      Math.min(size.w / l.width, size.h / l.height)
    return scale(tb) > scale(lr) * 1.15 ? tb : lr
  }, [filtered, size])
  const byId = useMemo(() => new Map((layout?.nodes ?? []).map((n) => [n.id, n])), [layout])
  const selected = selectedRaw && byId.has(selectedRaw) ? selectedRaw : null
  const focus = selected ?? hover

  const affected = useMemo(
    () => (impact && selected && layout ? dependentsOf(layout, selected) : null),
    [impact, selected, layout]
  )
  /** Node / cạnh nổi bật: ảnh hưởng (blast radius) hoặc hàng xóm trực tiếp. */
  const lit = useMemo(() => {
    if (affected && selected) return new Set([selected, ...affected])
    if (!focus || !layout) return null
    const set = new Set([focus])
    for (const e of layout.edges) {
      if (e.from === focus) set.add(e.to)
      if (e.to === focus) set.add(e.from)
    }
    return set
  }, [affected, selected, focus, layout])

  /** all = cả đồ thị (nút Fit); không thì giữ chữ đọc được, đặt gốc ở giữa. */
  const fit = useCallback(
    (all = false) => {
      const wrap = wrapRef.current
      if (!wrap || !layout) return
      const W = wrap.clientWidth
      const H = wrap.clientHeight
      const pad = 24
      const k = Math.min(1.1, (W - 2 * pad) / layout.width, (H - 2 * pad) / layout.height)
      if (all || k >= MIN_READABLE) {
        setView({ k, x: (W - layout.width * k) / 2, y: (H - layout.height * k) / 2 })
        return
      }
      // Đồ thị quá lớn để đọc khi vừa khung: giữ chữ đọc được, đặt gốc ở giữa (kéo để xem thêm).
      const root = layout.nodes.find((n) => n.id === graph?.root)
      const cx = root ? root.x + TOPO_NODE_W / 2 : layout.width / 2
      const cy = root ? root.y + TOPO_NODE_H / 2 : layout.height / 2
      setView({
        k: MIN_READABLE,
        x: Math.min(
          pad,
          Math.max(W - pad - layout.width * MIN_READABLE, W / 2 - cx * MIN_READABLE)
        ),
        y: Math.min(
          pad,
          Math.max(H - pad - layout.height * MIN_READABLE, H / 2 - cy * MIN_READABLE)
        )
      })
    },
    [layout, graph]
  )

  // Lần đầu / sau khi tải lại / đổi hướng hoặc cỡ khung: vừa khung (mở rộng node thì không).
  const fitKey = layout && size ? `${layout.direction}|${String(size.w)}|${graph?.root ?? ''}` : ''
  const fittedFor = useRef('')
  useEffect(() => {
    if (!fitKey || (view && fittedFor.current === fitKey)) return
    fittedFor.current = fitKey
    fit()
  }, [fitKey, view, fit])

  const zoom = (factor: number): void => {
    const wrap = wrapRef.current
    if (!wrap) return
    const px = wrap.clientWidth / 2
    const py = wrap.clientHeight / 2
    setView((v) => {
      if (!v) return v
      const k = Math.max(0.15, Math.min(2.5, v.k * factor))
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
    })
  }

  const expand = (n: TopologyNode): void => {
    if (!graph || !n.kind) return
    setExpanding(n.id)
    request<TopologyResult>({
      op: 'topology',
      kind: n.kind,
      ...(n.namespace ? { namespace: n.namespace } : {}),
      name: n.name
    }).then(
      (extra) => {
        setGraph((g) => (g ? mergeTopology(g, extra) : g))
        setExpanded((s) => new Set([...s, n.id]))
        setExpanding(null)
      },
      (e: unknown) => {
        setExpanding(null)
        setError(cleanError(e))
      }
    )
  }

  const open = (n: TopologyNode): void => {
    if (n.kind && !n.missing) onNavigate?.(n.kind, n.name, n.namespace)
  }

  // ——— React Flow ———
  // Vị trí người dùng kéo (theo từng bố cục — bố cục mới thì về vị trí tự xếp).
  const [movedRaw, setMoved] = useState<{
    layout: unknown
    pos: Readonly<Record<string, { x: number; y: number }>>
  }>({ layout: null, pos: {} })
  const moved = useMemo(() => (movedRaw.layout === layout ? movedRaw.pos : {}), [movedRaw, layout])
  const onNodesChange = useCallback(
    (changes: NodeChange<TopoFlowNode>[]) => {
      const next: Record<string, { x: number; y: number }> = {}
      for (const c of changes) if (c.type === 'position' && c.position) next[c.id] = c.position
      if (Object.keys(next).length)
        setMoved((m) => ({ layout, pos: { ...(m.layout === layout ? m.pos : {}), ...next } }))
    },
    [layout]
  )
  const flowNodes = useMemo<TopoFlowNode[]>(
    () =>
      (layout?.nodes ?? []).map((n) => ({
        id: n.id,
        type: 'topo',
        position: moved[n.id] ?? { x: n.x, y: n.y },
        width: TOPO_NODE_W,
        height: TOPO_NODE_H,
        data: { node: n },
        draggable: true,
        selectable: false,
        connectable: false
      })),
    [layout, moved]
  )
  const flowEdges = useMemo<TopoFlowEdge[]>(() => {
    if (!layout) return []
    const pos = new Map(layout.nodes.map((n) => [n.id, { ...n, ...(moved[n.id] ?? {}) }]))
    return layout.edges.map((e) => {
      const a = pos.get(e.from)
      const b = pos.get(e.to)
      // Cạnh ngang (khác cột khi trái → phải, cùng hàng khi trên → dưới) hay dọc.
      const horizontal =
        layout.direction === 'lr' ? (a?.x ?? 0) !== (b?.x ?? 0) : (a?.y ?? 0) === (b?.y ?? 0)
      const forward = horizontal ? (b?.x ?? 0) > (a?.x ?? 0) : (b?.y ?? 0) > (a?.y ?? 0)
      return {
        id: `${e.from}>${e.to}>${e.type}`,
        source: e.from,
        target: e.to,
        sourceHandle: horizontal ? (forward ? 'sr' : 'sl') : forward ? 'sb' : 'st',
        targetHandle: horizontal ? (forward ? 'tl' : 'tr') : forward ? 'tt' : 'tb',
        type: 'topo',
        data: { edge: e }
      }
    })
  }, [layout, moved])
  const ctx = useMemo<TopoCtx>(
    () => ({
      root: graph?.root ?? '',
      selected,
      lit,
      affected,
      expanded,
      expanding,
      showLabels: (view?.k ?? 1) >= 1.3,
      onOpen: (n) => {
        open(n)
      }
    }),
    // open dùng onNavigate (ổn định theo props).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph?.root, selected, lit, affected, expanded, expanding, view?.k]
  )

  if (error && !graph) return <p className="text-xs text-danger">{error}</p>
  if (!graph || !layout) return <p className="text-xs text-faint">Mapping relationships…</p>

  const sel = selected ? byId.get(selected) : undefined
  const categories = [...new Set((withLive ?? graph).edges.map((e) => EDGE_CATEGORY[e.type]))]
  const missing = graph.nodes.filter((n) => n.missing)

  return (
    <div className="flex h-full min-h-[420px] flex-col gap-2" data-testid="k8s-topology">
      <div className="flex flex-wrap items-center gap-1">
        {(Object.keys(CATEGORY_LABEL) as TopologyCategory[])
          .filter((c) => categories.includes(c))
          .map((c) => {
            const on = !hidden.has(c)
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                data-testid="k8s-topology-filter"
                data-category={c}
                className={cx(
                  'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px]',
                  on ? 'border-line-strong text-fg' : 'border-line text-faint line-through'
                )}
                onClick={() => {
                  setHidden((h) => {
                    const next = new Set(h)
                    if (next.has(c)) next.delete(c)
                    else next.add(c)
                    return next
                  })
                }}
              >
                <svg width="16" height="6" className={STYLE[c].color} aria-hidden>
                  <line
                    x1="0"
                    y1="3"
                    x2="16"
                    y2="3"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={STYLE[c].dash}
                  />
                </svg>
                {CATEGORY_LABEL[c]}
              </button>
            )
          })}
        <span className="ml-auto flex items-center gap-0.5">
          <IconButton
            label="Zoom out"
            onClick={() => {
              zoom(1 / 1.25)
            }}
          >
            <Minus size={13} />
          </IconButton>
          <IconButton
            label="Zoom in"
            onClick={() => {
              zoom(1.25)
            }}
          >
            <Plus size={13} />
          </IconButton>
          <IconButton
            label="Fit"
            onClick={() => {
              fit(true)
            }}
            testId="k8s-topology-fit"
          >
            <Maximize size={13} />
          </IconButton>
          {Object.keys(moved).length > 0 && (
            <button
              type="button"
              className="mr-1 rounded px-1.5 text-[11px] text-accent hover:bg-hover"
              data-testid="k8s-topology-reset"
              onClick={() => {
                setMoved({ layout: null, pos: {} })
              }}
            >
              Reset layout
            </button>
          )}
          <IconButton
            label="Reload"
            onClick={() => {
              setTick((t) => t + 1)
            }}
          >
            <RefreshCw size={13} />
          </IconButton>
        </span>
      </div>
      {missing.length > 0 && (
        <p className="rounded-md bg-danger-soft px-2 py-1.5 text-xs text-danger">
          {missing.length} referenced object{missing.length === 1 ? ' is' : 's are'} missing:{' '}
          {missing.map((m) => `${m.kindLabel} ${m.name}`).join(', ')}
        </p>
      )}
      <div
        ref={wrapRef}
        className="k8s-topology-flow relative min-h-0 flex-1 overflow-hidden rounded-md border border-line bg-canvas"
        data-testid="k8s-topology-canvas"
      >
        {view && (
          <TopoContext.Provider value={ctx}>
            <ReactFlow<TopoFlowNode, TopoFlowEdge>
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={TOPO_NODE_TYPES}
              edgeTypes={TOPO_EDGE_TYPES}
              viewport={{ x: view.x, y: view.y, zoom: view.k }}
              onViewportChange={(v) => {
                setView({ x: v.x, y: v.y, k: v.zoom })
              }}
              minZoom={0.15}
              maxZoom={2.5}
              nodesDraggable
              onNodesChange={onNodesChange}
              nodesConnectable={false}
              elementsSelectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              disableKeyboardA11y
              zoomOnDoubleClick={false}
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_, n) => {
                setSelected(n.id === selected ? null : n.id)
              }}
              onNodeDoubleClick={(_, n) => {
                const m = byId.get(n.id)
                if (m) open(m)
              }}
              onNodeMouseEnter={(_, n) => {
                setHover(n.id)
              }}
              onNodeMouseLeave={() => {
                setHover(null)
              }}
              onPaneClick={() => {
                setSelected(null)
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            </ReactFlow>
          </TopoContext.Provider>
        )}
      </div>
      {sel ? (
        <SelectionBar
          node={sel}
          root={sel.id === graph.root}
          expanded={expanded.has(sel.id)}
          busy={expanding === sel.id}
          impact={impact}
          affected={affected}
          byId={byId}
          edges={layout.edges}
          onImpact={setImpact}
          onExpand={() => {
            expand(sel)
          }}
          onOpen={
            onNavigate && sel.kind && !sel.missing && sel.id !== graph.root
              ? () => {
                  open(sel)
                }
              : undefined
          }
        />
      ) : (
        <p className="text-[11px] text-faint">
          {layout.nodes.length} objects · {layout.edges.length} relationships. Click an object to
          trace it; double-click to open it.
          {graph.notes.length > 0 && (
            <span className="text-warning"> {graph.notes.join(' · ')}</span>
          )}
        </p>
      )}
    </div>
  )
}

function IconButton({
  label,
  onClick,
  testId,
  children
}: {
  label: string
  onClick: () => void
  testId?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

interface TopoCtx {
  root: string
  selected: string | null
  lit: Set<string> | null
  affected: Set<string> | null
  expanded: Set<string>
  expanding: string | null
  showLabels: boolean
  onOpen: (n: TopologyNode) => void
}
const TopoContext = createContext<TopoCtx | null>(null)
const useTopo = (): TopoCtx => {
  const c = useContext(TopoContext)
  if (!c) throw new Error('TopoContext missing')
  return c
}

type TopoFlowNode = Node<{ node: PlacedNode }, 'topo'>
type TopoFlowEdge = Edge<{ edge: TopologyEdge }, 'topo'>

/** Màu nét theo nhóm (giá trị thật cho SVG — đổi theo theme qua biến CSS). */
const STROKE: Record<TopologyCategory, string> = {
  ownership: 'var(--sh-faint)',
  network: 'var(--sh-accent)',
  live: '#0ea5e9',
  config: 'var(--sh-muted)',
  scheduling: 'var(--sh-faint)',
  policy: 'var(--sh-warning)',
  rbac: 'var(--sh-danger)'
}

const TopoEdgeComp = memo(function TopoEdgeComp(
  props: EdgeProps<TopoFlowEdge>
): React.JSX.Element | null {
  const ctx = useTopo()
  const edge = props.data?.edge
  if (!edge) return null
  const cat = EDGE_CATEGORY[edge.type]
  const [path, lx, ly] = getBezierPath(props)
  const hot = ctx.lit ? ctx.lit.has(edge.from) && ctx.lit.has(edge.to) : false
  const color = STROKE[cat]
  const { targetX: x, targetY: y } = props
  // Mũi tên theo hướng vào node đích.
  const head =
    props.targetPosition === Position.Left
      ? `M${x - 7},${y - 4} L${x},${y} L${x - 7},${y + 4} Z`
      : props.targetPosition === Position.Right
        ? `M${x + 7},${y - 4} L${x},${y} L${x + 7},${y + 4} Z`
        : props.targetPosition === Position.Top
          ? `M${x - 4},${y - 7} L${x},${y} L${x + 4},${y - 7} Z`
          : `M${x - 4},${y + 7} L${x},${y} L${x + 4},${y + 7} Z`
  const label = edge.label ? `${EDGE_TEXT[edge.type]} · ${edge.label}` : EDGE_TEXT[edge.type]
  return (
    <g
      opacity={ctx.lit ? (hot ? 1 : 0.15) : 0.8}
      data-testid="k8s-topology-edge"
      data-type={edge.type}
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={hot ? 2.2 : 1.4}
        strokeDasharray={STYLE[cat].dash}
      >
        <title>{label}</title>
      </path>
      <path d={head} fill={color} />
      {(hot || ctx.showLabels) && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded bg-canvas/90 px-1 text-[9.5px] whitespace-nowrap"
            style={{
              transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`,
              color
            }}
          >
            {label.length > 34 ? `${label.slice(0, 33)}…` : label}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  )
})

const TONE_RING: Record<TopologyNode['tone'], string> = {
  ok: 'border-l-success',
  warn: 'border-l-warning',
  bad: 'border-l-danger',
  muted: 'border-l-line-strong'
}

const TopoNodeComp = memo(function TopoNodeComp({
  data
}: NodeProps<TopoFlowNode>): React.JSX.Element {
  const ctx = useTopo()
  const node = data.node
  const root = node.id === ctx.root
  const selected = node.id === ctx.selected
  const affected = Boolean(ctx.affected?.has(node.id))
  const dim = Boolean(ctx.lit && !ctx.lit.has(node.id))
  const expanded = ctx.expanded.has(node.id)
  const hcls = '!pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'
  return (
    <div
      className={cx(
        'flex size-full items-center gap-2 rounded-lg border border-l-[3px] px-2 shadow-xs transition-opacity',
        node.missing
          ? 'border-dashed border-danger bg-danger-soft'
          : root
            ? 'bg-accent-soft'
            : 'bg-surface',
        !node.kind && 'border-dashed bg-subtle',
        selected
          ? 'border-accent ring-2 ring-accent/40'
          : affected
            ? 'border-warning ring-2 ring-warning/40'
            : 'border-line-strong',
        TONE_RING[node.tone],
        dim && 'opacity-30'
      )}
      data-testid="k8s-topology-node"
      data-kind={node.kind}
      data-name={node.name}
      data-root={root ? 'true' : undefined}
      data-affected={affected ? 'true' : undefined}
      title={`${node.kindLabel} ${node.name}${node.namespace ? ` (${node.namespace})` : ''} — ${node.summary}`}
    >
      {node.kind ? (
        <KindIcon kind={node.kind} size={26} />
      ) : (
        <UnfoldHorizontal size={18} className="text-faint" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[10px] text-faint">
          <span className="truncate">{node.kindLabel}</span>
          {node.namespace && <span className="ml-auto truncate">{node.namespace}</span>}
        </div>
        <div className="truncate text-[12px] leading-tight font-semibold text-fg">{node.name}</div>
        <div className="truncate text-[10px] text-muted">{node.summary}</div>
      </div>
      {node.expandable && !expanded && (
        <span className="shrink-0 text-[13px] text-faint" title="Can be expanded">
          {ctx.expanding === node.id ? '…' : '+'}
        </span>
      )}
      <Handle id="tl" type="target" position={Position.Left} className={hcls} />
      <Handle id="tr" type="target" position={Position.Right} className={hcls} />
      <Handle id="tt" type="target" position={Position.Top} className={hcls} />
      <Handle id="tb" type="target" position={Position.Bottom} className={hcls} />
      <Handle id="sl" type="source" position={Position.Left} className={hcls} />
      <Handle id="sr" type="source" position={Position.Right} className={hcls} />
      <Handle id="st" type="source" position={Position.Top} className={hcls} />
      <Handle id="sb" type="source" position={Position.Bottom} className={hcls} />
    </div>
  )
})

const TOPO_NODE_TYPES = { topo: TopoNodeComp }
const TOPO_EDGE_TYPES = { topo: TopoEdgeComp }

function SelectionBar({
  node,
  root,
  expanded,
  busy,
  impact,
  affected,
  byId,
  edges,
  onImpact,
  onExpand,
  onOpen
}: {
  node: PlacedNode
  root: boolean
  expanded: boolean
  busy: boolean
  impact: boolean
  affected: Set<string> | null
  byId: Map<string, PlacedNode>
  edges: readonly TopologyEdge[]
  onImpact: (on: boolean) => void
  onExpand: () => void
  onOpen: (() => void) | undefined
}): React.JSX.Element {
  const links = edges
    .filter((e) => e.from === node.id || e.to === node.id)
    .map((e) => {
      const other = byId.get(e.from === node.id ? e.to : e.from)
      return other
        ? `${e.from === node.id ? EDGE_TEXT[e.type] : `← ${EDGE_TEXT[e.type]}`} ${other.kindLabel} ${other.name}`
        : ''
    })
    .filter(Boolean)
  const counts = new Map<string, number>()
  for (const id of affected ?? []) {
    const n = byId.get(id)
    if (n?.kind) counts.set(n.kindLabel, (counts.get(n.kindLabel) ?? 0) + 1)
  }
  return (
    <div className="rounded-md border border-line p-2 text-xs" data-testid="k8s-topology-selection">
      <div className="flex items-center gap-2">
        <span className="text-faint">{node.kindLabel}</span>
        <span className="min-w-0 truncate font-mono font-semibold text-fg">{node.name}</span>
        {node.namespace && <span className="truncate text-faint">· {node.namespace}</span>}
        <span className="ml-auto flex shrink-0 gap-1">
          <BarButton
            on={impact}
            testId="k8s-topology-impact"
            title="Highlight everything affected if this object changes or fails"
            onClick={() => {
              onImpact(!impact)
            }}
          >
            <Zap size={12} /> Blast radius
          </BarButton>
          {node.expandable && !expanded && !root && (
            <BarButton
              testId="k8s-topology-expand"
              onClick={onExpand}
              title="Show its relationships too"
            >
              <Target size={12} /> {busy ? 'Expanding…' : 'Expand'}
            </BarButton>
          )}
          {onOpen && (
            <BarButton testId="k8s-topology-open" onClick={onOpen}>
              <ExternalLink size={12} /> Open
            </BarButton>
          )}
        </span>
      </div>
      <div className="mt-0.5 text-muted">{node.summary}</div>
      {impact && affected && (
        <div className="mt-1 text-warning" data-testid="k8s-topology-impact-summary">
          {affected.size === 0
            ? 'Nothing else in this graph depends on it.'
            : `Affects ${[...counts.entries()].map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ')}`}
        </div>
      )}
      {!impact && links.length > 0 && (
        <div className="mt-1 line-clamp-2 text-faint">{links.slice(0, 8).join(' · ')}</div>
      )}
    </div>
  )
}

function BarButton({
  on,
  title,
  testId,
  onClick,
  children
}: {
  on?: boolean
  title?: string
  testId?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      data-testid={testId}
      className={cx(
        'inline-flex h-6 items-center gap-1 rounded px-1.5 font-medium',
        on ? 'bg-warning-soft text-warning' : 'text-muted hover:bg-hover hover:text-fg'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
