import type { TransferStatus } from '@shared/sftp'
import { ModuleSessionClient } from '../../registry/renderer-kit'
import type { S3Op } from '../shared/ops'

/** Đầu renderer của một phiên S3 (phiên module `s3/browser`): gửi thao tác, nhận kết quả. */
export class S3SessionClient {
  private constructor(private readonly client: ModuleSessionClient) {}

  static async open(
    accountId: string,
    onTransfers: (list: TransferStatus[]) => void
  ): Promise<S3SessionClient> {
    const client = await ModuleSessionClient.open(
      's3',
      { kind: 'module', sessionKind: 'browser', params: { accountId } },
      { onTransfers }
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

  close(): void {
    this.client.close()
  }
}
