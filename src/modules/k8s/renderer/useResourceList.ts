import { useCallback, useEffect, useRef, useState } from 'react'
import { cleanError } from '../../../renderer/src/lib/format'
import type { K8sOp, WatchEvent } from '../shared/ops'
import type { K8sObject } from '../shared/resources'
import { applyWatchEvents, mapLimit, objectKey } from '../shared/watch'

const PAGE = 500
const MAX_PAGES = 20
/** Tab ẩn lâu, cluster thay đổi nhiều: giữ quá chừng này sự kiện thì bỏ, list lại khi hiện tab. */
const MAX_HELD = 5000
/** Số namespace list cùng lúc (chọn nhiều namespace). */
const NS_PARALLEL = 4

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

export { objectKey }

export interface ResourceList {
  objects: Map<string, K8sObject> | null
  error: string | null
  /** Danh sách bị cắt ở MAX_PAGES trang (cluster rất lớn) — nên lọc hẹp hơn. */
  truncated: number | null
  /** API server không trả lời từ lúc này (ms) — dữ liệu trên bảng có thể đã cũ; null = bình thường. */
  stale: number | null
  reload: () => void
}

/**
 * List (phân trang) rồi watch từ resourceVersion cho từng namespace đang xem; sự kiện watch cập
 * nhật bảng tại chỗ (gom theo khung hình — nhiều lô một lần vẽ); 410 Gone → list lại.
 */
export function useResourceList(
  ready: boolean,
  request: <T>(op: K8sOp) => Promise<T>,
  bus: EventBus,
  query: ListQuery | null,
  reloadKey: number,
  /** Tab đang hiện. Tab ẩn: gom sự kiện watch, áp dụng một lần khi hiện lại (không vẽ lại vô ích). */
  active = true
): ResourceList {
  // Dữ liệu gắn với truy vấn + phiên (request) đã tạo ra nó: đổi truy vấn hay đổi context → hiện
  // "đang tải" ngay, không lẫn dữ liệu cũ.
  const [data, setData] = useState<{
    key: string
    request: unknown
    map: Map<string, K8sObject>
    truncated: number | null
  } | null>(null)
  const [error, setError] = useState<{ key: string; text: string } | null>(null)
  const [relist, setRelist] = useState(0)
  const [stale, setStale] = useState<number | null>(null)
  const subs = useRef(new Set<string>())
  const activeRef = useRef(active)
  const held = useRef<WatchEvent['events']>([])
  const overflow = useRef(false)
  /** Sự kiện chờ khung hình kế tiếp (gom nhiều lô watch thành một lần setState). */
  const pending = useRef<WatchEvent['events']>([])
  const frame = useRef<number | null>(null)
  const queryKey = query
    ? `${query.kind}|${query.namespaces.join(',')}|${query.labelSelector ?? ''}|${query.fieldSelector ?? ''}|${query.namespaced}`
    : ''

  const flush = useCallback(() => {
    frame.current = null
    const events = pending.current
    if (events.length === 0) return
    pending.current = []
    setData((prev) => {
      if (!prev) return prev
      const map = applyWatchEvents(prev.map, events)
      return map === prev.map ? prev : { ...prev, map }
    })
  }, [])

  const applyEvents = useCallback(
    (events: WatchEvent['events']) => {
      for (const e of events) pending.current.push(e)
      // Cửa sổ thu nhỏ → không có khung hình: đừng để hàng đợi phình mãi.
      if (pending.current.length > MAX_HELD) {
        if (frame.current !== null) cancelAnimationFrame(frame.current)
        flush()
        return
      }
      frame.current ??= requestAnimationFrame(flush)
    },
    [flush]
  )

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    []
  )

  useEffect(() => {
    activeRef.current = active
    if (!active) return
    if (overflow.current) {
      overflow.current = false
      held.current = []
      setRelist((n) => n + 1)
      return
    }
    if (held.current.length === 0) return
    const events = held.current
    held.current = []
    applyEvents(events)
  }, [active, applyEvents])

  useEffect(() => {
    const mine = subs.current
    const listener = (event: string, payload: unknown): void => {
      if (event !== 'watch') return
      const w = payload as WatchEvent & { error?: string }
      if (!mine.has(w.subscription)) return
      if (w.stale !== undefined) setStale(w.stale ? Date.now() : null)
      if (w.relist) {
        setRelist((n) => n + 1)
        return
      }
      if (w.error) setError({ key: queryKey, text: w.error })
      if (w.events.length === 0) return
      if (activeRef.current) applyEvents(w.events)
      else if (!overflow.current) {
        held.current.push(...w.events)
        if (held.current.length > MAX_HELD) {
          overflow.current = true
          held.current = []
        }
      }
    }
    bus.add(listener)
    return () => {
      bus.delete(listener)
    }
  }, [bus, applyEvents, queryKey])

  useEffect(() => {
    if (!ready || !query) return
    const state = { cancelled: false }
    const isCancelled = (): boolean => state.cancelled
    const mine: string[] = []
    const active = subs.current
    const scope: (string | undefined)[] =
      !query.namespaced || query.namespaces.length === 0 ? [undefined] : [...query.namespaces]
    const listNs = async (
      ns: string | undefined
    ): Promise<{ ns: string | undefined; rv: string; items: K8sObject[]; cut: boolean }> => {
      let cont: string | undefined
      let rv = ''
      const items: K8sObject[] = []
      for (let page = 0; page < MAX_PAGES; page++) {
        if (state.cancelled) break
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
        for (const obj of r.items) items.push(obj)
        rv = r.resourceVersion
        if (!r.continue) return { ns, rv, items, cut: false }
        cont = r.continue
      }
      return { ns, rv, items, cut: cont !== undefined }
    }
    const run = async (): Promise<void> => {
      const lists = await mapLimit(scope, NS_PARALLEL, listNs)
      if (state.cancelled) return
      const all = new Map<string, K8sObject>()
      for (const l of lists) for (const obj of l.items) all.set(objectKey(obj), obj)
      // Danh sách mới thay hết — sự kiện đang giữ / chờ vẽ đã cũ.
      held.current = []
      pending.current = []
      const cut = lists.some((l) => l.cut)
      setData({ key: queryKey, request, map: all, truncated: cut ? all.size : null })
      setError(null)
      setStale(null)
      for (const v of lists) {
        const w = await request<{ subscription: string }>({
          op: 'watch',
          kind: query.kind,
          ...(v.ns ? { namespace: v.ns } : {}),
          ...(query.labelSelector ? { labelSelector: query.labelSelector } : {}),
          ...(query.fieldSelector ? { fieldSelector: query.fieldSelector } : {}),
          resourceVersion: v.rv
        })
        if (isCancelled()) {
          void request({ op: 'unsubscribe', subscription: w.subscription }).catch(() => undefined)
          return
        }
        mine.push(w.subscription)
        active.add(w.subscription)
      }
    }
    run().catch((e: unknown) => {
      if (!state.cancelled) setError({ key: queryKey, text: cleanError(e) })
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

  const current = data && data.key === queryKey && data.request === request ? data : null
  return {
    objects: current?.map ?? null,
    // Lỗi của truy vấn trước không hiện khi đã đổi truy vấn.
    error: error && error.key === queryKey ? error.text : null,
    truncated: current?.truncated ?? null,
    stale,
    reload: () => {
      setRelist((n) => n + 1)
    }
  }
}
