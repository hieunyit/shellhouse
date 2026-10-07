import type { TrafficRate, TrafficUnit } from './traffic'

/**
 * Lịch sử qua Prometheus trong cluster: traffic (Caretta / Hubble), số event theo lý do (event
 * exporter) — app không tự lưu, dùng đúng nơi cluster đã giữ số liệu 24/7.
 */

/** Prometheus có những gì (dò một lần, nhớ vài phút). */
export interface HistoryProbe {
  /** "namespace/service" của Prometheus; null = không tìm thấy / không có quyền services/proxy. */
  prometheus: string | null
  /**
   * Nguồn traffic Prometheus đang thu: Caretta (`caretta_links_observed`, byte) hoặc Hubble
   * (`hubble_tcp_flags_total` có nhãn workload — kết nối mới).
   */
  traffic: 'caretta' | 'hubble' | null
  /** Hubble có metric nhưng thiếu nhãn workload (labelsContext) — giải thích cho người dùng. */
  hubbleNoWorkloads?: boolean
  /** Metric đếm event (kube-events-exporter / event_exporter); byName = có nhãn tên đối tượng. */
  events: { metric: string; byName: boolean } | null
}

/** Tốc độ trung bình từng cặp trong một khoảng thời gian. */
export type TrafficRange =
  | {
      source: 'prometheus'
      via: string
      unit: TrafficUnit
      start: number
      end: number
      rates: TrafficRate[]
    }
  | { source: 'none'; reason: string }

/** Vào / ra của một workload theo thời gian: [ms, giá trị / giây]. */
export type TrafficSeries =
  | {
      source: 'prometheus'
      via: string
      unit: TrafficUnit
      step: number
      inbound: [number, number][]
      outbound: [number, number][]
    }
  | { source: 'none'; reason: string }

/** Số event theo lý do trong một bước thời gian (Prometheus không giữ nội dung event). */
export interface EventCount {
  /** Cuối bước (ms). */
  at: number
  reason: string
  type: string
  kind: string
  /** Có khi exporter giữ nhãn tên đối tượng. */
  name?: string
  count: number
}

/** Khoảng xem lịch sử có sẵn (phút). */
export const HISTORY_RANGES = [
  { minutes: 60, label: '1h' },
  { minutes: 360, label: '6h' },
  { minutes: 1440, label: '24h' },
  { minutes: 10_080, label: '7d' }
] as const
