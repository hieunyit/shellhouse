import { createContext, memo, useContext } from 'react'
import { ChevronDown, ChevronRight, ChevronsUpDown, Lock, ShieldAlert } from 'lucide-react'
import {
  Handle,
  Position,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import { cx } from '../../../../renderer/src/components/ui'
import { t, tn } from '../../../registry/renderer-kit'
import {
  MAX_POD_ROWS,
  POD_DOTS_PER_ROW,
  POD_DOT_ROWS,
  ROUTE_INDENT,
  type PlacedTopoEdge,
  type PlacedTopoNode,
  type TopoBand,
  type TopoBadge
} from '../../shared/appTopology'
import type { MapPod, MapTone } from '../../shared/map'
import { BANDS } from '../../shared/traffic'
import { HelmBadge, KindIcon, TechIcon } from '../icons'
import { bandFor, idleBelow, rateText, useTrafficUnit } from '../trafficUnit'

/**
 * Thẻ và đường nối của Topology tĩnh (React Flow). Trạng thái hay đổi (chọn, rê chuột, tìm, chỉ xem
 * lỗi, traffic) đi qua context — mảng node giữ nguyên, chỉ thẻ đang thấy vẽ lại.
 */

export interface TopoTraffic {
  /** Workload id → byte/giây vào / ra. */
  rates: ReadonlyMap<string, { in: number; out: number }>
  updated: number
}

export interface TopoCtx {
  selected: string | null
  /** Pod đang chọn trong danh sách pod (tên). */
  selectedPod: string | null
  /** Đường đi đang làm nổi (chọn / rê chuột) — null = không. */
  lit: ReadonlySet<string> | null
  /** Đang chọn (làm chìm mạnh) hay chỉ rê chuột (chìm nhẹ). */
  strong: boolean
  /** Khớp ô tìm. */
  matches: ReadonlySet<string> | null
  problemsOnly: boolean
  /**
   * Thu nhỏ xa (zoom < FAR_ZOOM): thẻ rút gọn — icon + tên chữ lớn + vạch màu sức khoẻ, bỏ dòng phụ;
   * cỡ chữ theo biến CSS --topo-zoom (đặt trên khung) để luôn đọc được trên màn hình.
   */
  far: boolean
  /** Rất xa (zoom < TINY_ZOOM): bỏ cả icon — nhường hết chỗ cho tên. */
  tiny: boolean
  traffic: TopoTraffic | null
  onToggleNs: (ns: string) => void
  onShowAll: (ns: string) => void
  onTogglePods: (workload: string) => void
  onSelectPod: (group: string, pod: MapPod) => void
}

export const TopoContext = createContext<TopoCtx | null>(null)
/** Dưới mức zoom này chữ thường (11–13 px) còn < 7 px trên màn hình: chuyển sang thẻ rút gọn. */
export const FAR_ZOOM = 0.55
export const TINY_ZOOM = 0.35
const useTopo = (): TopoCtx => {
  const c = useContext(TopoContext)
  if (!c) throw new Error('TopoContext missing')
  return c
}

export type TopoFlowNode =
  | Node<{ node: PlacedTopoNode }, 'card' | 'workload' | 'pods' | 'namespace' | 'more'>
  | Node<{ band: TopoBand; label: string; stats: string; bad: number; warn: number }, 'band'>
export type TopoFlowEdge = Edge<{ edge: PlacedTopoEdge; rate?: number; label?: boolean }, 'topo'>

const LED: Record<MapTone, string> = {
  ok: 'var(--map-ok)',
  warn: 'var(--map-warn)',
  bad: 'var(--map-bad)',
  muted: 'var(--map-idle)'
}

/** Id loại (icon) theo loại thẻ. */
const ICON_KIND: Record<string, string> = {
  gateway: 'gateways.gateway.networking.k8s.io',
  ingress: 'ingresses.networking.k8s.io',
  lb: 'services',
  route: 'httproutes.gateway.networking.k8s.io',
  service: 'services',
  configmap: 'configmaps',
  secret: 'secrets',
  pvc: 'persistentvolumeclaims',
  pods: 'pods',
  namespace: 'namespaces'
}

/** Cỡ (px của bản đồ) để trên màn hình được `screen` px — không quá `cap`. */
const farSize = (screen: number, cap: number): string =>
  `min(calc(${String(screen)}px / var(--topo-zoom, 1)), ${String(cap)}px)`

/**
 * Thẻ rút gọn khi thu nhỏ xa: vạch màu sức khoẻ bên trái, icon loại, tên chữ lớn (≥ 10 px trên
 * màn hình), số phụ (sẵn sàng / số pod) nếu có. Giữ nguyên data-* để tìm / kiểm thử như thẻ thường.
 */
function FarCard({
  n,
  kind,
  icon,
  label,
  aside,
  className
}: {
  n: PlacedTopoNode
  kind: string
  icon: string
  label: string
  aside?: string | undefined
  className?: string | false | undefined
}): React.JSX.Element {
  const ctx = useTopo()
  const problem = n.problems.some((p) => p.severity !== 'info')
  const tone: MapTone = n.missing ? 'bad' : problem || n.tone !== 'muted' ? n.tone : 'muted'
  // Tên tối đa hai dòng (ưu tiên ngắt ở dấu "-"): thu nhỏ rất xa vẫn đọc được phần lớn tên.
  const font = farSize(10, Math.min(40, n.h * 0.45))
  return (
    <div
      className={cx(
        'k8s-card relative flex size-full items-center overflow-hidden rounded-[10px]',
        n.missing && '!border-dashed',
        className
      )}
      data-tone={n.tone}
      data-testid="k8s-topo-node"
      data-kind={kind}
      data-name={n.kind === 'pods' ? n.id.slice('pods:'.length) : n.name}
      data-problems={n.problems.length || undefined}
      data-far="true"
      title={label}
    >
      <span className="absolute inset-y-0 left-0 w-2" style={{ background: LED[tone] }} />
      <div
        className={cx(
          'flex min-w-0 flex-1 items-center',
          ctx.tiny ? 'gap-1.5 pr-2 pl-4' : 'gap-2.5 pr-3 pl-5'
        )}
      >
        {!ctx.tiny && <KindIcon kind={icon} size={Math.round(Math.min(32, n.h * 0.4))} />}
        <span
          className={cx(
            'line-clamp-2 min-w-0 flex-1 leading-[1.08] font-semibold tracking-tight [overflow-wrap:break-word] hyphens-none',
            n.missing ? 'text-danger' : 'text-fg'
          )}
          style={{ fontSize: font }}
        >
          {label}
        </span>
        {aside && (
          <span
            className="shrink-0 font-mono font-semibold tabular-nums"
            style={{ fontSize: font, color: LED[tone] }}
          >
            {aside}
          </span>
        )}
      </div>
      <Handles />
    </div>
  )
}

function Handles(): React.JSX.Element {
  const cls = '!pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'
  return (
    <>
      <Handle id="l" type="target" position={Position.Left} className={cls} />
      <Handle id="r" type="source" position={Position.Right} className={cls} />
    </>
  )
}

/** Lớp nổi / chìm theo chế độ tập trung, tìm kiếm, chỉ xem lỗi. */
function focusClass(ctx: TopoCtx, n: PlacedTopoNode): string | false {
  if (ctx.selected === n.id) return 'k8s-focus'
  if (ctx.lit && !ctx.lit.has(n.id)) return ctx.strong ? 'k8s-dim' : 'k8s-dim-soft'
  if (ctx.matches && !ctx.matches.has(n.id)) return 'k8s-dim-soft'
  if (ctx.problemsOnly && !n.problems.some((p) => p.severity !== 'info') && n.tone !== 'bad')
    return 'k8s-dim'
  if (ctx.lit?.has(n.id)) return 'k8s-related'
  return false
}

function Badge({ b }: { b: TopoBadge }): React.JSX.Element {
  const tone = b.tone ?? 'info'
  const color =
    tone === 'bad'
      ? 'var(--map-bad)'
      : tone === 'warn'
        ? 'var(--map-warn)'
        : tone === 'ok'
          ? 'var(--map-ok)'
          : 'var(--map-accent)'
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap"
      style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
      title={b.title}
      data-testid="k8s-topo-badge"
    >
      {b.text === 'TLS' && <Lock size={10} />}
      {b.text === t('Isolated') && <ShieldAlert size={10} />}
      {b.text}
    </span>
  )
}

