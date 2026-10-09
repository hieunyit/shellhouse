import { z } from 'zod'
import { t } from '@shared/i18n'
import { renderSnippet, snippetVariables, type SnippetVariable } from '@shared/snippets'

/**
 * Runbook (ADR-016): danh sách bước kiểm tra có điều kiện đạt, chạy tuần tự, mỗi bước có đích riêng.
 * Loại bước dựng sẵn: `http`, `command` (qua SSH). Module khác đóng góp loại bước của mình
 * (`k8s.rollout`, `docker.container`) qua registry.
 */

/** `http`, `command` hoặc `<module>.<khoá>`. */
export const StepType = z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)?$/, 'Invalid step type')

export const RunbookStep = z.object({
  id: z.string().min(1).max(64),
  /** Tên người dùng đặt; trống thì hiện mô tả của bước. */
  name: z.string().trim().max(120),
  type: StepType,
  /** Tham số theo loại bước — kiểm bằng schema của loại đó lúc sửa / chạy. */
  params: z.unknown(),
  timeoutSec: z.number().int().min(1).max(3600),
  /** Bước lỗi vẫn chạy tiếp các bước sau (mặc định dừng). */
  continueOnFail: z.boolean()
})
export type RunbookStep = z.infer<typeof RunbookStep>

export const MAX_STEPS = 50

/** Tham số của tab Runbook: id = runbook đã lưu; không có = đang soạn runbook mới. */
export const RunbookTabParams = z.object({ id: z.string().min(1).max(64).optional() })
export type RunbookTabParams = z.infer<typeof RunbookTabParams>

export const RunbookInput = z.object({
  /** Có = sửa. */
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1, 'A name is required').max(100),
  description: z.string().max(500),
  steps: z.array(RunbookStep).max(MAX_STEPS)
})
export type RunbookInput = z.infer<typeof RunbookInput>

export interface Runbook {
  id: string
  name: string
  description: string
  steps: RunbookStep[]
  updatedAt: number
}

export const RunbookIpc = {
  list: z.tuple([]),
  save: z.tuple([RunbookInput]),
  remove: z.tuple([z.string().min(1).max(64)]),
  /** Lưu giá trị bí mật (mã hoá) → id. */
  putSecret: z.tuple([z.string().min(1).max(4000)]),
  /** Chọn file runbook (.json) → nội dung đã kiểm. */
  pickImport: z.tuple([])
} as const

// ——— Tham số của loại bước dựng sẵn ———

export const HTTP_METHODS = ['GET', 'HEAD', 'POST'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

/** Tên header hợp lệ (token theo RFC 9110). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export const HttpHeader = z
  .object({
    name: z.string().trim().min(1).max(200).regex(HEADER_NAME, 'Invalid header name'),
    /** Giá trị thường — được thay biến {{x}}. Trống khi là bí mật. */
    value: z.string().max(4000),
    /** Giá trị là bí mật (token, mật khẩu): lưu mã hoá trong vault, không hiện / xuất ra. */
    secret: z.boolean().default(false),
    /** Id giá trị bí mật trong vault (bảng `runbook_secrets`) — giá trị không về renderer. */
    secretId: z.string().min(1).max(64).optional()
  })
  .refine((h) => !h.secret || h.secretId !== undefined, {
    message: 'Enter the secret value',
    path: ['secretId']
  })
export type HttpHeader = z.infer<typeof HttpHeader>

export const MAX_HEADERS = 20
/** Thân của POST (đủ cho một payload kiểm tra, không phải upload). */
export const HTTP_BODY_MAX = 64 * 1024

