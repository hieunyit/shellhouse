/**
 * So sánh theo dòng (Myers O(ND)) cho xem trước thay đổi / so sánh revision Helm. Thuần TS, không
 * phụ thuộc — dùng được ở renderer lẫn test.
 */

export type DiffOp = 'same' | 'add' | 'del'

export interface DiffLine {
  op: DiffOp
  text: string
  /** Số dòng (1-based) bên trái / bên phải; undefined nếu dòng không có ở bên đó. */
  a?: number
  b?: number
}

/** Quá chừng này (tổng số dòng hai bên × độ khác) → so sánh thô (xoá hết / thêm hết) cho nhanh. */
const MAX_COST = 4_000_000

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Diff dòng: chuỗi thao tác giữ / thêm / xoá theo thứ tự (dòng chung giữ nguyên). */
export function lineDiff(left: string, right: string): DiffLine[] {
  const a = splitLines(left)
  const b = splitLines(right)
  // Bỏ phần đầu / cuối giống nhau (YAML sửa ít — nhanh hơn nhiều).
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push({ op: 'same', text: a[i] ?? '', a: i + 1, b: i + 1 })
  const mid = myers(a.slice(start, endA), b.slice(start, endB))
  let ia = start
  let ib = start
  for (const op of mid) {
    if (op === 'same') {
      out.push({ op, text: a[ia] ?? '', a: ia + 1, b: ib + 1 })
      ia++
      ib++
    } else if (op === 'del') {
      out.push({ op, text: a[ia] ?? '', a: ia + 1 })
      ia++
    } else {
      out.push({ op, text: b[ib] ?? '', b: ib + 1 })
      ib++
    }
  }
  for (let i = endA; i < a.length; i++)
    out.push({ op: 'same', text: a[i] ?? '', a: i + 1, b: i - endA + endB + 1 })
  return out
}

/** Myers: dãy thao tác ngắn nhất biến a thành b (xoá trước thêm trong mỗi đoạn khác). */
function myers(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  if (n === 0) return Array<DiffOp>(m).fill('add')
  if (m === 0) return Array<DiffOp>(n).fill('del')
  const max = n + m
  const offset = max
  const v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    if (d * (n + m) > MAX_COST) {
      // Khác quá nhiều: xoá hết rồi thêm hết (đúng, chỉ không tối ưu).
      return [...Array<DiffOp>(n).fill('del'), ...Array<DiffOp>(m).fill('add')]
    }
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
          ? (v[offset + k + 1] ?? 0)
          : (v[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
  }
  // Lần ngược theo trace.
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d] as Int32Array
    const k = x - y
    const prevK =
      k === -d || (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0)) ? k + 1 : k - 1
    const prevX = vd[offset + prevK] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('same')
      x--
      y--
    }
    if (x === prevX) {
      ops.push('add')
      y--
    } else {
      ops.push('del')
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push('same')
    x--
    y--
  }
  return ops.reverse()
}

export interface DiffStats {
  added: number
  removed: number
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.op === 'add') added++
    else if (l.op === 'del') removed++
  }
  return { added, removed }
}

/** Một đoạn hiển thị: các dòng, hoặc chỗ gập "N dòng không đổi". */
export type DiffChunk =
  { kind: 'lines'; lines: DiffLine[] } | { kind: 'fold'; count: number; lines: DiffLine[] }

/** Gập đoạn không đổi dài, giữ `context` dòng quanh mỗi thay đổi (như `diff -U3`). */
export function foldUnchanged(lines: readonly DiffLine[], context = 3): DiffChunk[] {
  const keep = new Uint8Array(lines.length)
  lines.forEach((l, i) => {
    if (l.op === 'same') return
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++)
      keep[j] = 1
  })
  const out: DiffChunk[] = []
  let i = 0
  while (i < lines.length) {
    const kept = keep[i] === 1
    let j = i
    while (j < lines.length && (keep[j] === 1) === kept) j++
    const part = lines.slice(i, j)
    // Đoạn gập quá ngắn → hiện luôn (gập 1–2 dòng không đáng).
    if (kept || part.length <= 2) {
      const last = out.at(-1)
      if (last?.kind === 'lines') last.lines.push(...part)
      else out.push({ kind: 'lines', lines: part })
    } else out.push({ kind: 'fold', count: part.length, lines: part })
    i = j
  }
  return out
}

/** Hàng hai cột (side-by-side): dòng xoá ghép với dòng thêm cùng đoạn. */
export interface SplitRow {
  left?: DiffLine
  right?: DiffLine
}

export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i] as DiffLine
    if (l.op === 'same') {
      rows.push({ left: l, right: l })
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i]?.op === 'del') dels.push(lines[i++] as DiffLine)
    while (i < lines.length && lines[i]?.op === 'add') adds.push(lines[i++] as DiffLine)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      rows.push({
        ...(dels[k] ? { left: dels[k] } : {}),
        ...(adds[k] ? { right: adds[k] } : {})
      })
  }
  return rows
}