/** Đầu thẻ: icon, loại + dòng phụ, tên. */
function CardHead({
  n,
  right,
  icon
}: {
  n: PlacedTopoNode
  right?: React.ReactNode
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-[50px] shrink-0 items-center gap-2.5 pr-2.5 pl-3">
      {icon ?? <KindIcon kind={n.ref?.kind ?? ICON_KIND[n.kind] ?? 'pods'} size={24} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] leading-4 text-faint">
          <span className="shrink-0">{n.title}</span>
          {n.sub && (
            <span className="min-w-0 truncate" title={n.sub}>
              · {n.sub}
            </span>
          )}
        </div>
        <div
          className={cx(
            'truncate text-[13px] leading-5 font-semibold tracking-tight',
            n.missing ? 'text-danger' : 'text-fg'
          )}
          title={n.name}
        >
          {n.name}
        </div>
      </div>
      {right}
    </div>
  )
}

/** Thẻ chung: Ingress / Gateway / Route / LoadBalancer / Service / ConfigMap / Secret / PVC. */
export const CardNode = memo(function CardNode({
  data
}: NodeProps<TopoFlowNode>): React.JSX.Element {
  const ctx = useTopo()
  if (!('node' in data)) return <></>
  const n = data.node
  const service = n.kind === 'service'
  if (ctx.far)
    return (
      <FarCard
        n={n}
        kind={n.kind}
        icon={n.ref?.kind ?? ICON_KIND[n.kind] ?? 'pods'}
        label={n.name}
        className={focusClass(ctx, n)}
      />
    )
  return (
    <div
      className={cx(
        'k8s-card relative flex size-full flex-col overflow-hidden rounded-[10px]',
        n.missing && '!border-dashed',
        focusClass(ctx, n)
      )}
      data-tone={n.tone}
      data-testid="k8s-topo-node"
      data-kind={n.kind}
      data-name={n.name}
      data-problems={n.problems.length || undefined}
    >
      <CardHead
        n={n}
        right={
          n.badges?.length ? (
            <span className="flex shrink-0 flex-col items-end gap-1">
              {n.badges.map((b) => (
                <Badge key={b.text} b={b} />
              ))}
            </span>
          ) : n.problems.some((p) => p.severity === 'bad') ? (
            <span
              className="k8s-led k8s-led-pulse"
              style={{ '--led': LED.bad } as React.CSSProperties}
            />
          ) : null
        }
      />
      {(n.rows ?? []).map((r, i) => (
        <div
          key={i}
          className={cx(
            'flex h-[22px] shrink-0 items-center gap-2 border-t px-3 text-[12px]',
            'border-[color-mix(in_srgb,var(--map-card-border)_60%,transparent)]'
          )}
          data-testid="k8s-topo-row"
          // Cả dòng (đường dẫn → backend) thành một chú thích: từng nửa bị cắt thì tooltip nửa kia vô ích.
          title={r.hint ? `${r.text}  ${r.hint}` : r.text}
        >
          <span
            className={cx(
              'min-w-0 truncate font-mono',
              r.tone === 'bad' ? 'text-danger' : r.tone === 'warn' ? 'text-warning' : 'text-fg'
            )}
          >
            {r.text}
          </span>
          {r.hint && (
            <span
              className={cx(
                'ml-auto min-w-0 shrink truncate font-mono',
                r.tone === 'bad' ? 'text-danger' : 'text-faint'
              )}
            >
              {r.hint}
            </span>
          )}
        </div>
      ))}
      {service && (
        <StatusLine
          tone={n.problems.find((p) => p.severity !== 'info') ? n.tone : n.missing ? 'bad' : 'ok'}
          text={n.problems.find((p) => p.severity !== 'info')?.text ?? n.status ?? ''}
          className="mt-auto border-t border-[color-mix(in_srgb,var(--map-card-border)_60%,transparent)]"
        />
      )}
      <Handles />
    </div>
  )
})

