import type { MutationResult } from '@shared/hosts'
import { invokeModule, onModuleEvent, openModuleTab } from '../../registry/renderer-kit'
import type { S3BrowserParams } from '../shared/ipc'
import type { S3AccountInput, S3AccountSummary, S3Pin } from '../shared/ops'

/** IPC `module:s3:*` — secret key không bao giờ quay về renderer. */
export const s3Api = {
  accounts: () => invokeModule<S3AccountSummary[]>('s3', 'accounts'),
  save: (input: S3AccountInput) => invokeModule<MutationResult>('s3', 'save', input),
  /** Thử kết nối bằng thông tin trong form (chưa cần lưu). */
  test: (input: S3AccountInput) =>
    invokeModule<{ ok: boolean; message: string }>('s3', 'test', input),
  delete: (id: string) => invokeModule<undefined>('s3', 'delete', id),
  /** Ghim / bỏ ghim bucket hoặc thư mục lên thanh bên. */
  pin: (accountId: string, pin: S3Pin, pinned: boolean) =>
    invokeModule<undefined>('s3', 'pin', accountId, pin, pinned),
  onChanged: (listener: () => void) =>
    onModuleEvent('s3', 'changed', () => {
      listener()
    })
}

/** Tiêu đề tab S3 theo vị trí: "bucket" hoặc "bucket/…/thư-mục-cuối". */
export function s3LocationTitle(bucket: string, prefix: string): string {
  const parts = prefix.split('/').filter(Boolean)
  if (parts.length === 0) return bucket
  if (parts.length === 1) return `${bucket}/${parts[0] ?? ''}`
  return `${bucket}/…/${parts.at(-1) ?? ''}`
}

/** Mở trình quản lý S3 của một tài khoản (tuỳ chọn: đúng bucket / thư mục). */
export function openS3(
  account: { id: string },
  location?: { bucket: string; prefix: string }
): string | null {
  const params: S3BrowserParams = location
    ? { accountId: account.id, bucket: location.bucket, prefix: location.prefix }
    : { accountId: account.id }
  return openModuleTab('s3', 'browser', params)
}
