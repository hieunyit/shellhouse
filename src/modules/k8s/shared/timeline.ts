import { z } from 'zod'

/**
 * Dòng thời gian của một workload (tab Timeline): lần rollout, pod tạo / container chết, ConfigMap /
 * Secret đổi, node đổi trạng thái, event (sống ~1 giờ trên cluster + bản đã ghi trên máy 7 ngày cho
 * cluster đang theo dõi). Session Host trả dữ liệu có cấu trúc; renderer dịch và vẽ.
 */

export type TimelineLane = 'rollout' | 'pods' | 'config' | 'nodes' | 'events'
export const TIMELINE_LANES: readonly TimelineLane[] = [
  'rollout',
  'pods',
  'config',
  'nodes',
  'events'
]

export type TimelineSeverity = 'danger' | 'warning' | 'info'

export type TimelineType =
  /** Bản pod template mới (ReplicaSet / ControllerRevision). */
  | 'rollout'
  | 'pod-created'
  /** Lần chạy trước của container đã kết thúc (lastState.terminated). */
  | 'container-terminated'
  /** ConfigMap / Secret được sửa lần cuối (managedFields). */
  | 'config-changed'
  | 'node-ready'
  | 'node-not-ready'
  | 'event'

export interface TimelineEntry {
  /** Mốc thời gian (ms). */
  at: number
  lane: TimelineLane
  type: TimelineType
  severity: TimelineSeverity
  object: { kind: string; name: string; namespace?: string }
  /** Event: lý do (BackOff, Killing, ScalingReplicaSet…); container: OOMKilled / Error. */
  reason?: string
  message?: string
  /** Số lần event lặp lại. */
  count?: number
  /** Rollout: số revision; image mới / cũ (theo container). */
  revision?: string
  images?: string[]
  previousImages?: string[]
  /** Container: tên + mã thoát. */
  container?: string
  exitCode?: number
  /** Lấy từ bản ghi trên máy (event cũ hơn thời hạn giữ của cluster). */
  recorded?: boolean
  /** uid của event (gộp bản sống với bản đã ghi). */
  uid?: string
  /**
   * Lấy từ Prometheus (event exporter): số lần theo lý do trong một bước thời gian — không có nội
   * dung, có thể không có tên đối tượng.
   */
  fromPrometheus?: boolean
}

export interface TimelineResult {
  entries: TimelineEntry[]
  /** Cluster đang được ghi event trên máy (theo dõi ở Home). */
  recording: boolean
  /** Event cũ nhất cluster còn giữ (ms) — trước mốc này chỉ có bản ghi trên máy. */
  liveEventsSince?: number
}

/** Giữ event trên máy chừng này. */
export const EVENT_RETENTION_MS = 7 * 86_400_000

/** Một event đã thu gọn để ghi (Session Host → main). */
export const RecordedEvent = z.object({
  uid: z.string().min(1).max(64),
  namespace: z.string().max(253),
  kind: z.string().max(253),
  name: z.string().max(253),
  reason: z.string().max(253),
  type: z.string().max(32),
  message: z.string().max(2000),
  count: z.number().int().min(1).max(1e9),
  first: z.number().int().min(0),
  last: z.number().int().min(0)
})
export type RecordedEvent = z.infer<typeof RecordedEvent>

/** Session Host → main: ghi một lô event của cluster (khoá context). */
export const RecordEvents = z.object({
  cluster: z.string().min(1).max(4200),
  events: z.array(RecordedEvent).max(5000)
})

/** Session Host → main: event đã ghi của các đối tượng (theo namespace + tên) từ mốc `since`. */
export const QueryEvents = z.object({
  cluster: z.string().min(1).max(4200),
  namespace: z.string().max(253),
  names: z.array(z.string().max(253)).max(2000),
  /** Tên bắt đầu bằng (pod / ReplicaSet cũ đã xoá của workload: "web-"). */
  prefixes: z.array(z.string().min(1).max(253)).max(10),
  /** Node (event của node nằm ở namespace "default" / không namespace). */
  nodes: z.array(z.string().max(253)).max(500),
  since: z.number().int().min(0)
})
export type QueryEvents = z.infer<typeof QueryEvents>

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const time = (...values: unknown[]): number => {
  for (const v of values) {
    const at = Date.parse(str(v))
    if (!Number.isNaN(at)) return at
  }
  return 0
}

/** Event core/v1 → bản thu gọn để ghi; thiếu uid / thời điểm → null. */
export function slimEvent(e: { metadata?: unknown } & Obj): RecordedEvent | null {
  const meta = obj(e.metadata)
  const uid = str(meta['uid'])
  const involved = obj(e['involvedObject'])
  const series = obj(e['series'])
  const last = time(
    series['lastObservedTime'],
    e['lastTimestamp'],
    e['eventTime'],
    meta['creationTimestamp']
  )
  const first = time(e['firstTimestamp'], e['eventTime'], meta['creationTimestamp']) || last
  if (!uid || !last) return null
  const count =
    (typeof series['count'] === 'number' ? series['count'] : 0) ||
    (typeof e['count'] === 'number' ? e['count'] : 0) ||
    1
  return {
    uid: uid.slice(0, 64),
    namespace: str(involved['namespace']) || str(meta['namespace']),
    kind: str(involved['kind']),
    name: str(involved['name']),
    reason: str(e['reason']).slice(0, 253),
    type: str(e['type']).slice(0, 32) || 'Normal',
    message: str(e['message']).slice(0, 2000),
    count: Math.max(1, Math.min(1e9, Math.floor(count))),
    first: Math.min(first, last),
    last
  }
}

/**
 * Tên pod / ReplicaSet / Job thuộc workload (kể cả bản đã xoá — chỉ còn trong event): Deployment
 * `web-<hash>` (ReplicaSet) và `web-<hash>-<id>` (pod), StatefulSet `web-0`, DaemonSet `web-<id>`.
 */
export function ownedNamePattern(kindId: string, name: string): RegExp {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (kindId === 'statefulsets.apps') return new RegExp(`^${n}-\\d+$`)
  if (kindId === 'daemonsets.apps') return new RegExp(`^${n}-[a-z0-9]{5}$`)
  return new RegExp(`^${n}-[a-z0-9]{6,10}(?:-[a-z0-9]{5})?$`)
}
