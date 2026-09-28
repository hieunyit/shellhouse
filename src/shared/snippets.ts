import { z } from 'zod'

export const SnippetSummary = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.number()
})
export type SnippetSummary = z.infer<typeof SnippetSummary>

export const SnippetInput = z.object({
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1, 'A name is required').max(100),
  body: z
    .string()
    .min(1, 'The snippet is empty')
    .max(64 * 1024),
  tags: z.array(z.string().trim().min(1).max(40)).max(20)
})
export type SnippetInput = z.infer<typeof SnippetInput>

export interface SnippetVariable {
  name: string
  defaultValue: string | null
}

// {{name}} hoặc {{name:giá trị mặc định}}; tên gồm chữ, số, _, -, .
const VARIABLE = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?::([^}]*))?\}\}/g

/** Các biến theo thứ tự xuất hiện đầu tiên; mặc định lấy ở lần đầu có ghi. */
export function snippetVariables(body: string): SnippetVariable[] {
  const found = new Map<string, SnippetVariable>()
  for (const match of body.matchAll(VARIABLE)) {
    const name = match[1] ?? ''
    const defaultValue = match[2] ?? null
    const existing = found.get(name)
    if (!existing) found.set(name, { name, defaultValue })
    else if (existing.defaultValue === null && defaultValue !== null)
      existing.defaultValue = defaultValue
  }
  return [...found.values()]
}

/** Thay biến. Biến không có giá trị → dùng mặc định → nếu vẫn thiếu thì báo lỗi. */
export function renderSnippet(body: string, values: Readonly<Record<string, string>>): string {
  const vars = snippetVariables(body)
  // Biến KHÔNG có mặc định là bắt buộc: rỗng → lỗi (tránh chạy lệnh thiếu tham số, ví dụ
  // `rm -rf /tmp/{{dir}}`). Muốn cho phép rỗng thì khai báo mặc định rỗng: `{{tên:}}`.
  // Chỉ đọc key của chính object (biến tên "constructor"/"toString" không lấy từ prototype).
  const valueOf = (name: string): string | undefined =>
    Object.hasOwn(values, name) ? values[name] : undefined
  const missing = vars.filter((v) => v.defaultValue === null && (valueOf(v.name) ?? '') === '')
  if (missing.length > 0)
    throw new Error(`Missing value for: ${missing.map((v) => v.name).join(', ')}`)
  return body.replace(VARIABLE, (_all, name: string) => {
    const v = vars.find((x) => x.name === name)
    return valueOf(name) ?? v?.defaultValue ?? ''
  })
}
