/** Kiểu, tuỳ chọn lưu máy và nhãn dùng chung của bản đồ K8s (MapView, Topology, Nodes, Traffic). */
import type { MapGrouping } from '../shared/map'
import type { K8sOp } from '../shared/ops'
import { t } from '../../registry/renderer-kit'

export type Request = <T>(op: K8sOp) => Promise<T>

export interface MapRef {
  kind: string
  ns?: string
  name: string
}

export const OPTIONS_KEY = 'shellhouse.k8s.map'

export interface Options {
  traffic: boolean
  /** Nền tối riêng cho bản đồ (kể cả khi app dùng theme sáng). */
  darkCanvas: boolean
  /** Cách gom namespace của lưới tổng quan (Topology). */
  grouping: MapGrouping
  /** Topology (mặc định), theo node (hạ tầng), hay service map từ traffic (Caretta / Hubble). */
  view: 'topology' | 'nodes' | 'traffic' | 'outbound'
  /** Topology: làn Outbound (điểm đến khai báo trong cấu hình). */
  egress: boolean
  /** Đọc Secret mà workload tham chiếu để tìm điểm đến (chỉ rút host / cổng). */
  egressSecrets: boolean
  /** Đã chuyển sang Topology làm mặc định (một lần — người dùng cũ cũng thấy Topology trước). */
  topologyDefault?: boolean
}

export function loadOptions(): Options {
  const base: Options = {
    traffic: true,
    darkCanvas: false,
    grouping: 'purpose',
    view: 'topology',
    egress: true,
    egressSecrets: true,
    topologyDefault: true
  }
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Omit<Options, 'view'>> & { view?: string }
      // Chế độ Workloads cũ đã gộp vào Topology (namespace gập = lưới tổng quan).
      const view: Options['view'] =
        saved.view === 'nodes' || saved.view === 'traffic' || saved.view === 'outbound'
          ? saved.view
          : 'topology'
      return {
        traffic: saved.traffic ?? base.traffic,
        darkCanvas: saved.darkCanvas ?? base.darkCanvas,
        grouping: saved.grouping ?? base.grouping,
        egress: saved.egress ?? base.egress,
        egressSecrets: saved.egressSecrets ?? base.egressSecrets,
        view: saved.topologyDefault ? view : 'topology',
        topologyDefault: true
      }
    }
  } catch {
    // Bỏ qua.
  }
  return base
}

/** Tên vùng để hiện: vùng theo mục đích và "Other" / "System" được dịch; tên nhãn giữ nguyên. */
export function regionTitle(label: string): string {
  switch (label) {
    case 'Applications':
      return t('Applications')
    case 'Ingress & networking':
      return t('Ingress & networking')
    case 'Platform':
      return t('Platform')
    case 'Monitoring':
      return t('Monitoring')
    case 'System':
      return t('System')
    case 'Other':
      return t('Other')
    default:
      return label
  }
}
