import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AnyAuthMethod,
  AuthenticationType,
  AuthHandlerMiddleware,
  NextAuthHandler,
  ParsedKey
} from 'ssh2'
import { utils } from 'ssh2'
import type { PromptReply, TransportContext } from '../transport/types'

export const MAX_PROMPT_ATTEMPTS = 3

/** Thông tin xác thực đã lưu (main giải mã từ vault và gửi sang khi mở session). */
export interface StoredCredentials {
  password?: string
  privateKey?: { data: string; passphrase?: string; label: string }
}

export interface AuthOptions {
  username: string
  host: string
  /** Đường dẫn agent: socket Unix, named pipe Windows, hoặc 'pageant'. null = không dùng. */
  agent: string | null
  keyFiles: readonly string[]
  credentials?: StoredCredentials
  ctx: Pick<TransportContext, 'prompt' | 'log'>
  readFile?: (path: string) => string
}

/** Đường dẫn agent mặc định của hệ thống. */
export function defaultAgent(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync
): string | null {
  if (platform === 'win32') {
    const openssh = '\\\\.\\pipe\\openssh-ssh-agent'
    return exists(openssh) ? openssh : 'pageant'
  }
  return env['SSH_AUTH_SOCK'] ?? null
}

/** Các file key mặc định như OpenSSH (chỉ những file tồn tại). */
export function defaultKeyFiles(
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync
): string[] {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa']
    .map((name) => join(home, '.ssh', name))
    .filter((p) => exists(p))
}

type ParseResult = { key: ParsedKey } | { encrypted: true } | { error: string }

function parse(data: string, passphrase?: string): ParseResult {
  const parsed: ParsedKey | Error = utils.parseKey(data, passphrase)
  if (parsed instanceof Error) {
    if (/passphrase|decrypt|encrypted/i.test(parsed.message)) return { encrypted: true }
    return { error: parsed.message }
  }
  return { key: parsed }
}

type Step = () => Promise<AnyAuthMethod | null>

/**
 * Chuỗi xác thực giống OpenSSH: none → agent → key đã lưu → key mặc định → password đã lưu
 * → keyboard-interactive → hỏi password. Mỗi bước chỉ chạy khi server còn cho phép loại đó,
 * nên xác thực nhiều bước (key + OTP, `partialSuccess`) chạy tự nhiên.
 */
export function createAuthHandler(options: AuthOptions): AuthHandlerMiddleware {
  const { username, ctx } = options
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  let allowed: AuthenticationType[] | null = null
  const can = (type: AuthenticationType): boolean => allowed === null || allowed.includes(type)

  const steps: { type: AuthenticationType; run: Step }[] = []
  let index = 0
  let triedNone = false
  /** Người dùng bấm Huỷ ở ô nhập password → dừng hẳn, không hỏi tiếp. */
  let cancelled = false

  if (options.agent) {
    const agent = options.agent
    steps.push({
      type: 'publickey',
      run: () => Promise.resolve({ type: 'agent', username, agent })
    })
  }

  const keyStep = (label: string, load: () => string, storedPassphrase?: string): Step => {
    return async () => {
      let data: string
      try {
        data = load()
      } catch (error) {
        ctx.log('warn', `Could not read ${label}: ${String(error)}`)
        return null
      }
      let result = parse(data, storedPassphrase)
      for (let attempt = 0; 'encrypted' in result && attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
        const reply = await ctx.prompt({ kind: 'passphrase', keyPath: label })
        const passphrase = reply.answers[0]
        if (!reply.ok || !passphrase) return null
        result = parse(data, passphrase)
      }
      if ('key' in result) return { type: 'publickey', username, key: result.key }
      if ('error' in result) ctx.log('warn', `Skipping ${label}: ${result.error}`)
      return null
    }
  }

  const stored = options.credentials?.privateKey
  if (stored) {
    steps.push({
      type: 'publickey',
      run: keyStep(stored.label, () => stored.data, stored.passphrase)
    })
  }
  for (const file of options.keyFiles) {
    steps.push({ type: 'publickey', run: keyStep(file, () => readFile(file)) })
  }

  const storedPassword = options.credentials?.password
  if (storedPassword) {
    steps.push({
      type: 'password',
      run: () => Promise.resolve({ type: 'password', username, password: storedPassword })
    })
  }

  for (let i = 0; i < MAX_PROMPT_ATTEMPTS; i++) {
    steps.push({
      type: 'keyboard-interactive',
      run: () =>
        Promise.resolve({
          type: 'keyboard-interactive',
          username,
          prompt: (name, instructions, _lang, prompts, finish) => {
            void ctx
              .prompt({
                kind: 'keyboard-interactive',
                name,
                instructions,
                fields: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo ?? false }))
              })
              .then((reply: PromptReply) => {
                // Huỷ → gửi câu trả lời rỗng để server từ chối và chuỗi đi tiếp/dừng.
                finish(reply.ok ? reply.answers : prompts.map(() => ''))
              })
          }
        })
    })
  }

  for (let i = 0; i < MAX_PROMPT_ATTEMPTS; i++) {
    steps.push({
      type: 'password',
      run: async () => {
        const reply = await ctx.prompt({ kind: 'password', username, host: options.host })
        const password = reply.answers[0]
        if (!reply.ok || password === undefined) {
          cancelled = true
          return null
        }
        return { type: 'password', username, password }
      }
    })
  }

  return (authsLeft, _partialSuccess, next: NextAuthHandler) => {
    // Lần gọi đầu authsLeft = null: thử 'none' để biết server cho phép những gì.
    if (!triedNone && !Array.isArray(authsLeft)) {
      triedNone = true
      next({ type: 'none', username })
      return
    }
    triedNone = true
    allowed = Array.isArray(authsLeft) ? authsLeft : null

    const advance = async (): Promise<void> => {
      while (index < steps.length && !cancelled) {
        const step = steps[index++]
        if (!step || !can(step.type)) continue
        const method = await step.run()
        if (method) {
          next(method)
          return
        }
      }
      // Hết cách: báo ssh2 dừng (kiểu của @types/ssh2 thiếu `false`).
      ;(next as unknown as (value: false) => void)(false)
    }
    void advance()
  }
}
