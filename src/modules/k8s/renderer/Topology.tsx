import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Boxes,
  Clock,
  Copy,
  Database,
  DoorOpen,
  ExternalLink,
  FileText,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  Link2,
  Lock,
  Maximize,
  Minus,
  Network,
  Play,
  Plus,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  Target,
  UnfoldHorizontal,
  UserRound,
  Zap
} from 'lucide-react'
import { cx } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
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

const ICON: Record<string, typeof Box> = {
  pods: Box,
  'deployments.apps': Layers,
  'statefulsets.apps': Database,
  'daemonsets.apps': Boxes,
  'replicasets.apps': Copy,
  'jobs.batch': Play,
  'cronjobs.batch': Clock,
  services: Network,
  'ingresses.networking.k8s.io': Globe,
  'httproutes.gateway.networking.k8s.io': Globe,
  'grpcroutes.gateway.networking.k8s.io': Globe,
  'gateways.gateway.networking.k8s.io': DoorOpen,
  configmaps: FileText,
  secrets: KeyRound,
  persistentvolumeclaims: HardDrive,
  persistentvolumes: HardDrive,
  nodes: Server,
  serviceaccounts: UserRound,
  'rolebindings.rbac.authorization.k8s.io': Link2,
  'clusterrolebindings.rbac.authorization.k8s.io': Link2,
  'roles.rbac.authorization.k8s.io': Lock,
  'clusterroles.rbac.authorization.k8s.io': Lock,
  'horizontalpodautoscalers.autoscaling': Gauge,
  'poddisruptionbudgets.policy': ShieldCheck,
  'networkpolicies.networking.k8s.io': Shield
}

/** Màu + nét theo nhóm quan hệ. */
const STYLE: Record<TopologyCategory, { color: string; dash?: string }> = {
  ownership: { color: 'text-faint' },
  network: { color: 'text-accent' },
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
  grants: 'grants'
}

const TONE_STROKE: Record<TopologyNode['tone'], string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  muted: 'text-line-strong'
}

/** Tỉ lệ nhỏ nhất khi vừa khung mà chữ còn đọc được. */
const MIN_READABLE = 0.85

interface View {
  x: number
  y: number
  k: number
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
  const [hidden, setHidden] = useState<Set<TopologyCategory>>(new Set())
  const [selectedRaw, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [impact, setImpact] = useState(false)
  const [expanding, setExpanding] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [view, setView] = useState<View | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)

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

