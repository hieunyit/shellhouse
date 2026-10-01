import { createContext, memo, useContext } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  Handle,
  Position,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { cx } from '../../../renderer/src/components/ui'
import { podGrid, workloadKindLabel, type MapNode, type MapTone } from '../shared/map'
import { BANDS, bandOf, formatRate } from '../shared/traffic'
import { HelmBadge, KindIcon, TechIcon } from './icons'

/**
 * Node / cạnh của bản đồ cluster trên React Flow. Trạng thái thay đổi thường (chọn, quan hệ, chỉ
 * xem lỗi) đi qua context — mảng node giữ nguyên, React Flow chỉ vẽ lại node đang thấy.
 */

/** Mức chi tiết: far = vùng + namespace; near = thẻ workload, service, route, PVC, cạnh. */
export type Band = 'far' | 'near'
export const NEAR_ZOOM = 0.34
/** Từ mức này mới hiện chấm pod trong thẻ. */
export const PODS_ZOOM = 0.42

export interface MapCtx {
  band: Band
  selected: string | null
  related: ReadonlySet<string>
  problemsOnly: boolean
  showPods: boolean
  /** Pod trong thẻ workload (id thẻ → pod). */
  podsOf: ReadonlyMap<string, MapNode[]>
  onSelect: (id: string) => void
  onHoverPod: (pod: MapNode | null, e?: React.PointerEvent) => void
}

export const MapContext = createContext<MapCtx | null>(null)
const useMap = (): MapCtx => {
  const c = useContext(MapContext)
  if (!c) throw new Error('MapContext missing')
  return c
}

export type MapFlowNode = Node<{ node: MapNode }, MapNode['kind']>
export type MapFlowEdge = Edge<{
  kind: 'route' | 'select' | 'storage' | 'attach' | 'policy' | 'traffic'
  rate?: number
  color: string
}>

const TONE_BORDER: Record<MapTone, string> = {
  ok: 'border-line-strong',
  warn: 'border-warning',
  bad: 'border-danger',
  muted: 'border-line-strong'
}
const TONE_BG: Record<MapTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger-solid',
  muted: 'bg-line-strong'
}

function dimmed(ctx: MapCtx, n: MapNode): boolean {
  if (
    ctx.problemsOnly &&
    (n.kind === 'workload' || n.kind === 'pod' || n.kind === 'pvc') &&
    n.tone === 'ok'
  )
    return true
  return ctx.related.size > 0 && !ctx.related.has(n.id)
}