export const HttpParams = z.object({
  /** GET mặc định; HEAD (không tải thân); POST (endpoint kiểm tra cần thân). */
  method: z.enum(HTTP_METHODS).default('GET'),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    // Biến {{x}} được thay trước khi chạy, nên chỉ kiểm dạng sau khi thay.
    .regex(/^https?:\/\//i, 'Starts with http:// or https://'),
  headers: z.array(HttpHeader).max(MAX_HEADERS).default([]),
  /** Chỉ dùng với POST. */
  body: z.string().max(HTTP_BODY_MAX).default(''),
  /** Mã trạng thái chấp nhận (mặc định 200). */
  expectStatus: z.array(z.number().int().min(100).max(599)).min(1).max(20),
  /** Thân phản hồi phải chứa chuỗi này (tuỳ chọn). */
  contains: z.string().max(500),
  /** Không kiểm chứng chỉ TLS (server nội bộ tự ký) — như "Skip certificate verification" của K8s / S3. */
  insecureTls: z.boolean().default(false)
})
export type HttpParams = z.infer<typeof HttpParams>

export const CommandParams = z.object({
  /** Host SSH đã lưu. */
  hostId: z.string().min(1).max(64),
  /** Văn bản chạy bằng `sh -c` trên server. */
  command: z.string().trim().min(1).max(8192),
  /** Đầu ra chuẩn phải chứa chuỗi này (tuỳ chọn). */
  contains: z.string().max(500)
})
export type CommandParams = z.infer<typeof CommandParams>

export const defaultHttp = (): HttpParams => ({
  method: 'GET',
  url: '',
  headers: [],
  body: '',
  expectStatus: [200],
  contains: '',
  insecureTls: false
})
export const defaultCommand = (): CommandParams => ({ hostId: '', command: '', contains: '' })

// ——— Việc Session Host làm cho renderer ———

export const RunbookOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('exec'),
    command: z.string().min(1).max(8192),
    timeoutSec: z.number().int().min(1).max(3600)
  }),
  z.object({
    op: z.literal('http'),
    method: z.enum(HTTP_METHODS).default('GET'),
    url: z.string().min(1).max(2048),
    /** `secretId` → main giải mã vào cấu hình phiên; Session Host thay vào lúc gửi. */
    headers: z
      .array(
        z.object({
          name: z.string().min(1).max(200).regex(HEADER_NAME),
          value: z.string().max(4000),
          secretId: z.string().min(1).max(64).optional()
        })
      )
      .max(MAX_HEADERS)
      .default([]),
    body: z.string().max(HTTP_BODY_MAX).default(''),
    insecureTls: z.boolean().default(false),
    timeoutSec: z.number().int().min(1).max(3600)
  })
])

/**
 * Tham số phiên `local` (renderer → main): main tính proxy cho địa chỉ (Settings › Network) và giải
 * mã các bí mật được nhắc tới — kết quả chỉ đi sang Session Host, không về renderer.
 */
export const RunbookLocalParams = z.object({
  url: z.string().max(2048).optional(),
  secretIds: z.array(z.string().min(1).max(64)).max(MAX_HEADERS).default([])
})
export type RunbookLocalParams = z.infer<typeof RunbookLocalParams>

/** Cấu hình phiên `local` do main phân giải (xem `RunbookLocalParams`). */
export const RunbookSessionConfig = z.object({
  proxy: z.string().nullable().default(null),
  secrets: z.record(z.string(), z.string()).default({})
})
export type RunbookSessionConfig = z.infer<typeof RunbookSessionConfig>
export type RunbookOp = z.infer<typeof RunbookOp>

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface HttpResult {
  status: number | null
  /** Tối đa HTTP_BODY_LIMIT byte đầu của thân. */
  body: string
  /** Lỗi mạng / TLS / hết giờ — không có thì có `status`. */
  error?: string
}

/** Chỉ đọc chừng này của thân phản hồi (đủ để tìm một chuỗi, không kéo cả tệp lớn). */
export const HTTP_BODY_LIMIT = 64 * 1024

// ——— Kết quả ———

export type StepStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skipped' | 'blocked'

export interface StepResult {
  stepId: string
  status: StepStatus
  detail: string
  /** Vài dòng cuối đầu ra, đã che giá trị giống bí mật. */
  output?: string
  durationMs?: number
}

export interface StepEval {
  ok: boolean
  detail: string
  output?: string
}

/**
 * Tên kiểu bí mật (kể cả khi dính liền `DB_PASSWORD`, `API_KEY_ID`, hay là khoá JSON
 * `"access_token"`) + dấu `=` / `:` + giá trị.
 */
const SECRET_KEY =
  /(?<![A-Za-z0-9])(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)([A-Za-z0-9_-]*["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|\S+)/gi

/**
 * Che giá trị đứng sau tên kiểu bí mật (`password=…`, `DB_TOKEN: …`), cả dòng `Authorization: …`, và
 * mật khẩu trong chuỗi kết nối (`scheme://user:pass@host`). Đầu ra của runbook được hiện và lưu
 * lịch sử, nên không để lọt giá trị nhạy cảm vô ý in ra. Chỉ che khi có dấu `=` / `:` — chữ thường
 * như "pass 3 tests" giữ nguyên.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*)[^\n]*/gi, '$1••••')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1••••@')
    .replace(SECRET_KEY, (_m, key: string, sep: string, value: string) => {
      // Giá trị trong ngoặc (JSON) giữ ngoặc để đầu ra vẫn đọc được.
      const q = value[0] === '"' || value[0] === "'" ? value[0] : ''
      return `${key}${sep}${q}••••${q}`
    })
}

