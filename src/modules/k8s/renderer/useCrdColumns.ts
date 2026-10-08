import { useEffect, useReducer } from 'react'
import type { K8sOp } from '../shared/ops'
import type { PrinterColumn } from '../shared/printer'

/** Cột của CRD theo (cluster, loại, lần Reload) — đọc một lần; Reload đọc lại (CRD vừa sửa cột). */
const cache = new Map<string, PrinterColumn[]>()

/**
 * Cột `additionalPrinterColumns` của loại tài nguyên tuỳ chỉnh (CRD): bảng hiện đúng cột như
 * `kubectl get`. `enabled` false (loại có sẵn / đã có cột riêng) → không hỏi. Chưa đọc xong hoặc
 * không đọc được → null (bảng chỉ có Name / Namespace / Age như trước).
 */
export function useCrdColumns({
  ready,
  request,
  refKey,
  kindId,
  enabled,
  reloadKey
}: {
  ready: boolean
  request: <T>(op: K8sOp) => Promise<T>
  refKey: string
  kindId: string
  enabled: boolean
  reloadKey: number
}): PrinterColumn[] | null {
  const key = `${refKey}|${kindId}|${String(reloadKey)}`
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const known = cache.has(key)
  useEffect(() => {
    if (!ready || !enabled || known) return
    let cancelled = false
    request<PrinterColumn[]>({ op: 'crd.columns', kind: kindId }).then(
      (columns) => {
        cache.set(key, columns)
        if (!cancelled) refresh()
      },
      () => {
        cache.set(key, [])
        if (!cancelled) refresh()
      }
    )
    return () => {
      cancelled = true
    }
  }, [ready, enabled, known, request, key, kindId])
  const columns = enabled ? cache.get(key) : undefined
  return columns?.length ? columns : null
}
