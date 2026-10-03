import { createContext, memo, useContext } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
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
import { fitLabel, podGrid, workloadKindLabel, type MapNode, type MapTone } from '../shared/map'
import { BANDS, bandOf, formatRate } from '../shared/traffic'
import { HelmBadge, KindIcon, TechIcon } from './icons'
import { t, tn } from '../../registry/renderer-kit'
import { regionTitle } from './mapModel'

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
  /** Gập / mở một namespace. */
  onToggleNs: (ns: string) => void
  /** Đang chọn một mục (tập trung mạnh); false = chỉ đang rê chuột (làm chìm nhẹ). */
  strong: boolean
  /** Cho hạt photon chạy trên đường traffic (nhìn gần, không giảm chuyển động, không quá nhiều). */
  particles: boolean
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
  /** Nối hai cột khác nhau (cạnh bên → cạnh bên, đường cong). */
  cross?: boolean
  /** Nhãn khi được làm nổi (Ingress → Service: path). */
  label?: string
  /** Traffic khác namespace: đi vòng sang phải chừng này px (cạnh phải → cạnh phải). */
  loop?: number
}>

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
  const far = band === 'far'
  const title = regionTitle(n.label)
  const regionLabel = fitLabel(title, /\s/, n.w * 0.9, 0.8, 1, n.w * 0.06)
  // Vùng không có viền: chỉ một mảng nền rất nhạt + nhãn — bớt "hộp lồng hộp".
  return (
    <div
      className="size-full rounded-[40px]"
      style={{ background: 'var(--map-region)' }}
      data-testid="k8s-map-region"
      data-name={n.label}
    >
      {far ? (
        <div
          className="k8s-far-label flex flex-col px-[2.5%] pt-[1.2%] font-semibold tracking-[0.16em] whitespace-nowrap uppercase"
          style={
            {
              color: 'var(--map-region-label)',
              '--map-far-px': '16px',
              // Vừa bề ngang vùng (chữ hoa giãn ~0.8em mỗi ký tự) — hiện trọn tên vùng.
              '--cap': `${String(Math.round(regionLabel.size))}px`
            } as React.CSSProperties
          }
        >
          {regionLabel.lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2.5 px-7 pt-3.5">
          <span
            className="text-[12px] font-semibold tracking-[0.16em] uppercase"
            style={{ color: 'var(--map-region-label)' }}
          >
            {title}
          </span>
          <span className="text-[11.5px] text-faint">{n.sub}</span>
        </div>
      )}
    </div>
  )
})

/** Nhãn trạng thái gọn ("2 failing", "1 degraded") cho namespace. */
function HealthPills({ n }: { n: MapNode }): React.JSX.Element | null {
  const st = n.stats
  if (!st || (!st.bad && !st.warn)) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium tabular-nums">
      {st.bad > 0 && (
        <span className="rounded-full bg-danger-soft px-1.5 py-px text-danger">
          {tn(st.bad, '{n} failing', '{n} failing')}
        </span>
      )}
      {st.warn > 0 && (
        <span className="rounded-full bg-warning-soft px-1.5 py-px text-warning">
          {tn(st.warn, '{n} degraded', '{n} degraded')}
        </span>
      )}
    </span>
  )
}

