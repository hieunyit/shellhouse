import { useEffect, useState } from 'react'
import { cleanError } from '../../../renderer/src/lib/format'
import type { K8sOp } from '../shared/ops'
import { trafficRates, windowRates, type TrafficRate, type TrafficSample } from '../shared/traffic'

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
  /** Tốc độ trung bình trên cửa sổ gần nhất (~1 phút) — đỡ "0 B/s" chớp tắt khi traffic thưa. */
  rates: TrafficRate[]
  /** Vài chục mẫu gần nhất (vẽ sparkline). */
  history: { at: number; rates: TrafficRate[] }[]
  updated: number
}

const HISTORY = 40
const INTERVAL_MS = 10_000
/** Mẫu thứ hai lấy sớm → có tốc độ sau ~2 s. */
const FIRST_GAP_MS = 2_000
/** Tốc độ tính trên cửa sổ này (khoảng cách giữa mẫu cũ nhất còn trong cửa sổ và mẫu mới nhất). */
const WINDOW_MS = 60_000

const OFF: TrafficState = { status: 'off', agents: 0, rates: [], history: [], updated: 0 }

/**
 * Một luồng đọc Caretta cho mỗi phiên cluster (`request` — useK8sSession tạo hàm mới mỗi lần kết
 * nối, nên đổi context trong tab không trộn mẫu của hai cluster), dùng chung giữa Map, tab Traffic,
 * Topology — mở tab nào cũng có số liệu ngay, không đếm lại từ đầu. Dừng khi không còn ai xem.
 */
interface Hub {
  state: TrafficState
  samples: TrafficSample[]
  listeners: Set<(s: TrafficState) => void>
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
}
const hubs = new WeakMap<Request, Hub>()

function hubFor(request: Request): Hub {
  let hub = hubs.get(request)
  if (!hub) {
    hub = { state: OFF, samples: [], listeners: new Set(), timer: null, running: false }
    hubs.set(request, hub)
  }
  return hub
}

function publish(hub: Hub, next: TrafficState): void {
  hub.state = next
  for (const l of hub.listeners) l(next)
}

function schedule(hub: Hub, request: Request, ms: number): void {
  if (!hub.listeners.size) {
    hub.running = false
    return
  }
  hub.timer = setTimeout(() => {
    tick(hub, request)
  }, ms)
}

function tick(hub: Hub, request: Request): void {
  hub.running = true
  request<TrafficSample>({ op: 'traffic' }).then(
    (s) => {
      if (s.status === 'unavailable') {
        hub.samples = []
        publish(hub, {
          ...hub.state,
          status: 'unavailable',
          ...(s.reason ? { reason: s.reason } : {}),
          agents: s.agents,
          rates: [],
          updated: s.at
        })
        // Không có Caretta: hỏi lại thưa hơn (có thể vừa cài).
        schedule(hub, request, INTERVAL_MS * 4)
        return
      }
      const prevLatest = hub.samples.at(-1)
      hub.samples = [...hub.samples.filter((x) => s.at - x.at <= WINDOW_MS), s]
      const oldest = hub.samples[0]
      if (!prevLatest || !oldest || oldest === s) {
        publish(hub, { ...hub.state, status: 'connecting', agents: s.agents, updated: s.at })
        schedule(hub, request, FIRST_GAP_MS)
        return
      }
      const rates = windowRates(hub.samples)
      const step = trafficRates(prevLatest, s)
      publish(hub, {
        status: 'live',
        agents: s.agents,
        rates,
        history: [...hub.state.history.slice(-(HISTORY - 1)), { at: s.at, rates: step }],
        updated: s.at
      })
      schedule(hub, request, INTERVAL_MS)
    },
    (e: unknown) => {
      publish(hub, { ...hub.state, status: 'unavailable', reason: cleanError(e), rates: [] })
      schedule(hub, request, INTERVAL_MS * 2)
    }
  )
}

export function useTraffic(request: Request, enabled: boolean): TrafficState {
  // `request` mới cho mỗi lần kết nối (đổi context…) → hub mới; trạng thái của hub cũ không hiện.
  const hub = hubFor(request)
  const [seen, setSeen] = useState<{ hub: Hub; state: TrafficState }>(() => ({
    hub,
    state: hub.state
  }))
  useEffect(() => {
    if (!enabled) return
    const h = hubFor(request)
    const listener = (s: TrafficState): void => {
      setSeen({ hub: h, state: s })
    }
    h.listeners.add(listener)
    if (!h.running) tick(h, request)
    return () => {
      h.listeners.delete(listener)
      if (!h.listeners.size && h.timer) {
        clearTimeout(h.timer)
        h.timer = null
        h.running = false
      }
    }
  }, [request, enabled])
  if (!enabled) return OFF
  const state = seen.hub === hub ? seen.state : hub.state
  return state.status === 'off' ? { ...state, status: 'connecting' } : state
}