function StatusLine({
  tone,
  text,
  className
}: {
  tone: MapTone
  text: string
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cx('flex h-[26px] shrink-0 items-center gap-1.5 px-3 text-[12px]', className)}
      data-testid="k8s-topo-status"
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: LED[tone] }} />
      <span
        className={cx(
          'min-w-0 truncate',
          tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-muted'
        )}
        title={text}
      >
        {text}
      </span>
    </div>
  )
}

/** Thẻ workload: đèn trạng thái, tên, sẵn sàng / mong muốn, công nghệ, HPA, policy, dòng trạng thái. */
export const WorkloadCard = memo(function WorkloadCard({
  data
}: NodeProps<TopoFlowNode>): React.JSX.Element {
  const unit = useTrafficUnit()
  const ctx = useTopo()
  if (!('node' in data)) return <></>
  const n = data.node
  const rate = ctx.traffic?.rates.get(n.id)
  const problem = n.problems.find((p) => p.severity !== 'info')
  if (ctx.far)
    return (
      <FarCard
        n={n}
        kind="workload"
        icon={n.ref?.kind ?? 'pods'}
        label={n.name}
        className={focusClass(ctx, n)}
      />
    )
  return (
    <div
      className={cx(
        'k8s-card relative flex size-full flex-col overflow-hidden rounded-[10px]',
        focusClass(ctx, n)
      )}
      data-tone={n.tone}
      data-testid="k8s-topo-node"
      data-kind="workload"
      data-name={n.name}
      data-problems={n.problems.length || undefined}
    >
      <CardHead
        n={{ ...n, sub: '' }}
        right={
          n.replicas ? (
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
          ) : undefined
        }
      />
      <div className="-mt-1 flex h-[18px] shrink-0 items-center gap-1.5 overflow-hidden px-3">
        {n.tech && <TechIcon tech={n.tech} size={14} />}
        {n.helm && <HelmBadge size={13} />}
        {(n.badges ?? []).map((b) => (
          <Badge key={b.text} b={b} />
        ))}
        {rate && (rate.in >= idleBelow(unit) || rate.out >= idleBelow(unit)) && (
          <span
            className="ml-auto shrink-0 font-mono text-[11px] text-faint tabular-nums"
            title={t('Live traffic: in / out')}
            data-testid="k8s-topo-rate"
          >
            ↓{rateText(unit)(rate.in)} ↑{rateText(unit)(rate.out)}
          </span>
        )}
      </div>
      <StatusLine
        tone={problem ? n.tone : n.tone === 'muted' ? 'muted' : 'ok'}
        text={n.status ?? ''}
        className="mt-auto"
      />
      {problem && n.problems.length > 1 && (
        <span
          className="absolute right-2.5 bottom-[5px] rounded-full bg-subtle px-1.5 text-[11px] text-muted tabular-nums"
          title={n.problems.map((p) => p.text).join('\n')}
        >
          +{n.problems.length - 1}
        </span>
      )}
      <Handles />
    </div>
  )
})

