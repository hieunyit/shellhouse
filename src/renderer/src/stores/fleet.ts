import { create } from 'zustand'
import { PRODUCTION_ID } from '@shared/environments'

/**
 * Home › Infrastructure: trạng thái các nguồn module theo dõi nền (cluster Kubernetes, Docker
 * endpoint) — module tự kết nối khi mở app và đẩy bản tóm tắt vào đây; Home chỉ hiển thị.
 */

export type FleetState = 'connecting' | 'ok' | 'warning' | 'error' | 'signin'
export type FleetTone = 'ok' | 'warning' | 'danger' | 'muted'

/** Một số liệu ngắn trên hàng ("Nodes 3/3", "Pods 2 failing"). */
export interface FleetStat {
  label: string
  value: string
  tone?: FleetTone
  title?: string
}

/** Ghi chú cần để ý (hết hỗ trợ, chứng chỉ sắp hết hạn…). */
export interface FleetNote {
  severity: 'danger' | 'warning' | 'info'
  text: string
}

export interface FleetItem {
  /** `<module>:<id nguồn>` — trùng khoá của sourceMonitor / sourceEnvironments. */
  id: string
  module: string
  /** Kubernetes / Docker. */
  kind: string
  title: string
  /** Địa chỉ server / host. */
  subtitle?: string
  /** Id môi trường (nhãn). */
  environment?: string
  state: FleetState
  /** Lỗi / lý do cần đăng nhập. */
  message?: string
  version?: string
  stats: FleetStat[]
  notes: FleetNote[]
  /** Lần đọc thành công gần nhất (ms). */
  checkedAt?: number
  open?: () => void
  refresh?: () => void
}

interface FleetStore {
  items: Record<string, FleetItem>
  put: (item: FleetItem) => void
  remove: (id: string) => void
}

export const useFleet = create<FleetStore>((set) => ({
  items: {},
  put: (item) => {
    set((s) => ({ items: { ...s.items, [item.id]: item } }))
  },
  remove: (id) => {
    set((s) =>
      id in s.items
        ? { items: Object.fromEntries(Object.entries(s.items).filter(([k]) => k !== id)) }
        : s
    )
  }
}))

const STATE_RANK: Record<FleetState, number> = {
  error: 0,
  signin: 1,
  warning: 2,
  connecting: 3,
  ok: 4
}

/** Hàng để hiện: có vấn đề trước, rồi theo loại, theo tên. */
export function fleetItems(items: Record<string, FleetItem>): FleetItem[] {
  return Object.values(items).sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      a.kind.localeCompare(b.kind) ||
      a.title.localeCompare(b.title)
  )
}

/**
 * Có theo dõi nguồn này không: người dùng đã chọn thì theo lựa chọn; chưa chọn → nguồn thuộc
 * môi trường Production.
 */
export function isMonitored(
  overrides: Readonly<Record<string, boolean>>,
  key: string,
  environment: string | null | undefined
): boolean {
  return overrides[key] ?? environment === PRODUCTION_ID
}
