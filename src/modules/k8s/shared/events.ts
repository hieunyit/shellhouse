import type { K8sObject } from './resources'

/**
 * Sự kiện Kubernetes (core/v1 Event) → dạng gọn để hiện; gộp sự kiện trùng như `kubectl describe`
 * ("×12 over 5m"). Hỗ trợ cả kiểu cũ (count / firstTimestamp / lastTimestamp) lẫn kiểu mới
 * (series.count / series.lastObservedTime / eventTime).
 */

export interface EventInfo {
  /** Khoá ổn định (gộp): đối tượng + loại + lý do + thông điệp. */
  key: string
  /** Normal / Warning (có thể loại khác). */
  type: string
  reason: string
  message: string
  count: number
  /** ms; 0 = không rõ. */
  first: number
  last: number
  namespace: string
  object: { kind: string; name: string; namespace?: string }
  /** Nguồn: "kubelet", "default-scheduler"… */
  source: string
  /** Tên các Event gốc (gộp). */
  names: string[]
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const time = (...vals: unknown[]): number => {
  for (const v of vals) {
    const t = typeof v === 'string' ? Date.parse(v) : NaN
    if (Number.isFinite(t) && t > 0) return t
  }
  return 0
}

export function eventInfo(e: K8sObject): EventInfo {
  const involved = (e['involvedObject'] ?? e['regarding'] ?? {}) as {
    kind?: string
    name?: string
    namespace?: string
    uid?: string
  }
  const series = (e['series'] ?? {}) as { count?: number; lastObservedTime?: string }
  const source = (e['source'] ?? {}) as { component?: string; host?: string }
  const count =
    typeof series.count === 'number'
      ? series.count
      : typeof e['count'] === 'number'
        ? e['count']
        : 1
  const last = time(
    series.lastObservedTime,
    e['lastTimestamp'],
    e['eventTime'],
    e.metadata.creationTimestamp
  )
  const first = time(e['firstTimestamp'], e['eventTime'], e.metadata.creationTimestamp) || last
  const type = str(e['type']) || 'Normal'
  const reason = str(e['reason'])
  const message = str(e['message'] ?? e['note']).trim()
  const object = {
    kind: involved.kind ?? '',
    name: involved.name ?? '',
    ...(involved.namespace ? { namespace: involved.namespace } : {})
  }
  return {
    key: `${involved.uid ?? `${object.kind}/${object.namespace ?? ''}/${object.name}`}|${type}|${reason}|${message}`,
    type,
    reason,
    message,
    count,
    first,
    last,
    namespace: e.metadata.namespace ?? '',
    object,
    source: str(source.component) || str(e['reportingController']) || str(source.host),
    names: [e.metadata.name]
  }
}

/** Gộp sự kiện trùng (cùng đối tượng / loại / lý do / thông điệp); mới nhất trước. */
export function aggregateEvents(events: Iterable<K8sObject>): EventInfo[] {
  const map = new Map<string, EventInfo>()
  for (const e of events) {
    const info = eventInfo(e)
    const prev = map.get(info.key)
    if (!prev) {
      map.set(info.key, info)
      continue
    }
    map.set(info.key, {
      ...prev,
      count: prev.count + info.count,
      first: Math.min(prev.first || info.first, info.first || prev.first),
      last: Math.max(prev.last, info.last),
      source: prev.source || info.source,
      names: [...prev.names, ...info.names]
    })
  }
  return [...map.values()].sort((a, b) => b.last - a.last || a.reason.localeCompare(b.reason))
}

export interface EventFilter {
  type: 'all' | 'Warning' | 'Normal'
  /** Lý do (rỗng = mọi lý do). */
  reasons: readonly string[]
  /** Chữ tìm trong lý do / thông điệp / đối tượng. */
  text: string
}

export function filterEvents(list: readonly EventInfo[], f: EventFilter): EventInfo[] {
  const q = f.text.trim().toLowerCase()
  return list.filter(
    (e) =>
      (f.type === 'all' || e.type === f.type) &&
      (f.reasons.length === 0 || f.reasons.includes(e.reason)) &&
      (!q ||
        e.reason.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q) ||
        `${e.object.kind}/${e.object.name}`.toLowerCase().includes(q))
  )
}

/** Các lý do có trong danh sách (cảnh báo trước, rồi theo số lần). */
export function reasonsOf(
  list: readonly EventInfo[]
): { reason: string; warning: boolean; count: number }[] {
  const map = new Map<string, { reason: string; warning: boolean; count: number }>()
  for (const e of list) {
    const r = map.get(e.reason) ?? { reason: e.reason, warning: false, count: 0 }
    r.count += 1
    r.warning ||= e.type === 'Warning'
    map.set(e.reason, r)
  }
  return [...map.values()].sort(
    (a, b) =>
      Number(b.warning) - Number(a.warning) || b.count - a.count || a.reason.localeCompare(b.reason)
  )
}