/** Nhóm pod: chấm trạng thái (gọn) hoặc danh sách từng pod (mở rộng). */
export const PodsCard = memo(function PodsCard({
  data
}: NodeProps<TopoFlowNode>): React.JSX.Element {
  const ctx = useTopo()
  if (!('node' in data)) return <></>
  const n = data.node
  const pods = n.pods ?? []
  const workload = n.id.slice('pods:'.length)
  const counts = new Map<string, { n: number; tone: MapTone }>()
  for (const p of pods) {
    const key = p.notReady ? t('not ready') : p.status
    const prev = counts.get(key)
    counts.set(key, { n: (prev?.n ?? 0) + 1, tone: p.tone })
  }
  const summary = [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `${String(v.n)} ${k}`)
    .join(' · ')
  const maxDots = POD_DOTS_PER_ROW * POD_DOT_ROWS
  const dots = pods.length > maxDots ? pods.slice(0, maxDots - 1) : pods
  if (ctx.far)
    return (
      <FarCard
        n={n}
        kind="pods"
        icon="pods"
        label={tn(pods.length, '{n} pod', '{n} pods')}
        className={focusClass(ctx, n)}
      />
    )
  return (
    <div
      className={cx(
        'k8s-card relative flex size-full flex-col overflow-hidden rounded-[10px]',
        focusClass(ctx, n)
      )}
      data-tone={n.tone}
      data-testid="k8s-topo-node"
      data-kind="pods"
      data-name={workload}
    >
      <div className="flex h-[50px] shrink-0 items-center gap-2.5 pr-1.5 pl-3">
        <KindIcon kind="pods" size={22} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] leading-4 text-faint">
            {tn(pods.length, '{n} pod', '{n} pods')}
          </div>
          <div
            className="truncate text-[12px] leading-5 font-medium text-fg"
            title={summary || t('No pods')}
          >
            {summary || t('No pods')}
          </div>
        </div>
        {pods.length > 0 && (
          <button
            type="button"
            className="nodrag nopan shrink-0 rounded-md p-1 text-faint hover:bg-hover hover:text-fg"
            aria-label={n.expanded ? t('Collapse pod list') : t('Show every pod')}
            title={n.expanded ? t('Collapse pod list') : t('Show every pod')}
            data-testid="k8s-topo-pods-toggle"
            onClick={(e) => {
              e.stopPropagation()
              ctx.onTogglePods(workload)
            }}
          >
            {n.expanded ? <ChevronDown size={15} /> : <ChevronsUpDown size={15} />}
          </button>
        )}
      </div>
      {n.expanded ? (
        <div className="flex flex-col pb-1">
          {pods.slice(0, MAX_POD_ROWS).map((p) => (
            <button
              key={p.name}
              type="button"
              className={cx(
                'nodrag flex h-6 shrink-0 items-center gap-2 px-3 text-left text-[12px] hover:bg-hover',
                ctx.selectedPod === p.name && 'bg-accent-soft'
              )}
              data-testid="k8s-topo-pod"
              data-name={p.name}
              onClick={(e) => {
                e.stopPropagation()
                ctx.onSelectPod(n.id, p)
              }}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ background: LED[p.tone] }} />
              {/* Cắt ở đầu (…7b5-x2k4p): phần cuối tên pod mới là phần phân biệt. */}
              <span
                className="min-w-0 flex-1 truncate text-left font-mono text-fg [direction:rtl]"
                title={p.name}
              >
                <bdi>{p.name}</bdi>
              </span>
              {p.tone !== 'ok' && (
                <span
                  className={cx(
                    'max-w-[4.5rem] shrink-0 truncate',
                    p.tone === 'bad' ? 'text-danger' : 'text-warning'
                  )}
                >
                  {p.notReady ? t('not ready') : p.status}
                </span>
              )}
              {p.restarts > 0 && (
                <span
                  className={cx(
                    'shrink-0 tabular-nums',
                    p.restarts > 5 ? 'text-danger' : 'text-warning'
                  )}
                  title={t('Restarts')}
                >
                  ↻{p.restarts}
                </span>
              )}
            </button>
          ))}
          {pods.length > MAX_POD_ROWS && (
            <div className="flex h-[22px] items-center px-3 text-[11px] text-faint">
              {tn(pods.length - MAX_POD_ROWS, '+{n} more pod', '+{n} more pods')}
            </div>
          )}
        </div>
      ) : (
        <div
          className="grid gap-1 px-3 pt-0.5"
          style={{ gridTemplateColumns: `repeat(${String(POD_DOTS_PER_ROW)}, 10px)` }}
        >
          {dots.map((p) => (
            <button
              key={p.name}
              type="button"
              aria-label={p.name}
              title={`${p.name} — ${p.notReady ? t('not ready') : p.status}${p.restarts ? ` · ↻${String(p.restarts)}` : ''}`}
              className={cx(
                'k8s-gem nodrag size-[10px]',
                ctx.selectedPod === p.name &&
                  'outline-2 outline-offset-1 outline-[var(--map-accent)]'
              )}
              data-testid="k8s-topo-pod-dot"
              data-tone={p.tone}
              style={{ '--gem': LED[p.tone] } as React.CSSProperties}
              onClick={(e) => {
                e.stopPropagation()
                ctx.onSelectPod(n.id, p)
              }}
            />
          ))}
          {pods.length > maxDots && (
            <span className="col-span-3 text-[11px] leading-[10px] text-faint">
              +{pods.length - dots.length}
            </span>
          )}
        </div>
      )}
      <Handles />
    </div>
  )
})

