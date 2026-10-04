import { useEffect, useMemo, useRef, useState } from 'react'
import { cx } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { formatDateTime, formatPercent, formatTime, t } from '../../registry/renderer-kit'
import type { K8sOp, MetricsRange, MetricsResult } from '../shared/ops'
import { formatCpu, formatMemory } from '../shared/resources'

/**
 * CPU / RAM của một nhóm pod theo thời gian. Có Prometheus trong cluster → lịch sử thật (chọn
 * 15m / 1h / 6h / 24h); không có → lấy mẫu metrics-server mỗi 10 s, giữ suốt phiên (đổi tab không
 * mất). Trục dọc theo dữ liệu thật — không ép theo limit (đường phẳng sát đáy).
 */

type Request = <T>(op: K8sOp) => Promise<T>
export type Point = [number, number]

const RANGES = [
  { m: 15, label: '15m' },
  { m: 60, label: '1h' },
  { m: 360, label: '6h' },
  { m: 1440, label: '24h' }
] as const
const LIVE_MS = 10_000
const LIVE_KEEP_MS = 60 * 60_000

type LiveSamples = { t: number; pods: Record<string, [number, number]> }[]
/** Số nhóm pod giữ mẫu mỗi phiên (nhóm đổi khi rollout → khoá mới; bỏ nhóm lâu không xem). */
const LIVE_GROUPS = 32
/**
 * Mẫu trực tiếp theo phiên cluster (`request`) rồi theo nhóm pod — không mất khi đóng / mở chi tiết,
 * không lẫn giữa hai cluster; Map giữ thứ tự dùng gần nhất (LRU).
 */
const liveStores = new WeakMap<Request, Map<string, LiveSamples>>()
function liveSamples(request: Request, key: string): LiveSamples {
  let store = liveStores.get(request)
  if (!store) {
    store = new Map()
    liveStores.set(request, store)
  }
  const list = store.get(key) ?? []
  // Đưa lên cuối (mới dùng); vượt giới hạn → bỏ nhóm cũ nhất.
  store.delete(key)
  store.set(key, list)
  while (store.size > LIVE_GROUPS) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
  return list
}
function saveLiveSamples(request: Request, key: string, list: LiveSamples): void {
  liveStores.get(request)?.set(key, list)
}

function fmtTime(ms: number, span: number): string {
  return span > 20 * 3600_000 ? formatDateTime(ms) : formatTime(ms, false)
}

