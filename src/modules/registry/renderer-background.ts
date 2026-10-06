import { t } from '@shared/i18n'
import type { ModuleSessionClient, ModuleSessionTarget } from './renderer-kit'

/** Kết nối hỏng → thử lại sau chừng này. */
export const BACKGROUND_RETRY_MS = 5 * 60_000

export interface BackgroundSessionHandlers {
  /** Phiên đã sẵn sàng (một lần mỗi phiên). Lỗi ném ra → `failed('error', …)`. */
  ready(client: ModuleSessionClient): Promise<void>
  /** Phiên hỏng / cần đăng nhập — phiên đã đóng, tự thử lại sau BACKGROUND_RETRY_MS. */
  failed(state: 'error' | 'signin', message: string): void
}

type Open = (
  module: string,
  target: ModuleSessionTarget,
  events: Parameters<typeof ModuleSessionClient.open>[2]
) => Promise<ModuleSessionClient>

/**
 * Phiên module chạy nền (không tab, không ai trả lời prompt): mở, đợi sẵn sàng, không bao giờ hỏi
 * mật khẩu / host key (huỷ và báo "cần đăng nhập"), hỏng thì đóng và tự thử lại, Session Host khởi
 * động lại thì mở lại. Callback của phiên cũ (đã đóng) luôn bị bỏ qua.
 */
export class BackgroundSession {
  private session: ModuleSessionClient | null = null
  private gen = 0
  private transportReady = false
  private readied = false
  private stopped = false
  private timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(
    private readonly module: string,
    private readonly target: () => ModuleSessionTarget,
    private readonly handlers: BackgroundSessionHandlers,
    private readonly deps: { open: Open; whenHostRunning: () => Promise<void> }
  ) {}

  get client(): ModuleSessionClient | null {
    return this.session
  }

  /** Lần mở hiện tại — so sánh trước khi dùng kết quả của việc bất đồng bộ. */
  get generation(): number {
    return this.gen
  }

  start(): void {
    this.open()
  }

  /** Đóng phiên hiện tại và mở lại ngay (đổi đích, người dùng bấm làm mới sau lỗi). */
  restart(): void {
    if (this.stopped) return
    this.close()
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.close()
  }

  /** Hẹn giờ gắn với phiên hiện tại: phiên đóng / mở lại thì bị huỷ. */
  later(ms: number, run: () => void): void {
    const gen = this.gen
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.stopped && gen === this.gen) run()
    }, ms)
    this.timers.add(timer)
  }

  private close(): void {
    this.gen++
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.session?.close()
    this.session = null
    this.transportReady = false
    this.readied = false
  }

  private fail(state: 'error' | 'signin', message: string): void {
    if (this.stopped) return
    this.close()
    this.handlers.failed(state, friendlyError(message))
    this.later(BACKGROUND_RETRY_MS, () => {
      this.open()
    })
  }

  private open(): void {
    const gen = ++this.gen
    const live = (): boolean => !this.stopped && gen === this.gen
    const signin = t('Needs sign-in — open it once to connect.')
    void this.deps
      .open(this.module, this.target(), {
        onStatus: (phase) => {
          if (!live() || phase !== 'connected') return
          this.transportReady = true
          this.maybeReady()
        },
        onPrompt: (p) => {
          if (!p || !live()) return
          this.session?.answer(p.id, false, [])
          this.fail('signin', signin)
        },
        onError: (message) => {
          if (live()) this.fail('error', message)
        },
        onExit: (reason) => {
          if (!live()) return
          const auth = reason === 'auth' || reason === 'hostkey'
          this.fail(auth ? 'signin' : 'error', auth ? signin : t('The connection was closed.'))
        },
        onHostRestart: () => {
          if (!live()) return
          this.close()
          void this.deps.whenHostRunning().then(() => {
            if (!this.stopped) this.open()
          })
        }
      })
      .then(
        (client) => {
          if (!live()) {
            client.close()
            return
          }
          this.session = client
          this.maybeReady()
        },
        (e: unknown) => {
          if (live()) this.fail('error', e instanceof Error ? e.message : String(e))
        }
      )
  }

  /** Có client VÀ phiên báo connected (thứ tự hai việc không cố định) → ready một lần. */
  private maybeReady(): void {
    const client = this.session
    if (!client || !this.transportReady || this.readied) return
    this.readied = true
    const gen = this.gen
    this.handlers.ready(client).catch((e: unknown) => {
      if (!this.stopped && gen === this.gen)
        this.fail(isSignInError(e) ? 'signin' : 'error', e instanceof Error ? e.message : String(e))
    })
  }
}

/** Lỗi xác thực (token / plugin exec / OIDC hết hạn) — người dùng cần tự đăng nhập lại. */
export function isSignInError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return /sign in|log in|login|unauthori[sz]ed|credential|expired|\b401\b/i.test(message)
}

/** Lỗi mạng thô của Node (connect ECONNREFUSED 10.0.0.1:6443) → câu dễ đọc; lỗi khác giữ nguyên. */
export function friendlyError(message: string): string {
  const address = /\b(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[a-z0-9.-]+\.[a-z]{2,}):\d+\b/i.exec(
    message
  )?.[0]
  const at = address ? ` (${address})` : ''
  if (/ECONNREFUSED/.test(message)) return t('Connection refused') + at
  if (/ETIMEDOUT|timed out/i.test(message)) return t('The server did not answer in time') + at
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return t('Server name not found') + at
  if (/EHOSTUNREACH|ENETUNREACH/.test(message)) return t('No route to the server') + at
  if (/ECONNRESET|socket hang up/i.test(message)) return t('The connection was reset') + at
  return message
}