/** Thẻ tóm tắt namespace đang gập. */
export const NamespaceCard = memo(function NamespaceCard({
  data
}: NodeProps<TopoFlowNode>): React.JSX.Element {
  const ctx = useTopo()
  if (!('node' in data)) return <></>
  const n = data.node
  const st = n.stats
  if (ctx.far)
    return (
      <FarCard
        n={n}
        kind="namespace"
        icon="namespaces"
        label={n.name}
        aside={
          st && st.problems.bad + st.problems.warn > 0
            ? `⚠ ${String(st.problems.bad + st.problems.warn)}`
            : undefined
        }
        className={focusClass(ctx, n)}
      />
    )
  const failing = st?.failingPods ?? 0
  const warnings = st?.problems.warn ?? 0
  const other = st ? Math.max(0, st.problems.bad - failing) : 0
  return (
    <button
      type="button"
      className={cx(
        'k8s-card nodrag nopan group flex size-full items-center gap-3 rounded-[10px] px-3 text-left outline-none focus-visible:shadow-ds-focus',
        focusClass(ctx, n)
      )}
      data-tone={n.tone}
      data-testid="k8s-topo-node"
      data-kind="namespace"
      data-name={n.name}
      title={t('Open namespace {name}', { name: n.name })}
      onClick={(e) => {
        e.stopPropagation()
        ctx.onToggleNs(n.ns)
      }}
    >
      <span className="relative shrink-0">
        <KindIcon kind="namespaces" size={20} />
        <span
          className={cx(
            'absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-[var(--map-card)]',
            n.tone === 'bad' ? 'bg-danger-solid' : n.tone === 'warn' ? 'bg-warning' : 'bg-success'
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-fg group-hover:underline">
          {n.name}
        </span>
        {st && (
          <span className="block truncate text-[11.5px] text-faint tabular-nums">
            {tn(st.workloads, '{n} workload', '{n} workloads')} ·{' '}
            {tn(st.pods, '{n} pod', '{n} pods')}
          </span>
        )}
      </span>
      {(failing > 0 || other > 0 || warnings > 0) && (
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] font-medium tabular-nums">
          {failing > 0 && (
            <span className="rounded-full bg-danger-soft px-1.5 py-px text-danger">
              {tn(failing, '{n} failing pod', '{n} failing pods')}
            </span>
          )}
          {failing === 0 && other > 0 && (
            <span className="rounded-full bg-danger-soft px-1.5 py-px text-danger">
              {tn(other, '{n} problem', '{n} problems')}
            </span>
          )}
          {warnings > 0 && (
            <span className="rounded-full bg-warning-soft px-1.5 py-px text-warning">
              {tn(warnings, '{n} warning', '{n} warnings')}
            </span>
          )}
        </span>
      )}
    </button>
  )
})

/** "+N workloads" của namespace bị cắt bớt. */
export const MoreCard = memo(function MoreCard({
  data
}: NodeProps<TopoFlowNode>): React.JSX.Element {
  const ctx = useTopo()
  if (!('node' in data)) return <></>
  const n = data.node
  return (
    <button
      type="button"
      className="nodrag flex size-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line-strong text-[12px] font-medium text-muted hover:border-accent hover:text-fg"
      data-testid="k8s-topo-more"
      onClick={(e) => {
        e.stopPropagation()
        ctx.onShowAll(n.ns)
      }}
    >
      <span style={ctx.far ? { fontSize: farSize(10, 26) } : undefined}>{n.name}</span>
      {!ctx.far && <span className="text-faint">· {t('Show all')}</span>}
    </button>
  )
})

/** Dải namespace (nền) + tiêu đề, gập / mở. */
export const BandNode = memo(function BandNode({
  data
}: NodeProps<TopoFlowNode>): React.JSX.Element {
  const ctx = useTopo()
  if (!('band' in data)) return <></>
  const { band, label, stats, bad, warn } = data
  if (band.group !== undefined)
    return (
      <div
        className="size-full rounded-[18px]"
        style={{
          background: 'var(--map-region)',
          border: '1px solid color-mix(in srgb, var(--map-island-border) 70%, transparent)'
        }}
        data-testid="k8s-topo-group"
        data-group={band.group}
      >
        <div
          className="flex h-9 origin-bottom-left items-center gap-2 px-4"
          style={
            ctx.far ? { transform: 'scale(min(calc(0.8 / var(--topo-zoom, 1)), 3.1))' } : undefined
          }
        >
          <span className="truncate text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            {label}
          </span>
          <span className="shrink-0 text-[11px] text-faint tabular-nums">{stats}</span>
          {bad > 0 && (
            <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-px text-[11px] font-medium text-danger tabular-nums">
              {tn(bad, '{n} failing pod', '{n} failing pods')}
            </span>
          )}
        </div>
      </div>
    )
  return (
    <div
      className="size-full rounded-[18px]"
      style={{
        background: 'var(--map-region)',
        border: '1px solid color-mix(in srgb, var(--map-island-border) 70%, transparent)'
      }}
      data-testid="k8s-topo-band"
      data-ns={band.ns}
    >
      <div
        className="flex h-10 origin-bottom-left items-center gap-2 px-3"
        // Thu nhỏ xa: phóng to cả tiêu đề (neo góc dưới trái, lấn lên khoảng trống phía trên).
        style={
          ctx.far ? { transform: 'scale(min(calc(0.8 / var(--topo-zoom, 1)), 3.1))' } : undefined
        }
      >
        <button
          type="button"
          className="nodrag nopan flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 pl-1 text-left hover:bg-hover"
          aria-expanded={!band.collapsed}
          data-testid="k8s-topo-ns-toggle"
          data-ns={band.ns}
          title={band.collapsed ? t('Expand namespace') : t('Collapse namespace')}
          onClick={(e) => {
            e.stopPropagation()
            ctx.onToggleNs(band.ns)
          }}
        >
          {band.collapsed ? (
            <ChevronRight size={14} className="text-faint" />
          ) : (
            <ChevronDown size={14} className="text-faint" />
          )}
          <KindIcon kind="namespaces" size={16} />
          <span className="truncate text-[13px] font-semibold text-fg">{label}</span>
        </button>
        {!ctx.far && (
          <span className="min-w-0 truncate text-[12px] text-faint tabular-nums">{stats}</span>
        )}
        {bad > 0 && (
          <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-px text-[11px] font-medium text-danger tabular-nums">
            {tn(bad, '{n} failing', '{n} failing')}
          </span>
        )}
        {warn > 0 && (
          <span className="shrink-0 rounded-full bg-warning-soft px-1.5 py-px text-[11px] font-medium text-warning tabular-nums">
            {tn(warn, '{n} warning', '{n} warnings')}
          </span>
        )}
      </div>
    </div>
  )
})

export const TOPO_NODE_TYPES = {
  card: CardNode,
  workload: WorkloadCard,
  pods: PodsCard,
  namespace: NamespaceCard,
  more: MoreCard,
  band: BandNode
}

/** Đường gấp khúc bo góc: ngang → dọc (ở `bx`) → ngang. */
export function orthoPath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  bx: number,
  radius = 8
): string {
  if (Math.abs(ty - sy) < 0.5) return `M${String(sx)},${String(sy)} H${String(tx)}`
  const dir = ty > sy ? 1 : -1
  const r = Math.max(0, Math.min(radius, Math.abs(ty - sy) / 2, bx - sx, tx - bx))
  return [
    `M${String(sx)},${String(sy)}`,
    `H${String(bx - r)}`,
    `Q${String(bx)},${String(sy)} ${String(bx)},${String(sy + dir * r)}`,
    `V${String(ty - dir * r)}`,
    `Q${String(bx)},${String(ty)} ${String(bx + r)},${String(ty)}`,
    `H${String(tx)}`
  ].join(' ')
}

