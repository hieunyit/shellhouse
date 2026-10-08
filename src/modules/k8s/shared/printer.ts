import { age } from './resources'

/**
 * Cột `additionalPrinterColumns` của CRD (cái `kubectl get <crd>` hiện): tên, kiểu và JSONPath. Bộ
 * đánh giá JSONPath dưới đây hỗ trợ đúng phần CRD dùng: `.a.b`, `['khoá.có.chấm']`, `[0]`, `[*]`,
 * `[?(@.type=="Ready")].status`. Cú pháp khác (đệ quy `..`, lát cắt, biểu thức) → không có giá trị.
 */
export interface PrinterColumn {
  /** Khoá ô trong `row.cells` (pc0, pc1…). */
  id: string
  label: string
  /** integer · number · string · boolean · date (kiểu OpenAPI của cột). */
  type: string
  jsonPath: string
}

type Step =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'all' }
  | { kind: 'filter'; path: Step[]; op: '==' | '!='; value: string | number | boolean | null }

const MAX_STEPS = 32

/** Đọc JSONPath thành các bước; null = cú pháp không hỗ trợ. */
export function parsePath(path: string): Step[] | null {
  let p = path.trim()
  if (p.startsWith('{') && p.endsWith('}')) p = p.slice(1, -1).trim()
  if (p.startsWith('$')) p = p.slice(1)
  const steps: Step[] = []
  let i = 0
  while (i < p.length) {
    if (steps.length > MAX_STEPS) return null
    const c = p[i]
    if (c === '.') {
      if (p[i + 1] === '.') return null
      i++
      let key = ''
      while (i < p.length && p[i] !== '.' && p[i] !== '[') {
        if (p[i] === '\\' && i + 1 < p.length) {
          key += p[i + 1] ?? ''
          i += 2
        } else key += p[i++] ?? ''
      }
      if (!key) return null
      steps.push(key === '*' ? { kind: 'all' } : { kind: 'key', key })
    } else if (c === '[') {
      const end = closing(p, i)
      if (end < 0) return null
      const inner = p.slice(i + 1, end).trim()
      i = end + 1
      if (inner === '*') steps.push({ kind: 'all' })
      else if (/^-?\d+$/.test(inner)) steps.push({ kind: 'index', index: Number(inner) })
      else if (/^(['"]).*\1$/.test(inner)) steps.push({ kind: 'key', key: inner.slice(1, -1) })
      else if (inner.startsWith('?(') && inner.endsWith(')')) {
        const f = filter(inner.slice(2, -1))
        if (!f) return null
        steps.push(f)
      } else return null
    } else if (steps.length === 0) {
      // "spec.size" sin dấu chấm đầu: coi như ".spec.size".
      p = `.${p.slice(i)}`
      i = 0
    } else return null
  }
  return steps
}

/** Vị trí `]` đóng ngoặc tại `open` (bỏ qua `]` trong chuỗi nháy và ngoặc lồng). */
function closing(p: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < p.length; i++) {
    const c = p[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === "'" || c === '"') quote = c
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i
  }
  return -1
}

/** `@.type=="Ready"` / `@.status!='False'` / `@.n==3`. */
function filter(expr: string): Step | null {
  const m = /^\s*@((?:\.[^=!\s]+)*)\s*(==|!=)\s*(.+?)\s*$/.exec(expr)
  if (!m) return null
  const path = parsePath(m[1] ?? '')
  if (!path) return null
  const raw = (m[3] ?? '').trim()
  let value: string | number | boolean | null
  if (/^(['"]).*\1$/.test(raw)) value = raw.slice(1, -1)
  else if (raw === 'true') value = true
  else if (raw === 'false') value = false
  else if (raw === 'null') value = null
  else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw)
  else return null
  return { kind: 'filter', path, op: m[2] === '!=' ? '!=' : '==', value }
}

function walk(nodes: unknown[], steps: readonly Step[]): unknown[] {
  let cur = nodes
  for (const step of steps) {
    const next: unknown[] = []
    for (const n of cur) {
      if (step.kind === 'key') {
        if (n && typeof n === 'object' && !Array.isArray(n)) {
          const v = (n as Record<string, unknown>)[step.key]
          if (v !== undefined) next.push(v)
        }
      } else if (step.kind === 'index') {
        if (Array.isArray(n)) {
          const list = n as unknown[]
          const v = list[step.index < 0 ? list.length + step.index : step.index]
          if (v !== undefined) next.push(v)
        }
      } else if (step.kind === 'all') {
        if (Array.isArray(n)) next.push(...(n as unknown[]))
        else if (n && typeof n === 'object') next.push(...(Object.values(n) as unknown[]))
      } else if (Array.isArray(n)) {
        for (const item of n) {
          const hit = walk([item], step.path)
          const match = hit.some((v) => (step.op === '==' ? v === step.value : v !== step.value))
          if (match) next.push(item)
        }
      }
    }
    cur = next
  }
  return cur
}

/** Giá trị JSONPath tại `root` (rỗng nếu không có / cú pháp không hỗ trợ). */
export function jsonPathValues(root: unknown, path: string): unknown[] {
  const steps = parsePath(path)
  return steps ? walk([root], steps) : []
}

/** Giá trị đơn giản → chuỗi; đối tượng / mảng → JSON gọn. */
function text(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

/** Nội dung ô của một cột cho đối tượng `o` (như `kubectl get`: nhiều giá trị nối bằng dấu phẩy). */
export function printerCell(o: unknown, col: PrinterColumn, now = Date.now()): string {
  const values = jsonPathValues(o, col.jsonPath)
  if (col.type === 'date') {
    const t = Date.parse(text(values[0]))
    return Number.isFinite(t) ? age(t, now) : ''
  }
  return values.map(text).join(',')
}

/** Cột nên hiện: bỏ Name / Age (bảng đã có) và cột ưu tiên > 0 (chỉ hiện ở `-o wide`). */
export function usablePrinterColumns(
  raw: readonly { name?: unknown; type?: unknown; jsonPath?: unknown; priority?: unknown }[]
): PrinterColumn[] {
  const out: PrinterColumn[] = []
  for (const c of raw) {
    if (typeof c.name !== 'string' || typeof c.jsonPath !== 'string') continue
    if (typeof c.priority === 'number' && c.priority > 0) continue
    if (c.jsonPath === '.metadata.name' || c.jsonPath === '.metadata.creationTimestamp') continue
    if (parsePath(c.jsonPath) === null) continue
    out.push({
      id: `pc${String(out.length)}`,
      label: c.name.slice(0, 40),
      type: typeof c.type === 'string' ? c.type : 'string',
      jsonPath: c.jsonPath.slice(0, 500)
    })
    if (out.length >= 12) break
  }
  return out
}

const STATUS_LABEL =
  /^(status|ready|phase|health|healthy|state|sync|synced|available|approved|valid)$/i
const GOOD =
  /^(true|ready|healthy|synced|running|active|available|bound|succeeded|complete|completed|approved|valid|up|ok)$/i
const BAD =
  /^(false|failed|failure|error|degraded|missing|lost|denied|invalid|unhealthy|down|crashloopbackoff)$/i
const WARN =
  /^(pending|progressing|unknown|suspended|outofsync|terminating|provisioning|creating|updating)$/i

/** Màu cho ô trạng thái (cột tên Status / Ready / Phase / Health…); cột khác → null (chữ thường). */
export function printerTone(label: string, value: string): 'ok' | 'warn' | 'bad' | null {
  if (!value || !STATUS_LABEL.test(label.trim())) return null
  const v = value.trim()
  if (GOOD.test(v)) return 'ok'
  if (BAD.test(v)) return 'bad'
  if (WARN.test(v)) return 'warn'
  return null
}