/** Handle ẩn: cạnh nối trên / dưới (quan hệ) và trái / phải (traffic). */
function Handles(): React.JSX.Element {
  const cls = '!pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'
  return (
    <>
      {(
        [
          ['t', Position.Top],
          ['b', Position.Bottom],
          ['l', Position.Left],
          ['r', Position.Right]
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

/** Cạnh nối theo vị trí tương đối (ngang khi lệch ngang nhiều hơn lệch dọc). */
export function sides(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): { sourceHandle: string; targetHandle: string } {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2)
  const dy = b.y + b.h / 2 - (a.y + a.h / 2)
  if (Math.abs(dx) > Math.abs(dy))
    return dx > 0
      ? { sourceHandle: 'sr', targetHandle: 'tl' }
      : { sourceHandle: 'sl', targetHandle: 'tr' }
  return dy > 0
    ? { sourceHandle: 'sb', targetHandle: 'tt' }
    : { sourceHandle: 'st', targetHandle: 'tb' }
}

export const RegionNode = memo(function RegionNode({
  data
}: NodeProps<MapFlowNode>): React.JSX.Element {
  const n = data.node
  const { band } = useMap()
  // Nhìn xa: chữ theo đơn vị thế giới (tỉ lệ với vùng) — vẫn đọc được tên vùng.
  const far = band === 'far'
  const size = far ? Math.min(200, Math.max(26, n.w * 0.028)) : 13
  return (
    <div
      className="size-full rounded-[32px] border border-line bg-subtle/60"
      data-testid="k8s-map-region"
    >
      <div
        className="flex items-baseline gap-3 truncate px-7 pt-3.5"
        style={{ fontSize: size, lineHeight: 1.2 }}
      >
        <span className="font-semibold tracking-[0.14em] text-muted uppercase">{n.label}</span>
        {!far && <span className="text-[12px] font-normal text-faint">{n.sub}</span>}
      </div>
    </div>
  )
})

/** Nhãn trạng thái gọn ("2 failing", "1 degraded") cho namespace / vùng. */
function HealthPills({ n, size = 11 }: { n: MapNode; size?: number }): React.JSX.Element | null {
  const st = n.stats
  if (!st || (!st.bad && !st.warn)) return null
  return (
    <span className="flex shrink-0 items-center gap-1" style={{ fontSize: size }}>
      {st.bad > 0 && (
        <span className="rounded-full bg-danger-soft px-1.5 py-px font-medium text-danger">
          {st.bad} failing
        </span>
      )}
      {st.warn > 0 && (
        <span className="rounded-full bg-warning-soft px-1.5 py-px font-medium text-warning">
          {st.warn} degraded
        </span>
      )}
    </span>
  )
}

export const NamespaceNode = memo(function NamespaceNode({
  data
}: NodeProps<MapFlowNode>): React.JSX.Element {
  const n = data.node
  const ctx = useMap()
  const sel = ctx.selected === n.id
  const st = n.stats
  const okN = st ? Math.max(0, st.workloads - st.warn - st.bad) : 0
  const health = st && st.workloads > 0 && (
    <div className="flex size-full overflow-hidden rounded-full bg-line">
      <div className="bg-success" style={{ flex: okN }} />
      <div className="bg-warning" style={{ flex: st.warn }} />
      <div className="bg-danger-solid" style={{ flex: st.bad }} />
    </div>
  )
  if (ctx.band === 'far') {
    // Nhìn xa: tên to giữa đảo, số liệu, logo công nghệ, thanh tình trạng — cỡ theo đảo.
    const fs = Math.max(14, Math.min(n.w * 0.08, n.h * 0.18, 84))
    return (
      <div
        className={cx(
          'flex size-full flex-col items-center justify-center rounded-3xl border bg-surface shadow-sm',
          sel ? 'border-accent ring-4 ring-accent/30' : 'border-line-strong'
        )}
        style={{ padding: fs * 0.4, gap: fs * 0.22 }}
      >
        <div
          className="max-w-full truncate font-semibold text-fg"
          style={{ fontSize: fs, lineHeight: 1.1 }}
        >
          {n.label}
        </div>
        <div className="max-w-full truncate text-faint" style={{ fontSize: fs * 0.5 }}>
          {n.sub}
        </div>
        {n.techs && n.techs.length > 0 && (
          <div className="flex" style={{ gap: fs * 0.2 }}>
            {n.techs.map((t) => (
              <TechIcon key={t} tech={t} size={fs * 0.95} />
            ))}
          </div>
        )}
        {health && (
          <div style={{ width: '70%', height: Math.max(4, fs * 0.18) }} className="mt-auto">
            {health}
          </div>
        )}
        <Handles />
      </div>
    )
  }
  return (
    <div
      className={cx(
        'size-full overflow-hidden rounded-2xl border bg-surface shadow-sm',
        sel ? 'border-accent ring-4 ring-accent/25' : 'border-line-strong'
      )}
    >
      <div className="flex h-[34px] items-center gap-2 border-b border-line bg-subtle px-3.5">
        <KindIcon kind="namespaces" size={17} />
        <span className="max-w-[45%] shrink-0 truncate text-[14px] font-semibold text-fg">
          {n.label}
        </span>
        <span className="min-w-0 truncate text-[11.5px] text-faint">{n.sub}</span>
        <span className="flex-1" />
        <HealthPills n={n} />
        {n.techs?.map((t) => (
          <TechIcon key={t} tech={t} size={17} />
        ))}
        {health && <div className="h-1.5 w-16 shrink-0">{health}</div>}
      </div>
      <Handles />
    </div>
  )
})

const REPLICA_TONE: Record<MapTone, string> = {
  ok: 'bg-success-soft text-success',
  warn: 'bg-warning-soft text-warning',
  bad: 'bg-danger-soft text-danger',
  muted: 'bg-subtle text-faint'
}

export const WorkloadNode = memo(function WorkloadNode({
  data
}: NodeProps<MapFlowNode>): React.JSX.Element {
  const n = data.node
  const ctx = useMap()
  const zoomOk = useStore((s) => s.transform[2] >= PODS_ZOOM)
  const sel = ctx.selected === n.id
  const pods = ctx.podsOf.get(n.id) ?? []
  const g = podGrid(pods.length)
  const helm = n.badges?.includes('Helm')
  const badges = n.badges?.filter((b) => b !== 'Helm') ?? []
  const kindLabel = n.ref ? workloadKindLabel(n.ref.kind) : 'Pods'
  const cron = n.ref?.kind === 'cronjobs.batch'
  const job = n.ref?.kind === 'jobs.batch'
  return (
    <div
      className={cx(
        'relative flex size-full flex-col overflow-hidden rounded-lg border bg-surface shadow-[0_1px_2px_rgb(16_24_40/0.06)] transition-[opacity,box-shadow]',
        sel
          ? 'border-accent ring-2 ring-accent/30'
          : n.tone === 'bad'
            ? 'border-danger/50'
            : n.tone === 'warn'
              ? 'border-warning/50'
              : 'border-line-strong',
        dimmed(ctx, n) && 'opacity-25'
      )}
      data-testid="k8s-map-workload"
      data-name={n.label}
    >
      <div className={cx('absolute inset-y-0 left-0 w-[3px]', TONE_BG[n.tone])} />
      <div className="flex h-[25px] items-center gap-1.5 pt-1 pr-1.5 pl-2.5">
        <KindIcon kind={n.ref?.kind ?? 'pods'} size={16} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-fg">
          {n.label}
        </span>
        {n.tech && <TechIcon tech={n.tech} size={17} />}
        {n.replicas && !cron && !job && (
          <span
            className={cx(
              'shrink-0 rounded px-1 font-mono text-[10.5px] font-semibold tabular-nums',
              REPLICA_TONE[n.tone]
            )}
            title="Ready / desired pods"
          >
            {n.replicas.ready}/{n.replicas.desired}
          </span>
        )}
      </div>
      <div className="flex h-[17px] items-center gap-1 pr-2 pl-2.5 text-[10.5px] text-faint">
        <span className="shrink-0">{kindLabel}</span>
        {(cron || job || !n.replicas) && n.status && (
          <span className="min-w-0 truncate font-mono">· {n.status}</span>
        )}
        <span className="flex-1" />
        {helm && <HelmBadge size={12} />}
        {badges.map((b) => (
          <span
            key={b}
            className="shrink-0 rounded border border-line px-1 text-[9.5px] font-medium text-muted"
          >
            {b}
          </span>
        ))}
      </div>
      {ctx.showPods && zoomOk && pods.length > 0 && (
        <div
          className="mt-[4px] grid pl-[10px]"
          style={{ gridTemplateColumns: `repeat(${String(g.cols)}, 10px)`, gap: 4 }}
        >
          {pods.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-label={p.label}
              data-testid="k8s-map-pod"
              className={cx(
                'nodrag size-[10px] rounded-[3px] hover:ring-2 hover:ring-accent',
                TONE_BG[p.tone],
                ctx.selected === p.id && 'ring-2 ring-fg',
                dimmed(ctx, p) && !ctx.related.has(n.id) && 'opacity-30'
              )}
              onClick={(e) => {
                e.stopPropagation()
                ctx.onSelect(p.id)
              }}
              onPointerEnter={(e) => {
                ctx.onHoverPod(p, e)
              }}
              onPointerLeave={() => {
                ctx.onHoverPod(null)
              }}
            />
          ))}
        </div>
      )}
      <Handles />
    </div>
  )
})

const PILL_KIND: Record<string, string> = {
  service: 'services',
  pvc: 'persistentvolumeclaims',
  policy: 'networkpolicies.networking.k8s.io',
  gateway: 'gateways.gateway.networking.k8s.io'
}

export const PillNode = memo(function PillNode({
  data
}: NodeProps<MapFlowNode>): React.JSX.Element {
  const n = data.node
  const ctx = useMap()
  const sel = ctx.selected === n.id
  const route = n.kind === 'route' || n.kind === 'gateway'
  return (
    <div
      className={cx(
        'flex size-full items-center gap-1.5 rounded-md border bg-surface px-2 shadow-[0_1px_2px_rgb(16_24_40/0.05)] transition-opacity',
        sel
          ? 'border-accent ring-2 ring-accent/30'
          : route
            ? 'border-accent/40'
            : n.kind === 'policy'
              ? 'border-dashed border-line-strong'
              : n.kind === 'pvc' && n.tone !== 'ok'
                ? TONE_BORDER[n.tone]
                : 'border-line',
        dimmed(ctx, n) && 'opacity-25'
      )}
      data-testid="k8s-map-pill"
      data-kind={n.kind}
      data-name={n.label}
      title={`${n.label} — ${n.sub}`}
    >
      <KindIcon kind={n.ref?.kind ?? PILL_KIND[n.kind] ?? 'services'} size={16} />
      <span className="min-w-0 truncate text-[11.5px] font-medium text-fg">{n.label}</span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-[9.5px] text-faint">
        {n.sub}
      </span>
      <Handles />
    </div>
  )
})

export const NODE_TYPES = {
  region: RegionNode,
  namespace: NamespaceNode,
  workload: WorkloadNode,
  service: PillNode,
  route: PillNode,
  gateway: PillNode,
  pvc: PillNode,
  policy: PillNode
}

/** Cạnh quan hệ (cong) / traffic (dày theo băng cố định, chạy chấm theo hướng). */
export const MapEdgeComp = memo(function MapEdgeComp(
  props: EdgeProps<MapFlowEdge>
): React.JSX.Element {
  const ctx = useMap()
  const d = props.data
  const traffic = d?.kind === 'traffic'
  // Quan hệ: đường gấp khúc bo góc (gọn, không chéo lung tung); traffic: đường cong.
  const [path, lx, ly] = traffic
    ? getBezierPath(props)
    : getSmoothStepPath({ ...props, borderRadius: 10, offset: 14 })
  const hot = ctx.related.size > 0 && ctx.related.has(props.source) && ctx.related.has(props.target)
  const faded = ctx.related.size > 0 && !hot
  if (d?.kind === 'traffic') {
    const band = bandOf(d.rate ?? 0)
    const width = BANDS[band]?.width ?? 1.5
    return (
      <g data-testid="k8s-map-traffic-edge" data-source={props.source} data-target={props.target}>
        <BaseEdge
          id={props.id}
          path={path}
          {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
          style={{
            stroke: d.color,
            strokeWidth: width,
            strokeOpacity: faded ? 0.12 : 0.85,
            strokeLinecap: 'round'
          }}
        />
        <path
          d={path}
          fill="none"
          stroke="var(--sh-surface)"
          strokeWidth={Math.max(1, width / 3)}
          strokeDasharray="2 14"
          className="k8s-traffic-flow"
          style={{ opacity: faded ? 0.1 : 0.9 }}
          pointerEvents="none"
        />
        {(hot || props.selected) && (
          <EdgeLabelRenderer>
            <div
              className="pointer-events-none absolute rounded bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-fg shadow"
              style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            >
              {formatRate(d.rate ?? 0)}
            </div>
          </EdgeLabelRenderer>
        )}
      </g>
    )
  }
  const dash = d?.kind === 'storage' ? '4 3' : d?.kind === 'policy' ? '6 3' : undefined
  return (
    <BaseEdge
      id={props.id}
      path={path}
      {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
      style={{
        stroke: d?.color,
        strokeWidth: hot ? 2 : 1.25,
        strokeOpacity: faded ? 0.1 : hot ? 1 : 0.5,
        ...(dash ? { strokeDasharray: dash } : {})
      }}
    />
  )
})

export const EDGE_TYPES = { map: MapEdgeComp }

export { workloadKindLabel }