/**
 * Gateway → Route trong cùng làn: nét cây từ mép dưới (hoặc trên) Gateway, gần mép trái, xuống
 * ngang tâm Route thụt vào rồi rẽ phải — hoặc thẳng xuống mép trên Route khi không thụt (khác dải).
 */
function treePath(
  p: Pick<EdgeProps, 'sourceX' | 'sourceY' | 'targetX' | 'targetY'>,
  g: NonNullable<PlacedTopoEdge['tree']>
): { path: string; head: string } {
  const left = p.sourceX - g.sw
  const vx = left + ROUTE_INDENT / 2
  const down = p.targetY > p.sourceY
  const sy = down ? p.sourceY + g.sh / 2 : p.sourceY - g.sh / 2
  const n = (v: number): string => String(Math.round(v * 10) / 10)
  if (p.targetX - left > 4) {
    // Route thụt vào: xuống / lên tới tâm Route rồi rẽ phải vào mép trái.
    const tx = p.targetX - 1
    const ty = p.targetY
    const r = Math.min(6, Math.abs(ty - sy) / 2, (tx - vx) / 2)
    const dir = down ? 1 : -1
    return {
      path: `M${n(vx)},${n(sy)} V${n(ty - dir * r)} Q${n(vx)},${n(ty)} ${n(vx + r)},${n(ty)} H${n(tx)}`,
      head: `M${n(tx - 6)},${n(ty - 3.5)} L${n(tx)},${n(ty)} L${n(tx - 6)},${n(ty + 3.5)} Z`
    }
  }
  // Cùng mép trái (Route ở dải khác): thẳng tới mép trên / dưới Route.
  const ty = down ? p.targetY - g.th / 2 - 1 : p.targetY + g.th / 2 + 1
  const d = down ? -6 : 6
  return {
    path: `M${n(vx)},${n(sy)} V${n(ty)}`,
    head: `M${n(vx - 3.5)},${n(ty + d)} L${n(vx)},${n(ty)} L${n(vx + 3.5)},${n(ty + d)} Z`
  }
}

