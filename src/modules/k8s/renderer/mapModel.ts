/** Kiểu, tuỳ chọn lưu máy, bảng màu và nhãn dùng chung của bản đồ K8s (MapView và các phần tách ra). */
import { type MapGrouping, workloadKindLabel, type MapNode, type MapTone } from '../shared/map'
import type { K8sOp } from '../shared/ops'
import { type TrafficPeer } from '../shared/traffic'

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
  /** Bản đồ workload, theo node (hạ tầng), hay service map từ Caretta. */
  view: 'workloads' | 'nodes' | 'traffic'
}

export function loadOptions(): Options {
  const base: Options = {
    hideSystem: true,
    pods: true,
    edges: true,
    traffic: true,
    darkCanvas: false,
    grouping: 'purpose',
    view: 'workloads'
  }
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY)
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<Options>) }
  } catch {
    // Bỏ qua.
  }
  return base
}

export const KIND_TITLE: Record<MapNode['kind'], string> = {
  region: 'Region',
  namespace: 'Namespace',
  workload: 'Workload',
  pod: 'Pod',
  service: 'Service',
  route: 'Route',
  gateway: 'Gateway',
  pvc: 'Persistent volume claim',
  policy: 'NetworkPolicy'
}

/** Thứ tự chồng: vùng dưới cùng, thẻ trên cùng. */
export const Z: Record<MapNode['kind'], number> = {
  region: 0,
  namespace: 1,
  gateway: 2,
  route: 2,
  service: 2,
  pvc: 2,
  policy: 2,
  workload: 3,
  pod: 4
}

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
      : KIND_TITLE[n.kind]

export const peerLabel = (p: TrafficPeer): string =>
  p.kind === 'external' || !p.ns ? `${p.name} (${p.kind || 'external'})` : `${p.ns}/${p.name}`

/** Màu chấm trạng thái (Tailwind). */
export const DOT: Record<MapTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger-solid',
  muted: 'bg-line-strong'
}