/** Biểu đồ theo thời gian: vùng + đường, trục giá trị lớn nhất / 0, mốc giờ, rê chuột xem điểm. */
export function TimeChart({
  points,
  format,
  refs = [],
  testId
}: {
  points: Point[]
  format: (v: number) => string
  /** Đường tham chiếu (request / limit) — chỉ vẽ khi nằm trong tầm nhìn của dữ liệu. */
  refs?: { label: string; value: number }[]
  testId?: string
}): React.JSX.Element {
  const box = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const W = 320
  const H = 96
  const PAD_T = 8
  const PAD_B = 4
  if (points.length < 2)
    return (
      <div className="flex h-[96px] items-center justify-center text-[11px] text-faint">
        {t('Collecting samples…')}
      </div>
    )
  const t0 = points[0]?.[0] ?? 0
  const t1 = points.at(-1)?.[0] ?? 1
  const dataMax = Math.max(...points.map((p) => p[1]), 0)
  const shown = refs.filter((r) => r.value > 0 && r.value <= Math.max(dataMax, 1e-9) * 3)
  const top = Math.max(dataMax, ...shown.map((r) => r.value), 1e-9) * 1.15
  const x = (t: number): number => ((t - t0) / Math.max(t1 - t0, 1)) * W
  const y = (v: number): number => PAD_T + (1 - v / top) * (H - PAD_T - PAD_B)
  const line = points.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const hit = hover === null ? null : points[hover]
  const hidden = refs.filter((r) => r.value > 0 && !shown.includes(r))
  return (
    <div className="relative" data-testid={testId}>
      <div className="flex justify-between text-[11px] text-faint tabular-nums">
        <span>{format(top / 1.15)}</span>
        {hidden.length > 0 && (
          <span title={t("Above the chart's range")}>
            {hidden.map((r) => `${r.label} ${format(r.value)}`).join(' · ')}
          </span>
        )}
      </div>
      <svg
        ref={box}
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        preserveAspectRatio="none"
        className="block h-24 w-full text-accent"
        role="img"
        aria-label={t('Usage over time')}
        onPointerMove={(e) => {
          const r = box.current?.getBoundingClientRect()
          if (!r) return
          const at = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0)
          let best = 0
          points.forEach((p, i) => {
            if (Math.abs(p[0] - at) < Math.abs((points[best]?.[0] ?? 0) - at)) best = i
          })
          setHover(best)
        }}
        onPointerLeave={() => {
          setHover(null)
        }}
      >
        {[0.5].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={y(top * f)}
            y2={y(top * f)}
            stroke="var(--color-line)"
            strokeDasharray="2 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {shown.map((r) => (
          <g key={r.label}>
            <line
              x1="0"
              x2={W}
              y1={y(r.value)}
              y2={y(r.value)}
              stroke="var(--color-warning)"
              strokeDasharray="5 4"
              strokeOpacity="0.8"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
        <polygon
          points={`0,${String(H)} ${line} ${String(W)},${String(H)}`}
          fill="currentColor"
          opacity="0.12"
        />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          vectorEffect="non-scaling-stroke"
        />
        {hit && (
          <line
            x1={x(hit[0])}
            x2={x(hit[0])}
            y1="0"
            y2={H}
            stroke="var(--color-faint)"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {shown.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-4 h-24">
          {shown.map((r) => (
            <span
              key={r.label}
              className="absolute right-0 -translate-y-full text-[11px] text-warning"
              style={{ top: `${String((y(r.value) / H) * 100)}%` }}
            >
              {r.label}
            </span>
          ))}
        </div>
      )}
      <div className="mt-0.5 flex justify-between text-[11px] text-faint tabular-nums">
        <span>{fmtTime(t0, t1 - t0)}</span>
        {hit ? (
          <span className="text-fg" data-testid={testId ? `${testId}-hover` : undefined}>
            {fmtTime(hit[0], 0)} · {format(hit[1])}
          </span>
        ) : (
          <span>{t('now')}</span>
        )}
      </div>
    </div>
  )
}

/** Cộng các đường theo pod thành một đường (theo mốc thời gian). */
function sumSeries(series: { points: Point[] }[]): Point[] {
  const acc = new Map<number, number>()
  for (const s of series) for (const [t, v] of s.points) acc.set(t, (acc.get(t) ?? 0) + v)
  return [...acc.entries()].sort((a, b) => a[0] - b[0])
}

interface Data {
  source: 'prometheus' | 'live'
  via?: string
  since?: number
  cpu: Record<string, Point[]>
  memory: Record<string, Point[]>
}

function useUsage(
  request: Request,
  namespace: string,
  pods: readonly string[],
  minutes: number
): { data: Data | null; error: string | null; unavailable: boolean } {
  const key = `${namespace}|${pods.join(',')}`
  const [state, setState] = useState<{
    key: string
    data: Data | null
    error: string | null
    unavailable: boolean
  }>({ key: '', data: null, error: null, unavailable: false })
  // Kết quả của nhóm pod / khoảng thời gian trước không hiện cho nhóm mới.
  const stateKey = `${key}|${minutes}`
  const setData = (data: Data): void => {
    setState((s) => ({ ...s, key: stateKey, data, error: null }))
  }
  const setError = (error: string | null): void => {
    setState((s) =>
      s.key === stateKey
        ? { ...s, error }
        : { key: stateKey, data: null, error, unavailable: false }
    )
  }
  const setUnavailable = (): void => {
    setState((s) => ({
      ...(s.key === stateKey ? s : { data: null, error: null }),
      key: stateKey,
      unavailable: true
    }))
  }
  useEffect(() => {
    if (!pods.length) return
    let cancelled = false
    let mode: 'unknown' | 'prometheus' | 'live' = 'unknown'
    let lastProm = 0
    const live = (): void => {
      request<MetricsResult>({ op: 'metrics', scope: 'pods', namespace }).then(
        (m) => {
          if (cancelled) return
          if (!m.available) {
            setUnavailable()
            return
          }
          const now = Date.now()
          const list = liveSamples(request, key).filter((x) => now - x.t < LIVE_KEEP_MS)
          const sample: Record<string, [number, number]> = {}
          for (const p of pods) {
            const u = m.items[`${namespace}/${p}`]
            if (u) sample[p] = [u.cpu, u.memory]
          }
          list.push({ t: now, pods: sample })
          saveLiveSamples(request, key, list)
          const cpu: Record<string, Point[]> = {}
          const memory: Record<string, Point[]> = {}
          for (const s of list)
            for (const [p, [c, mem]] of Object.entries(s.pods)) {
              ;(cpu[p] ??= []).push([s.t, c])
              ;(memory[p] ??= []).push([s.t, mem])
            }
          setData({ source: 'live', since: list[0]?.t ?? now, cpu, memory })
        },
        (e: unknown) => {
          if (!cancelled) setError(cleanError(e))
        }
      )
    }
    const load = (): void => {
      if (mode === 'live') {
        live()
        return
      }
      // Prometheus: làm mới mỗi 30 s là đủ (bước dữ liệu ≥ 15 s).
      if (mode === 'prometheus' && Date.now() - lastProm < 29_000) return
      lastProm = Date.now()
      request<MetricsRange>({ op: 'metrics.range', namespace, pods: [...pods], minutes }).then(
        (r) => {
          if (cancelled) return
          if (r.source === 'none') {
            mode = 'live'
            live()
            return
          }
          mode = 'prometheus'
          const pick = (list: { pod: string; points: Point[] }[]): Record<string, Point[]> =>
            Object.fromEntries(list.map((s) => [s.pod, s.points]))
          setData({ source: 'prometheus', via: r.via, cpu: pick(r.cpu), memory: pick(r.memory) })
        },
        () => {
          if (cancelled) return
          // Prometheus lỗi giữa chừng → vẫn có số liệu trực tiếp.
          mode = 'live'
          live()
        }
      )
    }
    load()
    const timer = setInterval(load, LIVE_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [request, namespace, key, minutes]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = state.key === stateKey ? state : null
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    unavailable: current?.unavailable ?? false
  }
}

/** Bảng CPU / RAM cho một nhóm pod (workload) hoặc một pod. */
export function UsagePanel({
  request,
  namespace,
  pods,
  requests,
  limits,
  perPod
}: {
  request: Request
  namespace: string
  pods: readonly string[]
  /** Tổng requests / limits của nhóm (millicore, byte); 0 = không đặt. */
  requests: { cpu: number; memory: number }
  limits: { cpu: number; memory: number }
  /** Hiện bảng theo từng pod. */
  perPod: boolean
}): React.JSX.Element {
  const [minutes, setMinutes] = useState(60)
  const { data, error, unavailable } = useUsage(request, namespace, pods, minutes)
  const totals = useMemo(() => {
    if (!data) return null
    return {
      cpu: sumSeries(Object.values(data.cpu).map((points) => ({ points }))),
      memory: sumSeries(Object.values(data.memory).map((points) => ({ points })))
    }
  }, [data])

  if (unavailable)
    return (
      <p className="text-xs text-faint" data-testid="k8s-metrics-unavailable">
        {t(
          'This cluster has no metrics-server or Prometheus — CPU and memory usage are not available.'
        )}
      </p>
    )
  if (error) return <p className="text-xs text-danger">{error}</p>
  if (!data || !totals) return <p className="text-xs text-faint">{t('Loading usage…')}</p>

  const now = (p: Point[]): number => p.at(-1)?.[1] ?? 0
  const card = (
    label: string,
    points: Point[],
    format: (v: number) => string,
    req: number,
    lim: number,
    testId: string
  ): React.JSX.Element => {
    const cur = now(points)
    return (
      <div className="min-w-0 rounded-lg border border-line p-3">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted">{label}</span>
          <span className="text-base font-semibold text-fg tabular-nums">{format(cur)}</span>
        </div>
        <TimeChart
          points={points}
          format={format}
          refs={[
            { label: t('request'), value: req },
            { label: t('limit'), value: lim }
          ]}
          testId={testId}
        />
        <div className="mt-1.5 text-[11px] text-faint">
          {req > 0 ? (
            <span className={cx(cur > req && 'text-warning')}>
              {t('{percent} of request {value}', {
                percent: formatPercent(cur / req),
                value: format(req)
              })}
            </span>
          ) : (
            <span className="text-warning">{t('No request set')}</span>
          )}
          {lim > 0 && <span> · {t('limit {value}', { value: format(lim) })}</span>}
        </div>
      </div>
    )
  }
  const podRows = perPod
    ? [...pods]
        .map((p) => ({ p, cpu: now(data.cpu[p] ?? []), mem: now(data.memory[p] ?? []) }))
        .sort((a, b) => b.cpu - a.cpu)
    : []
  const maxCpu = Math.max(...podRows.map((r) => r.cpu), 1e-9)
  const maxMem = Math.max(...podRows.map((r) => r.mem), 1e-9)

  return (
    <div className="flex flex-col gap-3" data-testid="k8s-metrics" data-source={data.source}>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
        <span data-testid="k8s-metrics-source">
          {data.source === 'prometheus'
            ? `Prometheus · ${data.via ?? ''}`
            : t('Live samples every 10 s since {time} — no Prometheus in this cluster', {
                time: formatTime(data.since ?? 0, false)
              })}
        </span>
        {data.source === 'prometheus' && (
          <div className="ml-auto flex rounded-md border border-line p-0.5" role="group">
            {RANGES.map((r) => (
              <button
                key={r.m}
                type="button"
                aria-pressed={minutes === r.m}
                data-testid={`k8s-metrics-range-${r.label}`}
                className={cx(
                  'rounded px-2 py-0.5 text-[11px] font-medium',
                  minutes === r.m ? 'bg-hover text-fg' : 'text-muted hover:text-fg'
                )}
                onClick={() => {
                  setMinutes(r.m)
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-2">
        {card('CPU', totals.cpu, formatCpu, requests.cpu, limits.cpu, 'k8s-metrics-cpu')}
        {card(
          t('Memory'),
          totals.memory,
          formatMemory,
          requests.memory,
          limits.memory,
          'k8s-metrics-memory'
        )}
      </div>
      {podRows.length > 1 && (
        <section>
          <div className="mb-1 grid grid-cols-[minmax(0,1fr)_8rem_8rem] gap-3 text-xs font-medium text-faint">
            <span>{t('By pod')}</span>
            <span>CPU</span>
            <span>{t('Memory')}</span>
          </div>
          <div className="flex flex-col text-xs">
            {podRows.map((r) => (
              <div
                key={r.p}
                className="grid grid-cols-[minmax(0,1fr)_8rem_8rem] items-center gap-3 py-1"
              >
                <span className="truncate font-mono text-fg" title={r.p}>
                  {r.p}
                </span>
                <Bar value={r.cpu} max={maxCpu} text={formatCpu(r.cpu)} />
                <Bar value={r.mem} max={maxMem} text={formatMemory(r.mem)} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function Bar({
  value,
  max,
  text
}: {
  value: number
  max: number
  text: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-subtle">
        <div
          className="h-full rounded-full bg-chart"
          style={{ width: `${String(Math.min(100, (value / max) * 100))}%` }}
        />
      </div>
      <span className="w-14 text-right text-faint tabular-nums">{text}</span>
    </div>
  )
}
