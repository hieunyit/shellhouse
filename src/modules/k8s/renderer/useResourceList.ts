import { useEffect, useRef, useState } from 'react'
import { cleanError } from '../../../renderer/src/lib/format'
import type { K8sOp, WatchEvent } from '../shared/ops'
import type { K8sObject } from '../shared/resources'

const PAGE = 500
const MAX_PAGES = 20

/** Nhận sự kiện của phiên (watch, forwards…) — ClusterTab phát cho các hook đăng ký. */
export type EventBus = Set<(event: string, data: unknown) => void>

export interface ListQuery {
  kind: string
  namespaced: boolean
  /** [] = mọi namespace. */
  namespaces: readonly string[]
  labelSelector?: string | undefined
  fieldSelector?: string | undefined
}

export const objectKey = (o: K8sObject): string =>
  o.metadata.namespace ? `${o.metadata.namespace}/${o.metadata.name}` : o.metadata.name

/**
 * List (phân trang) rồi watch từ resourceVersion cho từng namespace đang xem; sự kiện watch cập
 * nhật bảng tại chỗ; 410 Gone → list lại.
 */
export function useResourceList(
  ready: boolean,
  request: <T>(op: K8sOp) => Promise<T>,
  bus: EventBus,
  query: ListQuery | null,
  reloadKey: number
): { objects: Map<string, K8sObject> | null; error: string | null; reload: () => void } {
  // Dữ liệu gắn với truy vấn đã tạo ra nó: đổi truy vấn → hiện "đang tải" ngay, không lẫn dữ liệu cũ.
  const [data, setData] = useState<{ key: string; map: Map<string, K8sObject> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [relist, setRelist] = useState(0)
  const subs = useRef(new Set<string>())
  const queryKey = query
    ? `${query.kind}|${query.namespaces.join(',')}|${query.labelSelector ?? ''}|${query.fieldSelector ?? ''}|${query.namespaced}`
    : ''

  useEffect(() => {
    const active = subs.current
    const listener = (event: string, data: unknown): void => {
      if (event !== 'watch') return
      const w = data as WatchEvent & { error?: string }
      if (!active.has(w.subscription)) return
      if (w.relist) {
        setRelist((n) => n + 1)
        return
      }
      if (w.error) setError(w.error)
      if (w.events.length === 0) return
      setData((prev) => {
        if (!prev) return prev
        const next = new Map(prev.map)
        for (const e of w.events) {
          const obj = e.object as K8sObject
          if (e.type === 'DELETED') next.delete(objectKey(obj))
          else next.set(objectKey(obj), obj)
        }
        return { key: prev.key, map: next }
      })
    }
    bus.add(listener)
    return () => {
      bus.delete(listener)
    }
  }, [bus])

  useEffect(() => {
    if (!ready || !query) return
    const state = { cancelled: false }
    const isCancelled = (): boolean => state.cancelled
    const mine: string[] = []
    const active = subs.current
    const scope: (string | undefined)[] =
      !query.namespaced || query.namespaces.length === 0 ? [undefined] : [...query.namespaces]
    const run = async (): Promise<void> => {
      const all = new Map<string, K8sObject>()
      const versions: { ns: string | undefined; rv: string }[] = []
      for (const ns of scope) {
        let cont: string | undefined
        let rv = ''
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await request<{
            items: K8sObject[]
            resourceVersion: string
            continue: string | null
          }>({
            op: 'list',
            kind: query.kind,
            ...(ns ? { namespace: ns } : {}),
            ...(query.labelSelector ? { labelSelector: query.labelSelector } : {}),
            ...(query.fieldSelector ? { fieldSelector: query.fieldSelector } : {}),
            limit: PAGE,
            ...(cont ? { continue: cont } : {})
          })
          for (const obj of r.items) all.set(objectKey(obj), obj)
          rv = r.resourceVersion
          if (!r.continue) break
          cont = r.continue
        }
        versions.push({ ns, rv })
      }
      if (isCancelled()) return
      setData({ key: queryKey, map: all })
      setError(null)
      for (const v of versions) {
        const w = await request<{ subscription: string }>({
          op: 'watch',
          kind: query.kind,
          ...(v.ns ? { namespace: v.ns } : {}),
          ...(query.labelSelector ? { labelSelector: query.labelSelector } : {}),
          ...(query.fieldSelector ? { fieldSelector: query.fieldSelector } : {}),
          resourceVersion: v.rv
        })
        if (isCancelled()) {
          void request({ op: 'unsubscribe', subscription: w.subscription })
          return
        }
        mine.push(w.subscription)
        active.add(w.subscription)
      }
    }
    run().catch((e: unknown) => {
      if (!state.cancelled) setError(cleanError(e))
    })
    return () => {
      state.cancelled = true
      for (const sub of mine) {
        active.delete(sub)
        void request({ op: 'unsubscribe', subscription: sub }).catch(() => undefined)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey đại diện cho query
  }, [ready, request, queryKey, reloadKey, relist])

  return {
    objects: data && data.key === queryKey ? data.map : null,
    error,
    reload: () => {
      setRelist((n) => n + 1)
    }
  }
}
