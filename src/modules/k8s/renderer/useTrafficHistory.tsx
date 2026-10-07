import { useEffect, useState } from 'react'
import { cx } from '../../../renderer/src/components/ui'
import { cleanError } from '../../../renderer/src/lib/format'
import { t } from '../../registry/renderer-kit'
import {
  HISTORY_RANGES,
  type HistoryProbe,
  type TrafficRange,
  type TrafficSeries
} from '../shared/history'
import type { K8sOp } from '../shared/ops'
import type { TrafficState } from './useTraffic'

type Request = <T>(op: K8sOp) => Promise<T>

/** 'live' = đọc trực tiếp từ Caretta / Hubble; còn lại = trung bình trong khoảng (Prometheus). */
export type TrafficWindow = 'live' | (typeof HISTORY_RANGES)[number]['label']

const minutesOf = (w: TrafficWindow): number =>
  HISTORY_RANGES.find((r) => r.label === w)?.minutes ?? 0

/** Đọc lại lịch sử chừng này một lần (khoảng "x giờ gần nhất" trôi theo thời gian). */
const REFRESH_MS = 60_000

/** Prometheus có lịch sử traffic / event không — dò một lần cho mỗi phiên (`request`). */
const probes = new WeakMap<Request, Promise<HistoryProbe>>()

export function useHistoryProbe(request: Request): HistoryProbe | null {
  const [state, setState] = useState<{ request: Request; probe: HistoryProbe } | null>(null)
  useEffect(() => {
    let cancelled = false
    let p = probes.get(request)
    if (!p) {
      p = request<HistoryProbe>({ op: 'history.probe' })
      probes.set(request, p)
      p.catch(() => probes.delete(request))
    }
    p.then(
      (probe) => {
        if (!cancelled) setState({ request, probe })
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [request])
  return state?.request === request ? state.probe : null
}

/** Lý do không xem được lịch sử traffic (null = xem được). */
export function historyUnavailable(probe: HistoryProbe | null): string | null {
  if (!probe) return t('Checking for Prometheus…')
  if (!probe.prometheus) return t('History needs a Prometheus in the cluster.')
  if (!probe.traffic)
    return probe.hubbleNoWorkloads
      ? t(
          'Prometheus has Hubble metrics without workload labels — enable the "tcp" metric with labelsContext=source_namespace,source_workload,destination_namespace,destination_workload.'
        )
      : t('Prometheus does not collect Caretta or Hubble traffic metrics.')
  return null
}

/**
 * Traffic trung bình trong khoảng đã chọn (dạng giống traffic trực tiếp để dùng chung bản đồ / bảng).
 * null khi đang xem trực tiếp.
 */
export function useTrafficRange(
  request: Request,
  window: TrafficWindow,
  enabled = true
): (TrafficState & { via?: string; start?: number; end?: number }) | null {
  const [state, setState] = useState<{
    key: string
    value: TrafficState & { via?: string; start?: number; end?: number }
  } | null>(null)
  const key = window
  useEffect(() => {
    if (window === 'live' || !enabled) return
    let cancelled = false
    const load = (): void => {
      const end = Date.now()
      const start = end - minutesOf(window) * 60_000
      request<TrafficRange>({ op: 'traffic.range', start, end }).then(
        (r) => {
          if (cancelled) return
          setState({
            key,
            value:
              r.source === 'none'
                ? {
                    status: 'unavailable',
                    reason: r.reason,
                    agents: 0,
                    rates: [],
                    history: [],
                    updated: end
                  }
                : {
                    status: 'live',
                    agents: 0,
                    rates: r.rates,
                    history: [],
                    updated: end,
                    unit: r.unit,
                    historic: true,
                    via: r.via,
                    start: r.start,
                    end: r.end
                  }
          })
        },
        (e: unknown) => {
          if (cancelled) return
          setState({
            key,
            value: {
              status: 'unavailable',
              reason: cleanError(e),
              agents: 0,
              rates: [],
              history: [],
              updated: end
            }
          })
        }
      )
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [request, window, key, enabled])
  if (window === 'live') return null
  return state?.key === key
    ? state.value
    : { status: 'connecting', agents: 0, rates: [], history: [], updated: 0 }
}

/** Vào / ra của một workload theo thời gian (Prometheus); null khi đang xem trực tiếp. */
export function useTrafficSeries(
  request: Request,
  window: TrafficWindow,
  workload: { kind: string; namespace: string; name: string }
): TrafficSeries | null {
  const [state, setState] = useState<{ key: string; value: TrafficSeries } | null>(null)
  const supported = ['deployments.apps', 'statefulsets.apps', 'daemonsets.apps'].includes(
    workload.kind
  )
  const key = `${window}|${workload.kind}|${workload.namespace}|${workload.name}`
  useEffect(() => {
    if (window === 'live' || !supported) return
    let cancelled = false
    const load = (): void => {
      const end = Date.now()
      request<TrafficSeries>({
        op: 'traffic.series',
        kind: workload.kind as 'deployments.apps',
        namespace: workload.namespace,
        name: workload.name,
        start: end - minutesOf(window) * 60_000,
        end
      }).then(
        (value) => {
          if (!cancelled) setState({ key, value })
        },
        (e: unknown) => {
          if (!cancelled) setState({ key, value: { source: 'none', reason: cleanError(e) } })
        }
      )
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` đại diện cho workload
  }, [request, key, supported])
  if (window === 'live' || !supported) return null
  return state?.key === key ? state.value : null
}

/** Chọn xem trực tiếp hay lịch sử (khoảng nào); lịch sử không có → nút mờ, chú thích lý do. */
export function TrafficWindowPicker({
  value,
  onChange,
  probe,
  testId = 'k8s-traffic-window'
}: {
  value: TrafficWindow
  onChange: (w: TrafficWindow) => void
  probe: HistoryProbe | null
  testId?: string
}): React.JSX.Element {
  const why = historyUnavailable(probe)
  const options: { value: TrafficWindow; label: string }[] = [
    { value: 'live', label: t('Live') },
    ...HISTORY_RANGES.map((r) => ({ value: r.label, label: r.label }))
  ]
  return (
    <div
      role="radiogroup"
      aria-label={t('Time range')}
      className="inline-flex shrink-0 items-center gap-0.5 self-start rounded-ds-md border border-ds-border-strong bg-subtle p-0.5"
      data-testid={testId}
    >
      {options.map((o) => {
        const disabled = o.value !== 'live' && why !== null
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={disabled}
            title={
              disabled
                ? why
                : o.value === 'live'
                  ? t('Live — read directly every 10 seconds')
                  : t('Average over the last {range}, from Prometheus', { range: o.label })
            }
            data-testid={`${testId}-${o.value}`}
            className={cx(
              'flex h-6 items-center gap-1 rounded-ds-sm px-2 text-xs font-medium transition-colors',
              value === o.value ? 'bg-ds-surface-3 text-fg' : 'text-muted hover:text-fg',
              disabled && 'cursor-not-allowed opacity-40 hover:text-muted'
            )}
            onClick={() => {
              onChange(o.value)
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
