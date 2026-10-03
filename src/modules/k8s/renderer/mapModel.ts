/** Kiểu, tuỳ chọn lưu máy, bảng màu và nhãn dùng chung của bản đồ K8s (MapView và các phần tách ra). */
import { type MapGrouping, workloadKindLabel, type MapNode, type MapTone } from '../shared/map'
import type { K8sOp } from '../shared/ops'
import { type TrafficPeer } from '../shared/traffic'
import { t } from '../../registry/renderer-kit'

export type Request = <T>(op: K8sOp) => Promise<T>

export interface MapRef {
  kind: string
  ns?: string
  name: string
}

export const OPTIONS_KEY = 'shellhouse.k8s.map'

export interface Palette {
  edge: string
  edgeMuted: string
  warn: string
  /** Màu traffic theo băng thông (băng 0 → 4: xanh ngọc → đỏ). */
  ramp: string[]
}

/** Màu cạnh lấy từ token của chính khung bản đồ (theo theme / Dark canvas). */
export function readPalette(el: Element | null): Palette {
  const css = getComputedStyle(el ?? document.documentElement)
  const v = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback
  return {
    edge: v('--map-edge', '#0d9488'),
    edgeMuted: v('--map-edge-muted', '#64748b'),
    warn: v('--map-warn', '#d97706'),
    ramp: [
      v('--map-t0', '#0d9488'),
      v('--map-t1', '#0891b2'),
      v('--map-t2', '#d97706'),
      v('--map-t3', '#ea580c'),
      v('--map-t4', '#e11d48')
    ]
  }
}

/** Đường traffic tối đa còn cho hạt photon chạy (nhiều hơn → chỉ vẽ sợi cáp tĩnh). */
export const MAX_ANIMATED_EDGES = 150

export interface Options {
  hideSystem: boolean
  pods: boolean
  edges: boolean
  traffic: boolean
  /** Nền tối riêng cho bản đồ (kể cả khi app dùng theme sáng). */
  darkCanvas: boolean
  grouping: MapGrouping
  /** Topology tĩnh (mặc định), bản đồ workload, theo node (hạ tầng), hay service map từ Caretta. */
  view: 'topology' | 'workloads' | 'nodes' | 'traffic'
  /** Đã chuyển sang Topology làm mặc định (một lần — người dùng cũ cũng thấy Topology trước). */
  topologyDefault?: boolean
}

export function loadOptions(): Options {
  const base: Options = {
    hideSystem: true,
    pods: true,
    edges: true,
    traffic: true,
    darkCanvas: false,
    grouping: 'purpose',
    view: 'topology',
    topologyDefault: true
  }
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Options>
      return {
        ...base,
        ...saved,
        ...(saved.topologyDefault ? {} : { view: 'topology', topologyDefault: true })
      }
    }
  } catch {
    // Bỏ qua.
  }
  return base
}

/** Tên loại mục trên bản đồ (dịch lúc render). */
export function kindTitle(kind: MapNode['kind']): string {
  switch (kind) {
    case 'region':
      return t('Region')
    case 'namespace':
      return 'Namespace'
    case 'workload':
      return 'Workload'
    case 'pod':
      return 'Pod'
    case 'service':
      return 'Service'
    case 'route':
      return 'Route'
    case 'gateway':
      return 'Gateway'
    case 'pvc':
      return 'PersistentVolumeClaim'
    case 'policy':
      return 'NetworkPolicy'
  }
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

/**
 * Thứ tự chồng: vùng dưới cùng, rồi đảo namespace, rồi đường nối (z = EDGE_Z), thẻ trên cùng —
 * đường nối luôn chạy sau thẻ, không đè chữ.
 */
export const Z: Record<MapNode['kind'], number> = {
  region: 0,
  namespace: 1,
  gateway: 3,
  route: 3,
  service: 3,
  pvc: 3,
  policy: 3,
  workload: 3,
  pod: 4
}
/** Lớp của đường nối: trên đảo namespace, dưới mọi thẻ. */
export const EDGE_Z = 2

export function routeTitle(kind: string): string {
  if (kind.startsWith('ingresses')) return 'Ingress'
  if (kind.startsWith('httproutes')) return 'HTTPRoute'
  if (kind.startsWith('grpcroutes')) return 'GRPCRoute'
  return 'Route'
}

export const titleOf = (n: MapNode): string =>
  n.kind === 'route'
    ? routeTitle(n.ref?.kind ?? '')
    : n.kind === 'workload' && n.ref
      ? workloadKindLabel(n.ref.kind)
      : kindTitle(n.kind)

export const peerLabel = (p: TrafficPeer): string =>
  p.kind === 'external' || !p.ns
    ? `${p.name} (${p.kind && p.kind !== 'external' ? p.kind : t('external')})`
    : `${p.ns}/${p.name}`

/** Màu chấm trạng thái (Tailwind). */
export const DOT: Record<MapTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger-solid',
  muted: 'bg-line-strong'
}
