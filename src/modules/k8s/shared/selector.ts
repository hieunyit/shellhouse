/**
 * Label selector kiểu `kubectl -l` trong ô lọc (thiết kế v0.7): `app=web`, `tier!=data`,
 * `app in (web,api)`, `app notin (…)`, `canary`, `!canary`, nối bằng dấu phẩy. Chữ thường (không có
 * toán tử) vẫn là tìm kiếm theo tên; tiền tố `-l ` ép hiểu là selector (cả `canary` đứng một mình).
 */
export type Requirement =
  | { key: string; op: '=' | '!='; value: string }
  | { key: string; op: 'in' | 'notin'; values: string[] }
  | { key: string; op: 'exists' | '!exists' }

export type SelectorParse =
  { ok: true; requirements: Requirement[]; text: string } | { ok: false; error: string }

const KEY = /^(?:[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/
const VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/

/** Có giống selector không (để chọn giữa lọc theo nhãn và tìm theo chữ). */
export function looksLikeSelector(text: string): boolean {
  const s = text.trim()
  if (/^-l\s/.test(s)) return true
  return /[=!]=?|\s(not)?in\s*\(/.test(s) || /^!\S/.test(s)
}

/** Tách theo dấu phẩy nằm ngoài ngoặc. */
function splitTop(text: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth < 0) return null
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  if (depth !== 0) return null
  parts.push(current)
  return parts.map((p) => p.trim())
}

function checkKey(key: string): string | null {
  return KEY.test(key) ? null : `“${key}” is not a valid label key`
}

function checkValue(value: string): string | null {
  return value.length <= 63 && VALUE.test(value) ? null : `“${value}” is not a valid label value`
}

/** Đọc selector; lỗi kèm thông báo cụ thể (tiếng Anh — giao diện dịch khi hiển thị). */
export function parseSelector(raw: string): SelectorParse {
  const text = raw.trim().replace(/^-l\s+/, '')
  if (!text) return { ok: false, error: 'Type a label selector, like app=web' }
  const parts = splitTop(text)
  if (!parts) return { ok: false, error: 'Unbalanced parentheses' }
  const requirements: Requirement[] = []
  for (const part of parts) {
    if (!part) return { ok: false, error: 'Empty requirement (two commas in a row?)' }
    let m = /^(\S+?)\s+(in|notin)\s*\((.*)\)$/.exec(part)
    if (m) {
      const [, key = '', op, list = ''] = m
      const values = list
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== '')
      const bad = checkKey(key) ?? values.map(checkValue).find((e) => e !== null) ?? null
      if (bad) return { ok: false, error: bad }
      if (values.length === 0) return { ok: false, error: `“${key} ${op ?? ''}” needs values` }
      requirements.push({ key, op: op === 'in' ? 'in' : 'notin', values })
      continue
    }
    m = /^([^=!\s]+)\s*(==|=|!=)\s*(\S*)$/.exec(part)
    if (m) {
      const [, key = '', op, value = ''] = m
      const bad = checkKey(key) ?? checkValue(value)
      if (bad) return { ok: false, error: bad }
      requirements.push({ key, op: op === '!=' ? '!=' : '=', value })
      continue
    }
    m = /^(!?)(\S+)$/.exec(part)
    if (m) {
      const [, not, key = ''] = m
      const bad = checkKey(key)
      if (bad) return { ok: false, error: bad }
      requirements.push({ key, op: not ? '!exists' : 'exists' })
      continue
    }
    return { ok: false, error: `Can’t read “${part}”` }
  }
  return { ok: true, requirements, text: selectorText(requirements) }
}

/** Selector chuẩn hoá cho kubectl -l. */
export function selectorText(requirements: readonly Requirement[]): string {
  return requirements
    .map((r) => {
      switch (r.op) {
        case '=':
        case '!=':
          return `${r.key}${r.op}${r.value}`
        case 'in':
        case 'notin':
          return `${r.key} ${r.op} (${r.values.join(',')})`
        case 'exists':
          return r.key
        case '!exists':
          return `!${r.key}`
      }
    })
    .join(',')
}

export function matchesSelector(
  labels: Readonly<Record<string, string>> | undefined,
  requirements: readonly Requirement[]
): boolean {
  const l = labels ?? {}
  return requirements.every((r) => {
    const has = Object.prototype.hasOwnProperty.call(l, r.key)
    const v = l[r.key]
    switch (r.op) {
      case '=':
        return has && v === r.value
      case '!=':
        return !has || v !== r.value
      case 'in':
        return has && r.values.includes(v ?? '')
      case 'notin':
        return !has || !r.values.includes(v ?? '')
      case 'exists':
        return has
      case '!exists':
        return !has
    }
  })
}
