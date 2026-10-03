import { t } from '@shared/i18n'
import type { ActivePrompt } from '../terminal/controller'
import { SessionClient } from '../terminal/session-client'
import { openSession } from '../lib/sessions'

export interface SshTunnelEvents {
  status(detail: string): void
  /** Prompt SSH đầu hàng đợi (host key, mật khẩu…); null = không còn. */
  prompt(prompt: ActivePrompt | null): void
  /** Kết nối SSH mất sau khi đã sẵn sàng. */
  lost(reason: string): void
}

/**
 * Kết nối SSH (không shell) tới SSH host trung gian. Proxy RDP trong Session Host mở kênh
 * direct-tcpip trên chính kết nối này — không mở cổng local nào. Dùng đúng cơ chế của tab terminal:
 * host key, mật khẩu, jump host, thông tin trong vault.
 */
export class SshTunnel {
  private client: SessionClient | null = null
  private queue: ActivePrompt[] = []
  private ready = false
  private closed = false
  private cancel: ((error: Error) => void) | null = null

  constructor(private readonly events: SshTunnelEvents) {}

  /** Mở kết nối; trả id phiên SSH khi đã xác thực. */
  async open(viaHostId: string): Promise<string> {
    const { sessionId, port } = await openSession({
      kind: 'host',
      hostId: viaHostId,
      noShell: true,
      cols: 80,
      rows: 24
    })
    if (this.closed) {
      port.close()
      void window.shellhouse.closeSession(sessionId).catch(() => undefined)
      throw new Error(t('Cancelled'))
    }
    return new Promise<string>((resolve, reject) => {
      let lastError: string | null = null
      const settle = (error: Error | null): void => {
        if (this.ready || !this.cancel) return
        this.cancel = null
        if (error) {
          this.close()
          reject(error)
          return
        }
        this.ready = true
        resolve(sessionId)
      }
      this.cancel = (error) => {
        settle(error)
      }
      const update = (): void => {
        this.events.prompt(this.queue[0] ?? null)
      }
      this.client = new SessionClient(sessionId, port, {
        write: (_data, done) => {
          done()
        },
        exit: () => {
          const reason = lastError ?? t('The SSH connection closed')
          if (this.ready) this.lost(reason)
          else settle(new Error(reason))
        },
        error: (message) => {
          lastError = message
        },
        status: (phase, detail) => {
          this.events.status(detail)
          if (phase === 'connected') settle(null)
        },
        prompt: (id, request) => {
          this.queue.push({ id, request })
          update()
        },
        promptCancelled: (id) => {
          this.queue = this.queue.filter((p) => p.id !== id)
          update()
        },
        forwards: () => undefined,
        transfers: () => undefined,
        stats: () => undefined
      })
    })
  }

  answer(id: number, ok: boolean, answers: string[]): void {
    this.client?.reply(id, ok, answers)
    this.queue = this.queue.filter((p) => p.id !== id)
    this.events.prompt(this.queue[0] ?? null)
  }

  private lost(reason: string): void {
    if (this.closed) return
    this.close()
    this.events.lost(reason)
  }

  get isOpen(): boolean {
    return this.ready && !this.closed
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue = []
    this.events.prompt(null)
    this.client?.close()
    this.client = null
    this.cancel?.(new Error(t('Cancelled')))
  }
}
