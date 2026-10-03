import type { Extension } from '@codemirror/state'
import { parseAllDocuments } from 'yaml'
import { t } from '../../registry/renderer-kit'

/**
 * Hỗ trợ YAML cho editor CodeMirror của tab cluster: tô màu + báo lỗi ngay trong dòng (cú pháp YAML,
 * thiếu apiVersion / kind / metadata.name). Nạp lười cùng editor — không vào bundle khởi động.
 */

export interface YamlProblem {
  from: number
  to: number
  severity: 'error' | 'warning'
  message: string
}

/** Lỗi / cảnh báo của văn bản YAML Kubernetes (vị trí theo ký tự). */
export function yamlProblems(text: string, requireObject = true): YamlProblem[] {
  const out: YamlProblem[] = []
  let docs
  try {
    docs = parseAllDocuments(text)
  } catch (error) {
    return [
      {
        from: 0,
        to: Math.min(text.length, 1),
        severity: 'error',
        message: error instanceof Error ? error.message : String(error)
      }
    ]
  }
  const list = Array.isArray(docs) ? docs : [docs]
  for (const doc of list) {
    for (const e of doc.errors)
      out.push({
        from: e.pos[0],
        to: Math.max(e.pos[1], e.pos[0] + 1),
        severity: 'error',
        message: e.message.split('\n')[0] ?? e.message
      })
    for (const w of doc.warnings)
      out.push({
        from: w.pos[0],
        to: Math.max(w.pos[1], w.pos[0] + 1),
        severity: 'warning',
        message: w.message.split('\n')[0] ?? w.message
      })
    if (!requireObject || doc.errors.length || doc.contents === null) continue
    const value = doc.toJS() as unknown
    const range = doc.contents.range
    const at = { from: range[0], to: Math.max(range[0] + 1, Math.min(range[1], range[0] + 40)) }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      out.push({ ...at, severity: 'error', message: t('A Kubernetes object must be a mapping') })
      continue
    }
    const o = value as { apiVersion?: unknown; kind?: unknown; metadata?: { name?: unknown } }
    const missing = [
      !o.apiVersion && 'apiVersion',
      !o.kind && 'kind',
      !o.metadata?.name && 'metadata.name'
    ].filter((x): x is string => typeof x === 'string')
    if (missing.length)
      out.push({
        ...at,
        severity: 'warning',
        message: t('Missing {fields}', { fields: missing.join(', ') })
      })
  }
  return out.map((p) => ({
    ...p,
    from: Math.min(p.from, text.length),
    to: Math.min(Math.max(p.to, p.from), text.length)
  }))
}

/** yaml() + lint (gõ xong 300 ms mới kiểm). */
export async function loadYamlSupport(requireObject = true): Promise<Extension> {
  const [{ yaml }, { linter, lintGutter }] = await Promise.all([
    import('@codemirror/lang-yaml'),
    import('@codemirror/lint')
  ])
  return [
    yaml(),
    lintGutter(),
    linter((view) => yamlProblems(view.state.doc.toString(), requireObject), { delay: 300 })
  ]
}