const OUTPUT_LINES = 20
const OUTPUT_CHARS = 4000

/** Vài dòng cuối của đầu ra, đã che bí mật và cắt độ dài. */
export function tailOutput(text: string): string {
  const lines = maskSecrets(text).replace(/\r/g, '').trimEnd().split('\n')
  const tail = lines.slice(-OUTPUT_LINES).join('\n')
  return tail.length > OUTPUT_CHARS ? `…${tail.slice(tail.length - OUTPUT_CHARS)}` : tail
}

export function evalHttp(p: HttpParams, r: HttpResult): StepEval {
  if (r.error !== undefined || r.status === null)
    return { ok: false, detail: r.error ?? t('No response') }
  if (!p.expectStatus.includes(r.status))
    return {
      ok: false,
      detail: t('HTTP {status} (expected {expected})', {
        status: r.status,
        expected: p.expectStatus.join(' / ')
      }),
      ...(r.body ? { output: tailOutput(r.body) } : {})
    }
  if (p.contains !== '' && !r.body.includes(p.contains))
    return {
      ok: false,
      detail: t('HTTP {status}, but the response does not contain “{text}”', {
        status: r.status,
        text: p.contains
      }),
      ...(r.body ? { output: tailOutput(r.body) } : {})
    }
  return { ok: true, detail: `HTTP ${String(r.status)}` }
}

export function evalCommand(p: CommandParams, r: ExecResult, timeoutSec: number): StepEval {
  const output = tailOutput([r.stdout, r.stderr].filter(Boolean).join('\n'))
  const withOutput = output ? { output } : {}
  if (r.timedOut)
    return {
      ok: false,
      detail: t('Did not finish within {n} s', { n: timeoutSec }),
      ...withOutput
    }
  if (r.code !== 0)
    return {
      ok: false,
      detail: t('Exit code {code}', { code: r.code === null ? '?' : r.code }),
      ...withOutput
    }
  if (p.contains !== '' && !r.stdout.includes(p.contains))
    return {
      ok: false,
      detail: t('Exit code 0, but the output does not contain “{text}”', { text: p.contains }),
      ...withOutput
    }
  return { ok: true, detail: t('Exit code 0'), ...withOutput }
}

// ——— Biến {{tên}} (cùng cú pháp với snippet) ———

/** Chạy `visit` trên mọi chuỗi trong giá trị JSON (trả bản đã biến đổi). */
function mapStrings(value: unknown, visit: (s: string) => string): unknown {
  if (typeof value === 'string') return visit(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, visit))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapStrings(v, visit)])
    )
  return value
}

/** Biến của cả runbook theo thứ tự xuất hiện (tên / tham số của mọi bước). */
export function runbookVariables(steps: readonly RunbookStep[]): SnippetVariable[] {
  const found = new Map<string, SnippetVariable>()
  for (const step of steps)
    mapStrings(step.params, (s) => {
      for (const v of snippetVariables(s)) {
        const have = found.get(v.name)
        if (!have) found.set(v.name, v)
        else if (have.defaultValue === null && v.defaultValue !== null)
          have.defaultValue = v.defaultValue
      }
      return s
    })
  return [...found.values()]
}

/** Thay biến trong tham số của một bước (thiếu giá trị bắt buộc → lỗi, như snippet). */
export function renderParams(params: unknown, values: Readonly<Record<string, string>>): unknown {
  return mapStrings(params, (s) => renderSnippet(s, values))
}

/** Mô tả một dòng của bước dựng sẵn. */
export function builtinSummary(type: string, params: unknown): string {
  if (type === 'http') {
    const p = HttpParams.safeParse(params)
    return p.success ? `${p.data.method} ${p.data.url}` : t('HTTP (incomplete)')
  }
  if (type === 'command') {
    const p = CommandParams.safeParse(params)
    return p.success ? (p.data.command.split('\n')[0] ?? '') : t('Command (incomplete)')
  }
  return type
}

