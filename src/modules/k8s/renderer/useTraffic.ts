import { useEffect, useRef, useState } from 'react'
import { cleanError } from '../../../renderer/src/lib/format'
import type { K8sOp } from '../shared/ops'
import { trafficRates, type TrafficRate, type TrafficSample } from '../shared/traffic'

type Request = <T>(op: K8sOp) => Promise<T>

/**
 * connecting: đang đọc lần đầu (chưa đủ hai mẫu để tính tốc độ); live: có số liệu; unavailable:
 * không có Caretta / không đọc được (kèm lý do). "Không có traffic" là live với danh sách rỗng —
 * không nhầm với lỗi.
 */
export type TrafficStatus = 'off' | 'connecting' | 'live' | 'unavailable'

export interface TrafficState {
  status: TrafficStatus
  reason?: string
  agents: number
  rates: TrafficRate[]
  /** Vài chục mẫu gần nhất (vẽ sparkline). */
  history: { at: number; rates: TrafficRate[] }[]
  updated: number
}

const HISTORY = 40

export function useTraffic(request: Request, enabled: boolean, intervalMs = 15_000): TrafficState {
  const [state, setState] = useState<TrafficState>({
    status: 'off',
    agents: 0,
    rates: [],
    history: [],
    updated: 0
  })
  const prev = useRef<TrafficSample | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    prev.current = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      request<TrafficSample>({ op: 'traffic' }).then(
        (s) => {
          if (cancelled) return
          if (s.status === 'unavailable') {
            prev.current = null
            setState((st) => ({
              ...st,
              status: 'unavailable',
              ...(s.reason ? { reason: s.reason } : {}),
              agents: s.agents,
              rates: [],
              updated: s.at
            }))
            // Không có Caretta: hỏi lại thưa hơn (có thể vừa cài).
            timer = setTimeout(load, intervalMs * 4)
            return
          }
          const before = prev.current
          prev.current = s
          if (!before) {
            setState((st) => ({ ...st, status: 'connecting', agents: s.agents, updated: s.at }))
            // Mẫu thứ hai sớm để có tốc độ ngay.
            timer = setTimeout(load, Math.min(5_000, intervalMs))
            return
          }
          const rates = trafficRates(before, s)
          setState((st) => ({
            status: 'live',
            agents: s.agents,
            rates,
            history: [...st.history.slice(-(HISTORY - 1)), { at: s.at, rates }],
            updated: s.at
          }))
          timer = setTimeout(load, intervalMs)
        },
        (e: unknown) => {
          if (cancelled) return
          setState((st) => ({ ...st, status: 'unavailable', reason: cleanError(e), rates: [] }))
          timer = setTimeout(load, intervalMs * 2)
        }
      )
    }
    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [request, enabled, intervalMs])
  if (!enabled) return { ...state, status: 'off' }
  return state.status === 'off' ? { ...state, status: 'connecting' } : state
}
