import { X509Certificate } from 'node:crypto'

/**
 * Hạn (notAfter, ISO) của chứng chỉ đầu tiên trong chuỗi PEM — chứng chỉ lá của Secret TLS,
 * client-certificate trong kubeconfig… Không phải PEM / hỏng → null (không đoán).
 */
export function certExpiry(pem: string | Buffer): string | null {
  const text = typeof pem === 'string' ? pem : pem.toString('utf8')
  const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)
  if (!m) return null
  try {
    const at = new Date(new X509Certificate(m[0]).validTo)
    return Number.isNaN(at.getTime()) ? null : at.toISOString()
  } catch {
    return null
  }
}
