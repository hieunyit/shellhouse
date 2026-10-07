import { t } from '@shared/i18n'
import { isCertificateError } from '@shared/proxy'

/**
 * Lỗi của electron-updater → trạng thái cho người dùng. Tag mới đã có nhưng release chưa publish
 * (hoặc CI đang tải file lên) → GitHub trả 404 cho file kênh: đó là "chưa có bản mới", không phải lỗi.
 */
export function describeUpdateError(
  error: unknown
): { kind: 'none' } | { kind: 'error'; message: string } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const text = error instanceof Error ? error.message : String(error)
  if (
    code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    /No published versions/i.test(text)
  )
    return { kind: 'none' }
  // Lỗi chứng chỉ (proxy công ty chặn TLS…) — chỉ chỗ bật bỏ qua.
  if (isCertificateError(text))
    return {
      kind: 'error',
      message: t(
        'The update server certificate was not trusted. Behind a company proxy that inspects TLS, turn on “Ignore certificate errors for updates” in Settings › Network.'
      )
    }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR_/.test(text))
    return {
      kind: 'error',
      message: t('Could not reach the update server. Check your connection.')
    }
  const first = text.split('\n')[0]?.trim() ?? ''
  return {
    kind: 'error',
    message: first.length > 160 ? `${first.slice(0, 157)}…` : first || t('Update check failed.')
  }
}