const EDGE_COLOR: Record<PlacedTopoEdge['kind'], string> = {
  attach: 'var(--map-accent)',
  route: 'var(--map-accent)',
  expose: 'var(--map-accent)',
  select: 'var(--map-accent)',
  run: 'var(--map-edge-muted)',
  uses: 'var(--map-edge-muted)',
  mounts: 'var(--map-edge-muted)'
}

/** Cạnh: đi sau thẻ (không đè chữ), mũi tên nhỏ ở đích; nổi bật theo đường đang xem. */
export const TopoEdgeComp = memo(function TopoEdgeComp(
  props: EdgeProps<TopoFlowEdge>
): React.JSX.Element | null {
  const unit = useTrafficUnit()
  const ctx = useTopo()
  const d = props.data
  if (!d) return null
  const e = d.edge
  const sx = props.sourceX
  const sy = props.sourceY + e.sOff
  const tx = props.targetX - 1
  const ty = props.targetY + e.tOff
  const forward = tx - sx > 16
  // Làn dọc riêng của cạnh (bố cục đã chia, không chung đoạn dọc với cạnh khác đích); thẻ bị kéo
  // lại gần → kẹp trong khoảng giữa hai thẻ.
  const bx = Math.max(sx + 6, Math.min(sx + e.bend, tx - 10))
  const tree = e.tree ? treePath(props, e.tree) : null
  const path = tree
    ? tree.path
    : forward
      ? orthoPath(sx, sy, tx, ty, bx)
      : `M${String(sx)},${String(sy)} C${String(sx + 60)},${String(sy)} ${String(tx - 60)},${String(ty)} ${String(tx)},${String(ty)}`
  const hot = ctx.lit ? ctx.lit.has(e.from) && ctx.lit.has(e.to) : false
  const faded = ctx.lit !== null && !hot
  const color = e.broken ? 'var(--map-bad)' : EDGE_COLOR[e.kind]
  const rate = d.rate ?? 0
  const live = rate >= idleBelow(unit)
  const width = live ? (BANDS[bandFor(unit)(rate)]?.width ?? 1.5) : hot ? 2.2 : 1.5
  const dash = e.broken ? '5 4' : e.kind === 'uses' || e.kind === 'mounts' ? '4 4' : undefined
  const head =
    tree?.head ??
    `M${String(tx - 7)},${String(ty - 4)} L${String(tx)},${String(ty)} L${String(tx - 7)},${String(ty + 4)} Z`
  const opacity = faded ? (ctx.strong ? 0.08 : 0.25) : hot ? 1 : e.kind === 'run' ? 0.55 : 0.75
  return (
    <g
      data-testid="k8s-topo-edge"
      data-kind={e.kind}
      data-source={e.from}
      data-target={e.to}
      data-broken={e.broken ? 'true' : undefined}
      style={{ opacity, transition: 'opacity 140ms ease' }}
    >
      <path
        d={path}
        fill="none"
        style={{
          stroke: color,
          // Thu nhỏ xa: nét theo px màn hình (không mảnh tới mức biến mất), bỏ mũi tên / nhãn.
          strokeWidth: ctx.far ? (hot ? 2.5 : live ? Math.min(width, 3) : 1.25) : width,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          ...(ctx.far ? { vectorEffect: 'non-scaling-stroke' as const } : {}),
          ...(dash && !ctx.far ? { strokeDasharray: dash } : {})
        }}
      >
        {live && <title>{rateText(unit)(rate)}</title>}
      </path>
      {!ctx.far && e.kind !== 'uses' && e.kind !== 'mounts' && e.kind !== 'run' && (
        <path d={head} style={{ fill: color }} />
      )}
      {live && d.label && !ctx.far && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded-md border px-1.5 py-px font-mono text-[11px] font-semibold text-fg tabular-nums shadow-sm"
            style={{
              transform: `translate(-100%, -50%) translate(${String(tx - 14)}px, ${String(ty - 11)}px)`,
              background: 'var(--map-card)',
              borderColor: 'var(--map-card-border)',
              opacity: faded ? 0.25 : 1
            }}
            data-testid="k8s-topo-edge-rate"
          >
            {rateText(unit)(rate)}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  )
})

export const TOPO_EDGE_TYPES = { topo: TopoEdgeComp }
