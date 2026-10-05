import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { MetricsResult } from '../shared/ops'
import { toRow, type K8sObject, type ResourceRow } from '../shared/resources'
import { filterRows, sortRows, type Row, type RowSortKey } from '../shared/rows'
import {
  looksLikeSelector,
  matchesSelector,
  parseSelector,
  type SelectorParse
} from '../shared/selector'
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
/** Cột có chip lọc (Pods: Status, Node). */
const FACET_COLUMNS = ['status', 'node'] as const

export function useResourceRows({
  objects,
  kindId,
  query,
  sort,
  metrics,
  selected,
  detailKey,
  active,
  facets = {}
}: {
  objects: Map<string, K8sObject> | null
  kindId: string
  query: string
  sort: { key: RowSortKey; dir: 'asc' | 'desc' }
  metrics: MetricsResult | null
  selected: ReadonlySet<string>
  detailKey: string | null
  active: boolean
  /** Chip lọc theo cột (Status, Node…): cột → giá trị phải khớp; thiếu = không lọc. */
  facets?: Readonly<Record<string, string>>
}): {
  rows: Row[]
  /** Chữ lọc đang áp dụng (chữ thường, '' = không lọc / đang gõ lệnh / đang lọc theo nhãn). */
  q: string
  /** Ô lọc là label selector (kubectl -l): đã đọc được hay lỗi cú pháp. */
  selector: SelectorParse | null
  single: Row | undefined
  detail: Row | undefined
  /** Giá trị có trong bảng (trước chip) theo cột có chip, kèm số dòng — cho menu của chip. */
  facetValues: Readonly<Record<string, [string, number][]>>
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
  const selector = useMemo(
    () =>
      !deferredQuery.startsWith(':') && looksLikeSelector(deferredQuery)
        ? parseSelector(deferredQuery)
        : null,
    [deferredQuery]
  )
  const q = deferredQuery.startsWith(':') || selector ? '' : deferredQuery.trim().toLowerCase()
  const allRows = useMemo<Row[]>(
    () =>
      objects ? [...objects.values()].map((obj) => ({ obj, row: cachedRow(kindId, obj) })) : [],
    // ageTick: cột tuổi làm mới mỗi 30 giây.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objects, kindId, ageTick]
  )
  const facetKey = JSON.stringify(facets)
  const filteredRows = useMemo(() => {
    const base = selector?.ok
      ? allRows.filter((r) => matchesSelector(r.obj.metadata.labels, selector.requirements))
      : filterRows(allRows, q)
    const entries = Object.entries(JSON.parse(facetKey) as Record<string, string>)
    return entries.length === 0
      ? base
      : base.filter((r) => entries.every(([col, v]) => (r.row.cells[col] ?? '') === v))
  }, [allRows, q, selector, facetKey])
  const facetValues = useMemo(() => {
    const out: Record<string, [string, number][]> = {}
    for (const column of FACET_COLUMNS) {
      const counts = new Map<string, number>()
      for (const r of allRows) {
        const v = r.row.cells[column]
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
      }
      out[column] = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    }
    return out
  }, [allRows])
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
  return { rows, q, selector, single, detail, facetValues }
}