/** Vòng tình trạng (khoẻ / suy giảm / hỏng) — SVG nhẹ, thay cho thanh ngang. */
export function DonutRing({
  ok,
  warn,
  bad,
  size = 18,
  stroke = 3,
  className,
  style
}: {
  ok: number
  warn: number
  bad: number
  size?: number
  stroke?: number
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element | null {
  const total = ok + warn + bad
  if (total <= 0) return null
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const segs = [
    { v: ok, color: 'var(--map-ok)' },
    { v: warn, color: 'var(--map-warn)' },
    { v: bad, color: 'var(--map-bad)' }
  ]
  let offset = 0
  return (
    <svg
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      width={size}
      height={size}
      className={cx('shrink-0 -rotate-90', className)}
      style={style}
      role="img"
      aria-label={t('{ok} healthy, {warn} degraded, {bad} failing', { ok, warn, bad })}
      data-testid="k8s-map-health-ring"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--map-island-border)"
        strokeWidth={stroke}
      />
      {segs.map((sg, i) => {
        if (sg.v <= 0) return null
        const len = (sg.v / total) * c
        const el = (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={sg.color}
            strokeWidth={stroke}
            strokeDasharray={`${String(len)} ${String(c)}`}
            strokeDashoffset={-offset}
            strokeLinecap={sg.v === total ? 'butt' : 'butt'}
          />
        )
        offset += len
        return el
      })}
    </svg>
  )
}

const LED: Record<MapTone, string> = {
  ok: 'var(--map-ok)',
  warn: 'var(--map-warn)',
  bad: 'var(--map-bad)',
  muted: 'var(--map-idle)'
}

/** Đèn trạng thái; chỉ nhấp nháy khi hỏng. */
function Led({ tone, title }: { tone: MapTone; title?: string }): React.JSX.Element {
  return (
    <span
      className={cx('k8s-led', tone === 'bad' && 'k8s-led-pulse')}
      style={{ '--led': LED[tone] } as React.CSSProperties}
      title={title}
      data-testid="k8s-map-led"
      data-tone={tone}
    />
  )
}

/** Lớp nổi bật / chìm theo chế độ tập trung. */
function focusClass(ctx: MapCtx, n: MapNode): string | false {
  if (ctx.selected === n.id) return 'k8s-focus'
  if (dimmed(ctx, n)) return ctx.strong || ctx.problemsOnly ? 'k8s-dim' : 'k8s-dim-soft'
  if (ctx.related.size > 0 && ctx.related.has(n.id)) return 'k8s-related'
  return false
}

export const NamespaceNode = memo(function NamespaceNode({
  data
}: NodeProps<MapFlowNode>): React.JSX.Element {
  const n = data.node
  const ctx = useMap()
  const sel = ctx.selected === n.id
  const st = n.stats
  const okN = st ? Math.max(0, st.workloads - st.warn - st.bad) : 0
  const ring = (
    size: number,
    stroke: number,
    props?: { className?: string; style?: React.CSSProperties }
  ) =>
    st && st.workloads > 0 ? (
      <DonutRing ok={okN} warn={st.warn} bad={st.bad} size={size} stroke={stroke} {...props} />
    ) : null
  const toggle = (label: string, size: number): React.JSX.Element => (
    <button
      type="button"
      aria-label={`${label} ${n.label}`}
      title={label}
      data-testid="k8s-map-ns-toggle"
      data-ns={n.ns}
      className="nodrag nopan shrink-0 rounded-md p-0.5 text-faint hover:bg-hover hover:text-fg"
      onClick={(e) => {
        e.stopPropagation()
        if (n.ns) ctx.onToggleNs(n.ns)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
      }}
    >
      {n.collapsed ? <ChevronRight size={size} /> : <ChevronDown size={size} />}
    </button>
  )
  const island = cx('k8s-island size-full', sel && 'k8s-focus')

  if (ctx.band === 'far') {
    // Nhìn xa: tên + số liệu + vòng tình trạng giữa đảo, chữ cỡ cố định trên màn hình.
    // Cỡ chữ vừa đủ để hiện TRỌN tên trên bề ngang đảo (~0.6em mỗi ký tự + vòng tình trạng) —
    // không cắt "cattle-…"; tên quá dài so với đảo thì xuống dòng.
    const nsLabel = fitLabel(n.label, /[-.]/, n.w * 0.86, 0.6, 1.6, n.h * 0.26)
    const cap = `${String(Math.round(nsLabel.size))}px`
    return (
      <div
        className={cx(
          island,
          'flex flex-col items-center justify-center gap-[0.35em] rounded-[28px] px-[6%]'
        )}
        style={
          {
            '--cap': cap,
            // Dòng phụ ("2 workloads · 2 pods") cũng hiện trọn: co theo bề ngang đảo.
            '--cap-sub': `${String(Math.round(Math.min((n.w * 0.86) / (n.sub.length * 0.56), n.h * 0.14)))}px`
          } as React.CSSProperties
        }
      >
        <div className="flex max-w-full items-center gap-[0.4em]">
          {ring(20, 3.5, { className: 'k8s-far-icon' })}
          <span className="k8s-far-label flex flex-col font-semibold whitespace-nowrap text-fg">
            {nsLabel.lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </span>
        </div>
        <div className="k8s-far-sub max-w-full text-center whitespace-nowrap text-faint tabular-nums">
          {n.sub}
        </div>
        {n.techs && n.techs.length > 0 && (
          <div className="flex gap-[0.3em]">
            {n.techs.map((t) => (
              <span key={t} className="k8s-far-icon flex">
                <TechIcon tech={t} size={64} className="size-full" />
              </span>
            ))}
          </div>
        )}
        <Handles />
      </div>
    )
  }

  if (n.collapsed) {
    // Đã gập: thẻ tóm tắt.
    return (
      <div
        className={cx(island, 'flex flex-col justify-center gap-1.5 rounded-[18px] px-3.5')}
        style={{ borderStyle: 'dashed' }}
        data-testid="k8s-map-ns-collapsed"
        data-ns={n.ns}
      >
        <div className="flex items-center gap-1.5">
          {toggle(t('Expand'), 15)}
          <KindIcon kind="namespaces" size={16} />
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">
            {n.label}
          </span>
          {ring(18, 3)}
        </div>
        <div className="flex items-center gap-2 pl-6">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint tabular-nums">
            {n.sub}
          </span>
          <HealthPills n={n} />
          {n.techs?.slice(0, 3).map((t) => (
            <TechIcon key={t} tech={t} size={15} />
          ))}
        </div>
        <Handles />
      </div>
    )
  }

  return (
    <div className={cx(island, 'rounded-[22px]')}>
      <div className="flex h-[34px] items-center gap-2 pr-3.5 pl-2.5">
        {toggle(t('Collapse'), 15)}
        <KindIcon kind="namespaces" size={16} />
        <span className="min-w-0 shrink-[0.15] truncate text-[13.5px] font-semibold tracking-tight text-fg">
          {n.label}
        </span>
        <span className="min-w-0 truncate text-[11.5px] text-faint tabular-nums">{n.sub}</span>
        <span className="flex-1" />
        <HealthPills n={n} />
        {n.techs?.map((t) => (
          <TechIcon key={t} tech={t} size={16} />
        ))}
        {ring(18, 3)}
      </div>
      <Handles />
    </div>
  )
})

export const WorkloadNode = memo(function WorkloadNode({
  data
}: NodeProps<MapFlowNode>): React.JSX.Element {
  const n = data.node
  const ctx = useMap()
  const zoomOk = useStore((s) => s.transform[2] >= PODS_ZOOM)
  const pods = ctx.podsOf.get(n.id) ?? []
  const g = podGrid(pods.length)
  const helm = n.badges?.includes('Helm')
  const badges = n.badges?.filter((b) => b !== 'Helm') ?? []
  const kindLabel = n.ref ? workloadKindLabel(n.ref.kind) : t('Pods')
  const cron = n.ref?.kind === 'cronjobs.batch'
  const job = n.ref?.kind === 'jobs.batch'
  return (
    <div
      className={cx(
        'k8s-card relative flex size-full flex-col overflow-hidden rounded-[11px]',
        focusClass(ctx, n)
      )}
      data-tone={n.tone}
      data-testid="k8s-map-workload"
      data-name={n.label}
    >
      <div className="flex h-[26px] items-center gap-1.5 pt-1 pr-1.5 pl-2.5">
        <Led tone={n.tone} title={n.status ?? ''} />
        <KindIcon kind={n.ref?.kind ?? 'pods'} size={15} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-tight text-fg">
          {n.label}
        </span>
        {n.tech && <TechIcon tech={n.tech} size={16} />}
        {n.replicas && !cron && !job && (
          <span
            className="shrink-0 rounded-md px-1.5 py-px font-mono text-[11px] font-semibold tabular-nums"
            style={{
              color: LED[n.tone],
              background: `color-mix(in srgb, ${LED[n.tone]} 13%, transparent)`
            }}
            title={t('Ready / desired pods')}
          >
            {n.replicas.ready}/{n.replicas.desired}
          </span>
        )}
      </div>
      <div className="flex h-[16px] items-center gap-1 pr-2 pl-[26px] text-[11px] text-faint">
        <span className="shrink-0">{kindLabel}</span>
        {(cron || job || !n.replicas) && n.status && (
          <span className="min-w-0 truncate font-mono">· {n.status}</span>
        )}
        <span className="flex-1" />
        {helm && <HelmBadge size={12} />}
        {badges.map((b) => (
          <span
            key={b}
            className="shrink-0 rounded border border-line px-1 text-[11px] font-medium text-muted"
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
              data-tone={p.tone}
              className={cx(
                'k8s-gem nodrag size-[10px]',
                ctx.selected === p.id && 'outline-2 outline-offset-1 outline-[var(--map-accent)]',
                dimmed(ctx, p) && !ctx.related.has(n.id) && 'opacity-25'
              )}
              style={{ '--gem': LED[p.tone] } as React.CSSProperties}
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
  const route = n.kind === 'route' || n.kind === 'gateway'
  return (
    <div
      className={cx(
        'k8s-card flex size-full items-center gap-1.5 rounded-[9px] px-2',
        n.kind === 'policy' && '!border-dashed',
        route && 'k8s-route',
        focusClass(ctx, n)
      )}
      data-tone={n.kind === 'pvc' ? n.tone : 'ok'}
      data-testid="k8s-map-pill"
      data-kind={n.kind}
      data-name={n.label}
      title={`${n.label} — ${n.sub}`}
    >
      <KindIcon kind={n.ref?.kind ?? PILL_KIND[n.kind] ?? 'services'} size={15} />
      <span className="min-w-0 truncate text-[11.5px] font-medium text-fg">{n.label}</span>
      <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-faint">
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

/** Số hạt photon theo băng thông (băng 0 → 4). */
const PHOTONS = [1, 1, 2, 3, 4]

/**
 * Cạnh quan hệ (gấp khúc bo góc) / traffic: sợi cáp có quầng sáng, màu và độ dày theo băng thông;
 * hạt photon chạy theo hướng dữ liệu (chỉ khi được phép — nhìn gần, không bật giảm chuyển động).
 */
export const MapEdgeComp = memo(function MapEdgeComp(
  props: EdgeProps<MapFlowEdge>
): React.JSX.Element {
  const ctx = useMap()
  const d = props.data
  const traffic = d?.kind === 'traffic'
  const [path, lx, ly] = d?.loop
    ? loopPath(props.sourceX, props.sourceY, props.targetX, props.targetY, d.loop)
    : traffic || d?.cross
      ? getBezierPath(props)
      : getSmoothStepPath({ ...props, borderRadius: 12, offset: 16 })
  const focusing = ctx.related.size > 0
  const hot = focusing && ctx.related.has(props.source) && ctx.related.has(props.target)
  const faded = focusing && !hot
  const color = d?.color ?? 'currentColor'
  if (d?.kind === 'traffic') {
    const band = bandOf(d.rate ?? 0)
    const width = BANDS[band]?.width ?? 1.5
    const photons = ctx.particles && (!focusing || hot) ? (PHOTONS[band] ?? 1) : 0
    const dist = Math.hypot(props.targetX - props.sourceX, props.targetY - props.sourceY)
    const dur = Math.min(7, Math.max(1.4, dist / 110)) / (1 + band * 0.18)
    const r = Math.max(1.8, width * 0.55)
    return (
      <g
        data-testid="k8s-map-traffic-edge"
        data-source={props.source}
        data-target={props.target}
        data-band={band}
        style={{
          opacity: faded ? (ctx.strong ? 0.08 : 0.35) : 1,
          transition: 'opacity 160ms ease'
        }}
      >
        {/* Quầng sáng dưới sợi cáp. */}
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={width * 3.4 + 2}
          strokeOpacity={hot ? 0.22 : 0.12}
          strokeLinecap="round"
          pointerEvents="none"
        />
        <BaseEdge
          id={props.id}
          path={path}
          {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
          style={{ stroke: color, strokeWidth: width, strokeOpacity: 0.9, strokeLinecap: 'round' }}
        />
        {Array.from({ length: photons }, (_, i) => (
          <circle
            key={i}
            r={r}
            fill="#ffffff"
            stroke={color}
            strokeWidth={r * 0.9}
            className="k8s-photon"
            style={{ color }}
            data-testid="k8s-map-photon"
            pointerEvents="none"
          >
            <animateMotion
              dur={`${dur.toFixed(2)}s`}
              begin={`${(-(i * dur) / photons).toFixed(2)}s`}
              repeatCount="indefinite"
              path={path}
            />
          </circle>
        ))}
        {(hot || props.selected) && (
          <EdgeLabelRenderer>
            <div
              className="pointer-events-none absolute rounded-md border px-1.5 py-0.5 text-[11px] font-semibold text-fg tabular-nums shadow"
              style={{
                transform: `translate(-50%, -50%) translate(${String(lx)}px, ${String(ly)}px)`,
                background: 'var(--map-card)',
                borderColor: color
              }}
            >
              {formatRate(d.rate ?? 0)}
            </div>
          </EdgeLabelRenderer>
        )}
      </g>
    )
  }
  const dash = d?.kind === 'storage' ? '4 4' : d?.kind === 'policy' ? '6 4' : undefined
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
        style={{
          stroke: color,
          strokeWidth: hot ? 2.2 : 1.3,
          strokeOpacity: faded ? (ctx.strong ? 0.07 : 0.2) : hot ? 1 : 0.45,
          ...(hot ? { filter: `drop-shadow(0 0 3px ${color})` } : {}),
          ...(dash ? { strokeDasharray: dash } : {}),
          transition: 'stroke-opacity 160ms ease'
        }}
      />
      {hot && d?.label && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute max-w-56 truncate rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-fg shadow"
            style={{
              transform: `translate(-50%, -50%) translate(${String(lx)}px, ${String(ly)}px)`,
              background: 'var(--map-card)',
              borderColor: color
            }}
            data-testid="k8s-map-edge-label"
          >
            {d.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

export const EDGE_TYPES = { map: MapEdgeComp }

/** Đường cong đi vòng ra bên phải (cạnh phải nguồn → cạnh phải đích). */
function loopPath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  loop: number
): [string, number, number] {
  // Đỉnh của đường cong (t = 0.5) nằm ở max(sx, tx) + loop: hai điểm điều khiển cùng hoành độ
  // c → x(0.5) = (sx + tx) / 8 + 3c / 4.
  const peak = Math.max(sx, tx) + loop
  const cx = (peak - (sx + tx) / 8) / 0.75
  const path = `M${String(sx)},${String(sy)} C${String(cx)},${String(sy)} ${String(cx)},${String(ty)} ${String(tx)},${String(ty)}`
  // Điểm giữa của đường cong bậc ba (t = 0.5) — chỗ đặt nhãn tốc độ.
  return [path, (sx + tx) / 8 + (3 * cx) / 4, (sy + ty) / 2]
}

export { workloadKindLabel }
