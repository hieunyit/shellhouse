import { memo, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { cx } from '../../../renderer/src/components/ui'
import {
  WORKLOAD_KIND_ID,
  bandOf,
  formatRate,
  peerKey,
  trafficGraph,
  type TrafficGraphNode
} from '../shared/traffic'
import { EDGE_TYPES, MapContext, sides, type MapCtx, type MapFlowEdge } from './MapFlow'
import type { MapRef } from './MapView'
import { KindIcon } from './icons'
import type { TrafficState } from './useTraffic'

/**
 * Service map dựng từ Caretta (mọi namespace, không phụ thuộc phạm vi đang xem): ai gọi ai, băng
 * thông từng đường. Nguồn bên trái (ingress, client ngoài cluster), đích ngoài cluster bên phải.
 */

type TNode = Node<{ n: TrafficGraphNode; scoped: boolean }, 'peer'>

const PeerNode = memo(function PeerNode({ data }: NodeProps<TNode>): React.JSX.Element {
  const { n, scoped } = data
  const p = n.peer
  const external = p.kind === 'external' || !p.ns
  const kindId = WORKLOAD_KIND_ID[p.kind]
  return (
    <div
      className={cx(
        'k8s-card flex size-full items-center gap-2.5 rounded-[11px] px-3',
        !scoped && 'opacity-80'
      )}
      data-testid="k8s-traffic-node"
      data-name={p.name}
      title={`${p.ns ? `${p.ns}/` : ''}${p.name} (${p.kind || 'external'})`}
    >
      {external ? (
        <svg width="20" height="20" viewBox="0 0 24 24" className="shrink-0 text-muted" aria-hidden>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M3 12h18M12 3c3 2.7 3 15.3 0 18M12 3c-3 2.7-3 15.3 0 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
      ) : (
        <KindIcon kind={kindId ?? 'pods'} size={20} />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px] font-medium text-fg">{p.name}</div>
        <div className="truncate text-[11px] text-faint">
          {external ? 'outside the cluster' : `${p.ns} · ${p.kind}`}
        </div>
      </div>
      <div className="shrink-0 text-right text-[10.5px] leading-tight text-faint tabular-nums">
        {n.inRate >= 1 && <div title="Received">↓ {formatRate(n.inRate)}</div>}
        {n.outRate >= 1 && <div title="Sent">↑ {formatRate(n.outRate)}</div>}
      </div>
      {/* Handle ẩn cho cạnh trái / phải */}
      <PeerHandles />
    </div>
  )
})

function PeerHandles(): React.JSX.Element {
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
        <span key={id}>
          <Handle id={`s${id}`} type="source" position={pos} className={cls} />
          <Handle id={`t${id}`} type="target" position={pos} className={cls} />
        </span>
      ))}
    </>
  )
}

const NODE_TYPES = { peer: PeerNode }