/** Id bước mới (ngắn, không trùng trong một runbook). */
export function newStepId(taken: ReadonlySet<string>): string {
  for (let i = 1; ; i++) if (!taken.has(`s${String(i)}`)) return `s${String(i)}`
}

export const DEFAULT_TIMEOUT_SEC = 30

/**
 * Tham số của bước với biến {{x}} được thay bằng mặc định (hoặc "x") — để kiểm "đủ chưa" khi soạn,
 * không bắt người dùng nhập giá trị thật của biến trước khi chạy.
 */
export function previewParams(params: unknown): unknown {
  return mapStrings(params, (s) =>
    s.replace(
      /\{\{\s*[A-Za-z_][\w.-]*\s*(?::([^}]*))?\}\}/g,
      (_m, def: string | undefined) => def ?? 'x'
    )
  )
}

// ——— Xuất / nhập (chia sẻ với đồng đội qua file) ———

export const RUNBOOK_FILE_FORMAT = 'shellhouse-runbooks'
export const MAX_IMPORT = 500

const HostRef = z.object({ label: z.string().max(200), address: z.string().max(300) })
export type HostRef = z.infer<typeof HostRef>

export const RunbookFile = z.object({
  format: z.literal(RUNBOOK_FILE_FORMAT),
  version: z.literal(1),
  /**
   * Host SSH mà các bước nhắc tới: id trên máy xuất → nhãn / địa chỉ, để máy nhập tìm host của
   * mình (id host khác nhau giữa các máy).
   */
  hosts: z.record(z.string().max(64), HostRef).default({}),
  runbooks: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(500).default(''),
        steps: z.array(RunbookStep).max(MAX_STEPS)
      })
    )
    .min(1)
    .max(MAX_IMPORT)
})
export type RunbookFile = z.infer<typeof RunbookFile>

/** Bỏ mọi `secretId` (bí mật ở lại vault của máy này; bước báo "nhập giá trị bí mật" khi nhập). */
export function stripSecretRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretRefs)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== 'secretId')
        .map(([k, v]) => [k, stripSecretRefs(v)])
    )
  return value
}

/** Dữ liệu file xuất: không bí mật; kèm nhãn / địa chỉ của host được nhắc tới. */
export function exportRunbooks(
  runbooks: readonly Pick<Runbook, 'name' | 'description' | 'steps'>[],
  hostOf: (id: string) => HostRef | undefined
): RunbookFile {
  const hosts: Record<string, HostRef> = {}
  const steps = (list: readonly RunbookStep[]): RunbookStep[] =>
    list.map((step) => ({
      ...step,
      params: mapStrings(stripSecretRefs(step.params), (v) => {
        const host = hostOf(v)
        if (host) hosts[v] = host
        return v
      })
    }))
  return {
    format: RUNBOOK_FILE_FORMAT,
    version: 1,
    hosts,
    runbooks: runbooks.map((r) => ({
      name: r.name,
      description: r.description,
      steps: steps(r.steps)
    }))
  }
}

/**
 * Đổi id host của máy xuất sang host tương ứng ở máy này: cùng nhãn và địa chỉ, rồi cùng địa chỉ,
 * rồi cùng nhãn. Không tìm thấy → giữ id cũ (bước báo chọn server) và trả tên để báo người dùng.
 */
export function remapHosts(
  steps: readonly RunbookStep[],
  fileHosts: Readonly<Record<string, HostRef>>,
  local: readonly (HostRef & { id: string })[]
): { steps: RunbookStep[]; missing: string[] } {
  const missing = new Set<string>()
  const match = (ref: HostRef): string | undefined =>
    (
      local.find((h) => h.label === ref.label && h.address === ref.address) ??
      local.find((h) => h.address === ref.address) ??
      local.find((h) => h.label === ref.label)
    )?.id
  const out = steps.map((step) => ({
    ...step,
    params: mapStrings(step.params, (v) => {
      const ref = fileHosts[v]
      if (!ref) return v
      const id = match(ref)
      if (id) return id
      missing.add(`${ref.label} (${ref.address})`)
      return v
    })
  }))
  return { steps: out, missing: [...missing] }
}

/** Tên chưa dùng (không phân biệt hoa thường): "X", "X (2)", "X (3)"… — tối đa 100 ký tự. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()))
  const base = name.trim().slice(0, 100)
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const suffix = ` (${String(i)})`
    const candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}
