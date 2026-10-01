import type { HostModule } from '../../registry/host-types'
import { s3Manifest } from '../manifest'
import { S3SessionConfig } from '../shared/ipc'
import { S3Op } from '../shared/ops'
import { S3Service, type S3Connection } from './service'

/** Phần Session Host của S3: một `S3Service` mỗi tab (AWS SDK chạy ở đây, không ở UI). */
export const s3Host: HostModule = {
  manifest: s3Manifest,
  createSession(_kind, raw, ctx) {
    const config = S3SessionConfig.parse(raw)
    const service = new S3Service(
      config.connection,
      (list) => {
        ctx.transfers(list)
      },
      config.limits,
      // Đồng bộ sang tài khoản khác: main giải mã secret của tài khoản đó (không qua renderer).
      async (accountId) => (await ctx.fromMain('account', accountId)) as S3Connection
    )
    ctx.log('info', `opened ${config.connection.endpoint || 'AWS'}`)
    return {
      run: (op) => service.run(S3Op.parse(op)),
      dispose: () => {
        service.dispose()
      }
    }
  }
}
