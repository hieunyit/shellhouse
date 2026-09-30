import type { ServerMessage } from '@shared/stream-protocol'
import type { SessionPort } from '../../src/session-host/session/session'

/** MessagePort giả: ghi lại tin gửi ra, cho test bơm tin vào. */
export class FakePort implements SessionPort {
  readonly sent: ServerMessage[] = []
  private listener: ((data: unknown) => void) | null = null
  private closeListener: (() => void) | null = null
  private waiters: (() => void)[] = []

  postMessage(message: ServerMessage): void {
    this.sent.push(message)
    for (const w of this.waiters.splice(0)) w()
  }
  onMessage(listener: (data: unknown) => void): void {
    this.listener = listener
  }
  onClose(listener: () => void): void {
    this.closeListener = listener
  }
  start(): void {}
  close(): void {
    this.closeListener?.()
  }
  deliver(message: unknown): void {
    this.listener?.(message)
  }
  text(): string {
    return this.sent
      .filter((m): m is Extract<ServerMessage, { t: 'data' }> => m.t === 'data')
      .map((m) => Buffer.from(m.d).toString('utf8'))
      .join('')
  }
  async until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`Hết thời gian chờ; đã nhận: ${JSON.stringify(this.sent.map((m) => m.t))}`)
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 50)
      })
    }
  }
}
