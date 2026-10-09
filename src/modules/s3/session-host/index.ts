import { setLanguage } from '@shared/i18n'
import type { HostModule, HostModuleContext } from '../../registry/host-types'
import { requireEditFile, requireLocalPaths } from '../../registry/local-access'
import { s3Manifest } from '../manifest'
import { S3SessionConfig } from '../shared/ipc'
import { S3Op } from '../shared/ops'
import { S3Service, type S3Connection } from './service'

/** Đường dẫn trên máy: tải lên = đọc, tải về = ghi (đều phải do người dùng chọn), sửa = file tạm. */
export async function checkLocalPaths(
  op: S3Op,
  ctx: Pick<HostModuleContext, 'localPathGranted' | 'ownsEditFile'>
): Promise<void> {
  if (op.op === 'upload') await requireLocalPaths(ctx, [op.localPath], 'read')
  else if (op.op === 'uploadCheck') await requireLocalPaths(ctx, op.localPaths, 'read')
  else if (op.op === 'download') await requireLocalPaths(ctx, [op.localPath], 'write')
  else if (op.op === 'edit') await requireEditFile(ctx, op.localPath)
}

/** Phần Session Host của S3: một `S3Service` mỗi tab (AWS SDK chạy ở đây, không ở UI). */
export const s3Host: HostModule = {
  manifest: s3Manifest,
  createSession(_kind, raw, ctx) {
    const config = S3SessionConfig.parse(raw)
    // Session Host không tự biết ngôn ngữ giao diện: lấy theo main (cố định từ lúc khởi động app).
    if (config.language) setLanguage(config.language, config.locale)
    const service = new S3Service(
      config.connection,
      // Chỉ gửi phần thay đổi (sự kiện module `transfers`): hàng nghìn lượt đang chờ không phải
      // gửi lại cả danh sách mỗi 250 ms. Renderer ghép lại (s3-client.ts).
      (delta) => {
        ctx.emit('transfers', delta)
      },
      config.limits,
      // Đồng bộ sang tài khoản khác: main giải mã secret của tài khoản đó (không qua renderer).
      async (accountId) => (await ctx.fromMain('account', accountId)) as S3Connection
    )
    ctx.log('info', `opened ${config.connection.endpoint || 'AWS'}`)
    return {
      run: async (raw) => {
        const op = S3Op.parse(raw)
        await checkLocalPaths(op, ctx)
        return service.run(op)
      },
      dispose: () => {
        service.dispose()
      }
    }
  }
}
