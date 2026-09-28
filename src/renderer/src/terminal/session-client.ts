import {
  isServerMessage,
  type ClientMessage,
  type ConnectionPhase,
  type ExitReason,
  type PromptRequest
} from '@shared/stream-protocol'
import type { ForwardSpec, ForwardStatus } from '@shared/forwards'
import type { SftpOp, TransferStatus } from '@shared/sftp'

export interface SessionClientHandlers {
  /** Ghi dữ liệu vào terminal; phải gọi `done` khi xterm đã xử lý xong (để ack). */
  write(data: Uint8Array, done: () => void): void
  exit(code: number | null, reason: ExitReason): void
  error(message: string): void
  status(phase: ConnectionPhase, detail: string): void
  prompt(id: number, request: PromptRequest): void
  promptCancelled(id: number): void
  forwards(list: ForwardStatus[]): void
  transfers(list: TransferStatus[]): void
}

/** Đầu renderer của một MessagePort session: nhận output + ack, gửi input/resize. */
export class SessionClient {
  private closed = false
  private nextSftpId = 1
  private readonly deployPending = new Map<
    number,
    (r: { status: 'added' | 'exists' | 'error'; message: string | null }) => void
  >()
  private readonly sftpPending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  constructor(
    readonly sessionId: string,
    private readonly port: MessagePort,
    handlers: SessionClientHandlers
  ) {
    port.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data
      if (!isServerMessage(message)) return
      switch (message.t) {
        case 'data': {
          const n = message.d.byteLength
          handlers.write(message.d, () => {
            this.send({ t: 'ack', n })
          })
          break
        }
        case 'exit':
          handlers.exit(message.code, message.reason)
          break
        case 'error':
          handlers.error(message.message)
          break
        case 'status':
          handlers.status(message.phase, message.detail)
          break
        case 'prompt':
          handlers.prompt(message.id, message.prompt)
          break
        case 'prompt-cancel':
          handlers.promptCancelled(message.id)
          break
        case 'forwards':
          handlers.forwards(message.list)
          break
        case 'transfers':
          handlers.transfers(message.list)
          break
        case 'deploy-key-result': {
          const pending = this.deployPending.get(message.id)
          this.deployPending.delete(message.id)
          pending?.({ status: message.status, message: message.message })
          break
        }
        case 'sftp-result': {
          const pending = this.sftpPending.get(message.id)
          this.sftpPending.delete(message.id)
          if (!pending) break
          if (message.ok) pending.resolve(message.result)
          else pending.reject(new Error(message.error))
          break
        }
      }
    }
    port.start()
  }

  input(data: string): void {
    this.send({ t: 'input', d: data })
  }

  /** Gửi một thao tác SFTP và chờ kết quả. */
  sftp(op: SftpOp): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The session is closed'))
    const id = this.nextSftpId++
    return new Promise((resolve, reject) => {
      this.sftpPending.set(id, { resolve, reject })
      this.send({ t: 'sftp', id, op })
    })
  }

  deployKey(
    publicKey: string
  ): Promise<{ status: 'added' | 'exists' | 'error'; message: string | null }> {
    if (this.closed) return Promise.resolve({ status: 'error', message: 'The session is closed' })
    const id = this.nextSftpId++
    return new Promise((resolve) => {
      this.deployPending.set(id, resolve)
      this.send({ t: 'deploy-key', id, publicKey })
    })
  }

  startForward(spec: ForwardSpec): void {
    this.send({ t: 'forward-start', spec })
  }

  stopForward(id: string): void {
    this.send({ t: 'forward-stop', id })
  }

  removeForward(id: string): void {
    this.send({ t: 'forward-remove', id })
  }

  reply(id: number, ok: boolean, answers: string[]): void {
    this.send({ t: 'prompt-reply', id, ok, answers })
  }

  resize(cols: number, rows: number): void {
    this.send({ t: 'resize', cols, rows })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.sftpPending.values()) p.reject(new Error('The session is closed'))
    this.sftpPending.clear()
    this.port.onmessage = null
    this.port.close()
    void window.shellhouse.closeSession(this.sessionId).catch(() => undefined)
  }

  private send(message: ClientMessage): void {
    if (!this.closed) this.port.postMessage(message)
  }
}
