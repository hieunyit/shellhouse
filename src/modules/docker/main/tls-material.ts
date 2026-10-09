import { X509Certificate, createPrivateKey } from 'node:crypto'
import { t } from '@shared/i18n'

/** CA / chứng chỉ client / khoá riêng (PEM) người dùng nhập cho một engine TCP + TLS. */
export interface TlsMaterial {
  ca?: string | undefined
  cert?: string | undefined
  key?: string | undefined
}

/** Phần công khai của chứng chỉ client — hiện ở danh sách, không cần giải mã khoá. */
export interface TlsInfo {
  /** Hạn của chứng chỉ client (ms) — null = không có chứng chỉ client. */
  expires: number | null
  /** Chủ thể (CN=…) của chứng chỉ client. */
  subject: string | null
}

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** Mọi chứng chỉ trong một khối PEM (CA có thể là cả chuỗi). */
function certificatesOf(pem: string): X509Certificate[] {
  const blocks = pem.match(CERT_BLOCK) ?? []
  return blocks.map((b) => new X509Certificate(b))
}

/**
 * Kiểm tra trước khi lưu — lỗi nói rõ tệp nào sai, để không phải đợi tới lúc kết nối mới biết:
 * PEM đúng dạng, khoá không đặt passphrase, chứng chỉ và khoá khớp nhau, chưa hết hạn.
 */
export function checkTlsMaterial(m: TlsMaterial, now: number = Date.now()): TlsInfo {
  if (m.ca !== undefined && m.ca.trim() !== '') {
    let ok: boolean
    try {
      ok = certificatesOf(m.ca).length > 0
    } catch {
      ok = false
    }
    if (!ok) throw new Error(t('The CA file is not a PEM certificate.'))
  }
  const hasCert = m.cert !== undefined && m.cert.trim() !== ''
  const hasKey = m.key !== undefined && m.key.trim() !== ''
  if (hasCert !== hasKey)
    throw new Error(t('Give both the client certificate and its private key, or neither.'))
  if (!hasCert || !hasKey) return { expires: null, subject: null }

  const keyText = m.key ?? ''
  if (/ENCRYPTED/.test(keyText))
    throw new Error(
      t(
        'The private key is protected by a passphrase. Remove it first (openssl pkey -in key.pem -out key-nopass.pem).'
      )
    )
  let key: ReturnType<typeof createPrivateKey>
  try {
    key = createPrivateKey(keyText)
  } catch {
    throw new Error(t('The private key file is not a valid PEM key.'))
  }
  let cert: X509Certificate
  try {
    const first = certificatesOf(m.cert ?? '')[0]
    if (!first) throw new Error('none')
    cert = first
  } catch {
    throw new Error(t('The client certificate is not a PEM certificate.'))
  }
  if (!cert.checkPrivateKey(key))
    throw new Error(t('The client certificate and the private key do not belong together.'))
  const expires = new Date(cert.validTo).getTime()
  if (Number.isFinite(expires) && expires < now)
    throw new Error(
      t('The client certificate expired on {date}.', {
        date: new Date(expires).toISOString().slice(0, 10)
      })
    )
  const cn = /CN=([^\n,]+)/.exec(cert.subject)?.[1]
  return {
    expires: Number.isFinite(expires) ? expires : null,
    subject: cn ?? (cert.subject.replace(/\n/g, ', ') || null)
  }
}
