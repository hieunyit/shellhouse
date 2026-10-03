import type { Usage } from './ops'
import type { K8sObject, ResourceRow } from './resources'

/** Một dòng của bảng tài nguyên. */
export type Row = { obj: K8sObject; row: ResourceRow }
export type RowSortKey = 'name' | 'age' | 'cpu' | 'mem'
type CellTone = 'warn' | 'bad'

/** So sánh chuỗi dùng chung (localeCompare tạo collator mỗi lần gọi — chậm với vài nghìn dòng). */
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Màu chữ cho ô số (design guide §4): Restarts > 0 cảnh báo, > 5 nguy hiểm; Ready "a/b" thiếu → cảnh
 * báo (0/b → nguy hiểm). Dòng muted (Completed…) không tô — pod Job xong ready 0/1 là bình thường.
 */
export function cellTone(
  column: string,
  text: string,
  rowTone: ResourceRow['tone']
): CellTone | null {
  if (rowTone === 'muted') return null
  if (column === 'restarts') {
    const n = Number.parseInt(text, 10)
    if (!Number.isFinite(n) || n <= 0) return null
    return n > 5 ? 'bad' : 'warn'
  }
  if (column === 'ready') {
    const m = /^(\d+)\/(\d+)$/.exec(text.trim())
    if (!m) return null
    const have = Number(m[1])
    const want = Number(m[2])
    if (want === 0 || have >= want) return null
    return have === 0 ? 'bad' : 'warn'
  }
  return null
}

/** Chuỗi tìm kiếm của dòng (chữ thường) — tính một lần cho mỗi dòng. */
const haystacks = new WeakMap<ResourceRow, string>()
function haystack(row: ResourceRow): string {
  let h = haystacks.get(row)
  if (h === undefined) {
    h = [row.name, row.namespace, ...Object.values(row.cells)].join('\u0000').toLowerCase()
    haystacks.set(row, h)
  }
  return h
}

/** Lọc theo chuỗi (đã trim + chữ thường): tên, namespace, mọi ô. */
export function filterRows(rows: readonly Row[], q: string): readonly Row[] {
  if (!q) return rows
  return rows.filter((r) => haystack(r.row).includes(q))
}

/**
 * Sắp xếp (bản mới). Tên: theo tên rồi namespace (không theo "ns/tên" — cùng tên ở các namespace
 * đứng cạnh nhau). Số liệu: thiếu số → cuối khi giảm dần.
 */
export function sortRows(
  rows: readonly Row[],
  sort: { key: RowSortKey; dir: 'asc' | 'desc' },
  usage: (o: K8sObject) => Usage | undefined
): Row[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  const byName = (x: Row, y: Row): number =>
    collator.compare(x.row.name, y.row.name) || collator.compare(x.row.namespace, y.row.namespace)
  if (sort.key === 'name') return [...rows].sort((x, y) => byName(x, y) * dir)
  if (sort.key === 'age')
    return [...rows].sort((x, y) => (x.row.created - y.row.created) * dir || byName(x, y))
  // Đọc số liệu một lần cho mỗi dòng (không tra map trong mỗi lần so sánh).
  const pick = sort.key === 'cpu' ? (u: Usage) => u.cpu : (u: Usage) => u.memory
  const value = new Map<Row, number>()
  for (const r of rows) {
    const u = usage(r.obj)
    value.set(r, u ? pick(u) : -1)
  }
  return [...rows].sort(
    (x, y) => ((value.get(x) ?? -1) - (value.get(y) ?? -1)) * dir || byName(x, y)
  )
}