  const filtered = useMemo(() => (graph ? filterTopology(graph, hidden) : null), [graph, hidden])
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

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = wrap.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      setView((v) => {
        if (!v) return v
        if (!e.ctrlKey && Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) < 40)
          return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }
        const k = Math.max(0.15, Math.min(2.5, v.k * Math.exp(-e.deltaY * 0.0015)))
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
      })
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      wrap.removeEventListener('wheel', onWheel)
    }
  }, [])

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

  if (error && !graph) return <p className="text-xs text-danger">{error}</p>
  if (!graph || !layout) return <p className="text-xs text-faint">Mapping relationships…</p>

  const sel = selected ? byId.get(selected) : undefined
  const categories = [...new Set(graph.edges.map((e) => EDGE_CATEGORY[e.type]))]
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
        className={cx(
          'relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden rounded-md border border-line bg-canvas select-none active:cursor-grabbing'
        )}
        data-testid="k8s-topology-canvas"
        onPointerDown={(e) => {
          if (!view) return
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (!d.moved && Math.hypot(dx, dy) < 4) return
          if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId)
          d.moved = true
          setView((v) => (v ? { ...v, x: d.vx + dx, y: d.vy + dy } : v))
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId)
          // Bấm vào nền (không kéo) → bỏ chọn.
          if (d && !d.moved && e.target === e.currentTarget.querySelector('svg')) setSelected(null)
        }}
      >
        {view && (
          <svg className="absolute inset-0 h-full w-full">
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {layout.edges.map((e) => (
                <EdgePath
                  key={`${e.from}>${e.to}>${e.type}`}
                  direction={layout.direction}
                  edge={e}
                  a={byId.get(e.from)}
                  b={byId.get(e.to)}
                  lit={lit}
                  showLabel={Boolean(lit && lit.has(e.from) && lit.has(e.to)) || view.k >= 1.3}
                />
              ))}
              {layout.nodes.map((n) => (
                <NodeBox
                  key={n.id}
                  node={n}
                  root={n.id === graph.root}
                  selected={n.id === selected}
                  dim={Boolean(lit && !lit.has(n.id))}
                  affected={Boolean(affected?.has(n.id))}
                  expanded={expanded.has(n.id)}
                  busy={expanding === n.id}
                  onSelect={() => {
                    if (!drag.current?.moved) setSelected(n.id === selected ? null : n.id)
                  }}
                  onOpen={() => {
                    open(n)
                  }}
                  onHover={(on) => {
                    setHover(on ? n.id : null)
                  }}
                />
              ))}
            </g>
          </svg>
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

function EdgePath({
  edge,
  direction,
  a,
  b,
  lit,
  showLabel
}: {
  edge: TopologyEdge
  direction: 'lr' | 'tb'
  a: PlacedNode | undefined
  b: PlacedNode | undefined
  lit: Set<string> | null
  showLabel: boolean
}): React.JSX.Element | null {
  if (!a || !b) return null
  const style = STYLE[EDGE_CATEGORY[edge.type]]
  const W = TOPO_NODE_W
  const H = TOPO_NODE_H
  // Cạnh ngang (khác cột khi trái → phải, cùng hàng khi trên → dưới) hay dọc.
  const horizontal = direction === 'lr' ? b.x !== a.x : b.y === a.y
  let x1: number
  let y1: number
  let x2: number
  let y2: number
  let d: string
  let head: string
  if (horizontal) {
    const right = b.x > a.x
    x1 = right ? a.x + W : a.x
    y1 = a.y + H / 2
    x2 = right ? b.x - 6 : b.x + W + 6
    y2 = b.y + H / 2
    const bend = right ? 40 : -40
    d = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
    head = right
      ? `M${x2},${y2 - 4} L${x2 + 6},${y2} L${x2},${y2 + 4} Z`
      : `M${x2},${y2 - 4} L${x2 - 6},${y2} L${x2},${y2 + 4} Z`
  } else {
    const down = b.y > a.y
    x1 = a.x + W / 2
    y1 = down ? a.y + H : a.y
    x2 = b.x + W / 2
    y2 = down ? b.y - 6 : b.y + H + 6
    const mid = (y1 + y2) / 2
    d = `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`
    head = down
      ? `M${x2 - 4},${y2} L${x2},${y2 + 6} L${x2 + 4},${y2} Z`
      : `M${x2 - 4},${y2} L${x2},${y2 - 6} L${x2 + 4},${y2} Z`
  }
  const hot = lit ? lit.has(edge.from) && lit.has(edge.to) : false
  const label = edge.label ? `${EDGE_TEXT[edge.type]} · ${edge.label}` : EDGE_TEXT[edge.type]
  return (
    <g
      className={style.color}
      opacity={lit ? (hot ? 1 : 0.15) : 0.75}
      data-testid="k8s-topology-edge"
      data-type={edge.type}
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={hot ? 2 : 1.3}
        strokeDasharray={style.dash}
      >
        <title>{label}</title>
      </path>
      <path d={head} fill="currentColor" />
      {showLabel && (
        <text
          x={(x1 + x2) / 2}
          y={(y1 + y2) / 2 - 4}
          textAnchor="middle"
          className="fill-current text-[9px]"
          paintOrder="stroke"
          stroke="var(--sh-canvas)"
          strokeWidth={3}
        >
          {label.length > 34 ? `${label.slice(0, 33)}…` : label}
        </text>
      )}
    </g>
  )
}

/** Cắt chữ theo bề rộng ước lượng (SVG không tự "…"). */
const clip = (text: string, px: number, size: number): string => {
  const max = Math.floor(px / (size * 0.58))
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

function NodeBox({
  node,
  root,
  selected,
  dim,
  affected,
  expanded,
  busy,
  onSelect,
  onOpen,
  onHover
}: {
  node: PlacedNode
  root: boolean
  selected: boolean
  dim: boolean
  affected: boolean
  expanded: boolean
  busy: boolean
  onSelect: () => void
  onOpen: () => void
  onHover: (on: boolean) => void
}): React.JSX.Element {
  const Icon = ICON[node.kind] ?? (node.kind ? Box : UnfoldHorizontal)
  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      opacity={dim ? 0.3 : 1}
      className="cursor-pointer"
      data-testid="k8s-topology-node"
      data-kind={node.kind}
      data-name={node.name}
      data-root={root ? 'true' : undefined}
      data-affected={affected ? 'true' : undefined}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      onPointerEnter={() => {
        onHover(true)
      }}
      onPointerLeave={() => {
        onHover(false)
      }}
    >
      <title>
        {node.kindLabel} {node.name}
        {node.namespace ? ` (${node.namespace})` : ''} — {node.summary}
      </title>
      <rect
        width={TOPO_NODE_W}
        height={TOPO_NODE_H}
        rx={8}
        className={cx(
          node.missing ? 'fill-danger-soft' : root ? 'fill-accent-soft' : 'fill-surface',
          selected ? 'text-accent' : affected ? 'text-warning' : TONE_STROKE[node.tone]
        )}
        stroke="currentColor"
        strokeWidth={selected || root || affected ? 2 : 1}
        strokeDasharray={node.missing || !node.kind ? '4 3' : undefined}
      />
      <rect
        x={0}
        y={8}
        width={3}
        height={TOPO_NODE_H - 16}
        className={cx('fill-current', TONE_STROKE[node.tone])}
      />
      <Icon x={10} y={8} width={14} height={14} className="text-muted" aria-hidden />
      <text x={30} y={19} className="fill-faint text-[10px]">
        {clip(node.kindLabel, 80, 10)}
      </text>
      {node.namespace && (
        <text x={TOPO_NODE_W - 8} y={19} textAnchor="end" className="fill-faint text-[9px]">
          {clip(node.namespace, 80, 9)}
        </text>
      )}
      <text x={10} y={36} className="fill-fg text-[11.5px] font-semibold">
        {clip(node.name, TOPO_NODE_W - 20 - (node.expandable && !expanded ? 14 : 0), 11.5)}
      </text>
      {node.expandable && !expanded && (
        <text x={TOPO_NODE_W - 10} y={37} textAnchor="end" className="fill-faint text-[11px]">
          {busy ? '…' : '+'}
        </text>
      )}
    </g>
  )
}

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
