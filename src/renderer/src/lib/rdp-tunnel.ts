import { t } from '@shared/i18n'
import type { ForwardStatus } from '@shared/forwards'
import type { ActivePrompt } from '../terminal/controller'
import { SessionClient } from '../terminal/session-client'

export interface TunnelEvents {
  /** Tiến trình kết nối SSH ("Authenticating…"). */
  status(detail: string): void
  /** Prompt SSH đang chờ người dùng (mật khẩu, host key…); null = không có. */
  prompt(prompt: ActivePrompt | null): void
  /** Tunnel đã chạy rồi bị đóng (mất kết nối SSH, forward lỗi). */
  lost(reason: string): void
}

/** Id forward trong phiên SSH riêng của tunnel (mỗi tunnel một phiên nên không trùng). */
export const RDP_FORWARD_ID = 'rdp'

/**
 * Tunnel SSH cho Remote Desktop: mở một phiên SSH không có shell tới host trung gian (dùng đúng cơ
 * chế của tab terminal: host key, mật khẩu, jump host, vault), rồi forward
 * 127.0.0.1:<cổng ngẫu nhiên> → đích RDP. Đóng phiên = đóng tunnel.
 */
export class RdpTunnel {
  private client: SessionClient | null = null
  private queue: ActivePrompt[] = []
  private ready = false
  private closed = false
  private fail: ((error: Error) => void) | null = null

  constructor(private readonly events: TunnelEvents) {}

  /** Mở tunnel; trả về cổng local đang nghe. */
  async open(viaHostId: string, target: { host: string; port: number }): Promise<number> {
    // Nạp khi dùng: sessions.ts gắn listener vào window lúc nạp (store được test ngoài trình duyệt).
    const { openSession } = await import('./sessions')
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
    return new Promise<number>((resolve, reject) => {
      let lastError: string | null = null
      const settle = (error: Error | null, value?: number): void => {
        if (this.ready || this.fail === null) return
        this.fail = null
        if (error) {
          this.close()
          reject(error)
        } else {
          this.ready = true
          resolve(value ?? 0)
        }
      }
      this.fail = (error) => {
        settle(error)
      }
      const onForwards = (list: ForwardStatus[]): void => {
        const f = list.find((x) => x.spec.id === RDP_FORWARD_ID)
        if (!f) return
        if (!this.ready) {
          if (f.state === 'active' && f.actualPort) settle(null, f.actualPort)
          else if (f.state === 'error')
            settle(new Error(f.error ?? t('Could not open the SSH tunnel')))
          return
        }
        if (f.state === 'error' || f.state === 'stopped')
          this.lost(f.error ?? t('The SSH tunnel was closed'))
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
        status: (_phase, detail) => {
          this.events.status(detail)
        },
        prompt: (id, request) => {
          this.queue.push({ id, request })
          this.events.prompt(this.queue[0] ?? null)
        },
        promptCancelled: (id) => {
          this.queue = this.queue.filter((p) => p.id !== id)
          this.events.prompt(this.queue[0] ?? null)
        },
        forwards: onForwards,
        transfers: () => undefined,
        stats: () => undefined
      })
      // Session Host giữ forward chờ tới khi SSH kết nối xong.
      this.client.startForward({
        id: RDP_FORWARD_ID,
        kind: 'L',
        bindAddr: '127.0.0.1',
        bindPort: 0,
        destHost: target.host,
        destPort: target.port
      })
    })
  }

  /** Trả lời prompt SSH đang hiện (Esc / Cancel = ok false). */
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

  /** Đóng tunnel (và phiên SSH). Đang mở dở → `open()` báo huỷ. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue = []
    this.events.prompt(null)
    this.client?.close()
    this.client = null
    this.fail?.(new Error(t('Cancelled')))
  }
}
