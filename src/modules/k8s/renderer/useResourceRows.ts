import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { MetricsResult } from '../shared/ops'
import { toRow, type K8sObject, type ResourceRow } from '../shared/resources'
import { filterRows, sortRows, type Row, type RowSortKey } from '../shared/rows'
import { objectKey } from './useResourceList'

/**
 * Dòng bảng nhớ theo đối tượng: watch thay đối tượng đổi bằng đối tượng mới, đối tượng không đổi
 * giữ nguyên → chỉ tính lại dòng thay đổi (3000 pod, mỗi lô vài pod). Làm mới mỗi 30 giây cho
 * cột tuổi.
 */
const rowCache = new WeakMap<K8sObject, { kind: string; bucket: number; row: ResourceRow }>()
export function cachedRow(kindId: string, obj: K8sObject): ResourceRow {
  const bucket = Math.floor(Date.now() / 30_000)
  const hit = rowCache.get(obj)
  if (hit && hit.kind === kindId && hit.bucket === bucket) return hit.row
  const row = toRow(kindId, obj)
  rowCache.set(obj, { kind: kindId, bucket, row })
  return row
}

/**
 * Dòng của bảng: chỉ tính lại khi dữ liệu / bộ lọc / cách xếp đổi (không theo mỗi lần render);
 * chữ lọc hoãn (useDeferredValue) để gõ không giật với vài nghìn dòng.
 */
export function useResourceRows({
  objects,
  kindId,
  query,
  sort,
  metrics,
  selected,
  detailKey,
  active
}: {
  objects: Map<string, K8sObject> | null
  kindId: string
  query: string
  sort: { key: RowSortKey; dir: 'asc' | 'desc' }
  metrics: MetricsResult | null
  selected: ReadonlySet<string>
  detailKey: string | null
  active: boolean
}): {
  rows: Row[]
  /** Chữ lọc đang áp dụng (chữ thường, '' = không lọc / đang gõ lệnh). */
  q: string
  single: Row | undefined
  detail: Row | undefined
} {
  /** Nhịp 30 giây cho cột tuổi (dòng bảng nhớ theo đối tượng). */
  const [ageTick, setAgeTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => {
      setAgeTick((n) => n + 1)
    }, 30_000)
    return () => {
      clearInterval(t)
    }
  }, [active])

  const deferredQuery = useDeferredValue(query)
  const q = deferredQuery.startsWith(':') ? '' : deferredQuery.trim().toLowerCase()
  const allRows = useMemo<Row[]>(
    () =>
      objects ? [...objects.values()].map((obj) => ({ obj, row: cachedRow(kindId, obj) })) : [],
    // ageTick: cột tuổi làm mới mỗi 30 giây.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objects, kindId, ageTick]
  )
  const filteredRows = useMemo(() => filterRows(allRows, q), [allRows, q])
  // Số liệu chỉ ảnh hưởng thứ tự khi đang xếp theo CPU / RAM.
  const sortMetrics = sort.key === 'cpu' || sort.key === 'mem' ? metrics : null
  const rows = useMemo(
    () => sortRows(filteredRows, sort, (o) => sortMetrics?.items[objectKey(o)]),
    [filteredRows, sort, sortMetrics]
  )
  const single = useMemo(() => {
    if (selected.size !== 1) return undefined
    const key = [...selected][0]
    return rows.find((r) => r.row.key === key)
  }, [rows, selected])
  // Chi tiết lấy từ dữ liệu, không từ dòng đang lọc: gõ lọc không đóng mất chi tiết đang xem.
  const detailObj = detailKey ? objects?.get(detailKey) : undefined
  const detail = detailObj ? { obj: detailObj, row: cachedRow(kindId, detailObj) } : undefined
  return { rows, q, single, detail }
}
