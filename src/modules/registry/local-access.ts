import { t } from '@shared/i18n'
import type { HostModuleContext } from './host-types'

/**
 * Đường dẫn trên máy trong thao tác của module (renderer gửi) phải là thứ người dùng đã chọn qua
 * hộp thoại của main / kéo thả — renderer bị chiếm không biến "tải về" thành ghi đè file bất kỳ
 * (`~/.bashrc`…) hay "tải lên" thành lấy `~/.ssh/id_rsa`.
 */
export async function requireLocalPaths(
  ctx: Pick<HostModuleContext, 'localPathGranted'>,
  paths: readonly string[],
  access: 'read' | 'write'
): Promise<void> {
  for (const path of paths)
    if (!(await ctx.localPathGranted(path, access)))
      throw new Error(t('Choose the file or folder on this computer again'))
}

/** File tạm "sửa bằng editor trên máy" phải do main cấp (files:prepareEdit). */
export async function requireEditFile(
  ctx: Pick<HostModuleContext, 'ownsEditFile'>,
  path: string
): Promise<void> {
  if (!(await ctx.ownsEditFile(path)))
    throw new Error(t('The local copy for editing must be in the app’s temporary folder'))
}
