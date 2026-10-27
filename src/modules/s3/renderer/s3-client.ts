import type { TransferStatus } from '@shared/sftp'
import { ModuleSessionClient } from '../../registry/renderer-kit'
import type { S3Op, S3TransferDelta } from '../shared/ops'
import { t } from '@shared/i18n'

/** Đầu renderer của một phiên S3 (phiên module `s3/browser`): gửi thao tác, nhận kết quả. */
export class S3SessionClient {
  /** Lượt "Cancel" gom trong cùng một tick → một op (Cancel all với hàng nghìn lượt). */
  private cancelIds: string[] = []

  private constructor(private readonly client: ModuleSessionClient) {}

  static async open(
    accountId: string,
    onTransfers: (list: TransferStatus[]) => void,
    onDisconnect: () => void = () => undefined
  ): Promise<S3SessionClient> {
    // Session Host chỉ gửi phần thay đổi; ghép lại thành danh sách đầy đủ (giữ thứ tự thêm vào).
    const transfers = new Map<string, TransferStatus>()
    let disconnected = false
    const lost = (): void => {
      if (disconnected) return
      disconnected = true
      for (const [id, transfer] of transfers) {
        if (transfer.state !== 'running' && transfer.state !== 'queued') continue
        transfers.set(id, {
          ...transfer,
          state: 'error',
          bytesPerSecond: 0,
          error: t('The connection changed')
        })
      }
      onTransfers([...transfers.values()])
      onDisconnect()
    }
    const client = await ModuleSessionClient.open(
      's3',
      { kind: 'module', sessionKind: 'browser', params: { accountId } },
      {
        onHostRestart: lost,
        onExit: lost,
        onEvent: (event, data) => {
          if (disconnected) return
          if (event !== 'transfers') return
          const delta = data as S3TransferDelta
          for (const id of delta.remove) transfers.delete(id)
          for (const t of delta.upsert) transfers.set(t.id, t)
          onTransfers([...transfers.values()])
        }
      }
    )
    return new S3SessionClient(client)
  }

  request(op: S3Op): Promise<unknown> {
    return this.client.request(op).catch((error: unknown) => {
      throw error instanceof Error && error.message === 'The session is closed'
        ? new Error('The S3 tab is closed')
        : error
    })
  }

  /** Huỷ một lượt truyền; các lần gọi liền nhau gộp thành một request. */
  cancel(transferId: string): void {
    this.cancelIds.push(transferId)
    if (this.cancelIds.length > 1) return
    queueMicrotask(() => {
      const transferIds = this.cancelIds
      this.cancelIds = []
      void this.request({ op: 'cancel', transferIds }).catch(() => undefined)
    })
  }

  close(): void {
    this.client.close()
  }
}
