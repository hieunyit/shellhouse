import type { WatchEvent } from './ops'
import type { K8sObject } from './resources'

/** Khoá của đối tượng trong bảng: "namespace/tên" (loại cluster: "tên"). */
export const objectKey = (o: K8sObject): string =>
  o.metadata.namespace ? `${o.metadata.namespace}/${o.metadata.name}` : o.metadata.name

/** Áp một lô sự kiện watch lên bản đồ đối tượng (bản mới; không đổi gì → trả lại bản cũ). */
export function applyWatchEvents(
  map: Map<string, K8sObject>,
  events: WatchEvent['events']
): Map<string, K8sObject> {
  if (events.length === 0) return map
  const next = new Map(map)
  for (const e of events) {
    const obj = e.object as K8sObject
    if (e.type === 'DELETED') next.delete(objectKey(obj))
    else next.set(objectKey(obj), obj)
  }
  return next
}

/** Chạy `fn` cho từng phần tử, tối đa `limit` việc cùng lúc; giữ thứ tự kết quả. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