export function TrafficMap(props: {
  traffic: TrafficState
  /** Namespace đang xem — node ngoài phạm vi nhạt hơn (vẫn hiện). */
  scope: readonly string[]
  palette: string[]
  particles: boolean
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
  palette,
  particles,
  onOpen
}: {
  traffic: TrafficState
  scope: readonly string[]
  palette: string[]
  particles: boolean
  onOpen: (ref: MapRef) => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [hideIdle, setHideIdle] = useState(false)
  const rf = useReactFlow()
  const panelOpen = selected !== null
  // Bảng bên phải mở / đóng → khung đổi bề ngang: canh lại cho thấy trọn đồ thị.
  useEffect(() => {
    const t = setTimeout(() => {
      void rf.fitView({ padding: 0.2, maxZoom: 1.1, duration: 250 })
    }, 60)
    return () => {
      clearTimeout(t)
    }
  }, [panelOpen, hideIdle, rf])
  const graph = useMemo(
    () => trafficGraph(hideIdle ? traffic.rates.filter((r) => r.rate >= 1) : traffic.rates),
    [traffic.rates, hideIdle]
  )
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph])
  const related = useMemo(() => {
    const set = new Set<string>()
    if (!selected) return set
    set.add(selected)
    for (const e of graph.edges) {
      if (e.from === selected) set.add(e.to)
      if (e.to === selected) set.add(e.from)
    }
    return set
  }, [selected, graph])

  const nodes = useMemo<TNode[]>(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'peer',
        position: { x: n.x, y: n.y },
        width: n.w,
        height: n.h,
        data: { n, scoped: !scope.length || scope.includes(n.peer.ns) },
        draggable: false,
        selectable: false,
        connectable: false,
        className: cx(
          selected === n.id && 'k8s-focus rounded-[11px]',
          related.size > 0 && !related.has(n.id) && 'k8s-dim'
        )
      })),
    [graph, scope, selected, related]
  )
  const edges = useMemo<MapFlowEdge[]>(
    () =>
      graph.edges.map((e) => {
        const a = byId.get(e.from)
        const b = byId.get(e.to)
        const color = e.rate >= 1 ? (palette[bandOf(e.rate)] ?? palette[0] ?? '#2dd4bf') : '#7d8a9c'
        return {
          id: `t:${e.from}>${e.to}`,
          source: e.from,
          target: e.to,
          ...(a && b ? sides(a, b) : { sourceHandle: 'sr', targetHandle: 'tl' }),
          type: 'map',
          data: { kind: 'traffic', rate: e.rate, color },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
            width: 14,
            height: 14,
            markerUnits: 'userSpaceOnUse'
          }
        }
      }),
    [graph, byId, palette]
  )
  const ctx = useMemo<MapCtx>(
    () => ({
      band: 'near',
      selected,
      related,
      problemsOnly: false,
      showPods: false,
      podsOf: new Map(),
      onSelect: setSelected,
      onHoverPod: () => undefined,
      onToggleNs: () => undefined,
      strong: selected !== null,
      particles
    }),
    [selected, related, particles]
  )
  const sel = selected ? byId.get(selected) : undefined
  const flows = sel
    ? graph.edges
        .filter((e) => e.from === sel.id || e.to === sel.id)
        .sort((x, y) => y.rate - x.rate)
    : []

  if (traffic.status === 'unavailable')
    return (
      <Empty>
        No live traffic — {traffic.reason ?? 'Caretta is not available'}. Install{' '}
        <span className="font-mono">groundcover-com/caretta</span> to draw the service map.
      </Empty>
    )
  if (traffic.status !== 'live') return <Empty>Measuring traffic from Caretta…</Empty>
  if (!graph.nodes.length)
    return <Empty>Caretta is running but saw no connections in the last minute.</Empty>

  return (
    <div className="flex min-h-0 flex-1" data-testid="k8s-traffic-map">
      <div className="relative min-w-0 flex-1">
        <div className="absolute top-2 left-2 z-10 flex items-center gap-2 rounded-md border border-line bg-surface/90 px-2 py-1 text-[11px] text-faint">
          <span>
            {graph.nodes.length} services · {graph.edges.length} connections · from {traffic.agents}{' '}
            Caretta agent{traffic.agents === 1 ? '' : 's'}, last minute
          </span>
          <button
            type="button"
            aria-pressed={hideIdle}
            data-testid="k8s-traffic-hide-idle"
            className={cx(
              'rounded px-1.5 py-0.5 font-medium',
              hideIdle ? 'bg-accent-soft text-fg' : 'text-muted hover:text-fg'
            )}
            onClick={() => {
              setHideIdle(!hideIdle)
            }}
          >
            Hide idle
          </button>
        </div>
        <MapContext.Provider value={ctx}>
          <ReactFlow<TNode, MapFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
            minZoom={0.1}
            maxZoom={2.5}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => {
              setSelected(n.id === selected ? null : n.id)
            }}
            onNodeDoubleClick={(_, n) => {
              const p = byId.get(n.id)?.peer
              const kind = p ? WORKLOAD_KIND_ID[p.kind] : undefined
              if (p && kind) onOpen({ kind, ns: p.ns, name: p.name })
            }}
            onPaneClick={() => {
              setSelected(null)
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          </ReactFlow>
        </MapContext.Provider>
      </div>
      {sel && (
        <aside
          className="w-80 shrink-0 overflow-auto border-l border-line bg-surface p-3 text-xs"
          data-testid="k8s-traffic-panel"
        >
          <div className="font-mono text-[13px] font-semibold text-fg">{sel.peer.name}</div>
          <div className="mb-3 text-faint">
            {sel.peer.ns ? `${sel.peer.ns} · ${sel.peer.kind}` : 'outside the cluster'}
          </div>
          {(['in', 'out'] as const).map((dir) => {
            const list = flows.filter((e) => (dir === 'in' ? e.to : e.from) === sel.id)
            return (
              <section key={dir} className="mb-3">
                <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
                  {dir === 'in' ? 'Called by' : 'Calls'} {list.length}
                </h4>
                {list.length === 0 && <p className="text-faint">None</p>}
                {list.map((e) => {
                  const other = byId.get(dir === 'in' ? e.from : e.to)?.peer
                  if (!other) return null
                  return (
                    <button
                      key={peerKey(other)}
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-hover"
                      onClick={() => {
                        setSelected(peerKey(other))
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-fg">
                        {other.ns ? `${other.ns}/` : ''}
                        {other.name}
                      </span>
                      <span className="shrink-0 text-faint tabular-nums">{formatRate(e.rate)}</span>
                    </button>
                  )
                })}
              </section>
            )
          })}
          {WORKLOAD_KIND_ID[sel.peer.kind] && (
            <button
              type="button"
              className="rounded-md border border-line px-2.5 py-1 font-medium text-fg hover:bg-hover"
              onClick={() => {
                const kind = WORKLOAD_KIND_ID[sel.peer.kind]
                if (kind) onOpen({ kind, ns: sel.peer.ns, name: sel.peer.name })
              }}
            >
              Open {sel.peer.kind}
            </button>
          )}
        </aside>
      )}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="flex flex-1 items-center justify-center p-6 text-center text-xs text-faint"
      data-testid="k8s-traffic-map-empty"
    >
      <p className="max-w-md">{children}</p>
    </div>
  )
}
