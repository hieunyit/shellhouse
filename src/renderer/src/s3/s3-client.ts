import type { S3Op } from '@shared/s3'
import type { TransferStatus } from '@shared/sftp'
import { isServerMessage, type ClientMessage } from '@shared/stream-protocol'
import { openSession } from '../lib/sessions'

/** Đầu renderer của một phiên S3 (MessagePort tới Session Host): gửi thao tác, nhận kết quả. */
export class S3SessionClient {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  private constructor(
    private readonly sessionId: string,
    private readonly port: MessagePort,
    onTransfers: (list: TransferStatus[]) => void
  ) {
    port.onmessage = (event: MessageEvent<unknown>) => {
      const m = event.data
      if (!isServerMessage(m)) return
      if (m.t === 'transfers') onTransfers(m.list)
      else if (m.t === 's3-result') {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (!p) return
        if (m.ok) p.resolve(m.result)
        else p.reject(new Error(m.error))
      }
    }
    port.start()
  }

  static async open(
    accountId: string,
    onTransfers: (list: TransferStatus[]) => void
  ): Promise<S3SessionClient> {
    const { sessionId, port } = await openSession({ kind: 's3', cols: 80, rows: 24, accountId })
    return new S3SessionClient(sessionId, port, onTransfers)
  }

  request(op: S3Op): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The S3 tab is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const message: ClientMessage = { t: 's3', id, op }
      this.port.postMessage(message)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(new Error('The S3 tab is closed'))
    this.pending.clear()
    this.port.onmessage = null
    this.port.close()
    void window.shellhouse.closeSession(this.sessionId).catch(() => undefined)
  }
}
