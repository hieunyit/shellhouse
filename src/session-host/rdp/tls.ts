import { X509Certificate } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, type DetailedPeerCertificate, type TLSSocket } from 'node:tls'
import { isIP } from 'node:net'
import type { RdpCertInfo, RdpTlsInfo } from '@shared/rdp-viewer'
import { DerError, TAG_OCTET_STRING, TAG_SEQUENCE, readElements, readSingle } from './der'

/**
 * modern = mặc định của Node (TLS 1.2/1.3, trao đổi khoá ECDHE). legacy-rsa = TLS 1.2, chỉ bộ mã
 * trao đổi khoá RSA — cho server có chứng chỉ thiếu bit digitalSignature (xem `isKeyUsageError`).
 */
export type TlsMode = 'modern' | 'legacy-rsa'

/**
 * Bộ mã trao đổi khoá RSA: khoá của chứng chỉ chỉ dùng để mã hoá (keyEncipherment), không ký —
 * như mstsc/Schannel vẫn bắt tay được với chứng chỉ tự ký mặc định của Windows. Không có forward
 * secrecy nên chỉ dùng khi server thực sự cần.
 */
export const LEGACY_RSA_CIPHERS =
  'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA'

/**
 * TLS tới server RDP. Chứng chỉ server RDP gần như luôn tự ký → không kiểm theo CA ở đây; thay vào
 * đó Shellhouse ghim (TOFU) dấu SHA-256 của chứng chỉ, như known_hosts của SSH. Chuỗi chứng chỉ
 * được trả cho client (CredSSP cần khoá công khai của server).
 */
export function startTls(
  socket: Duplex,
  host: string,
  timeoutMs: number,
  mode: TlsMode = 'modern'
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({
      socket,
      rejectUnauthorized: false,
      // SNI chỉ cho tên miền (không gửi IP — RFC 6066).
      ...(isIP(host) === 0 ? { servername: host } : {}),
      minVersion: 'TLSv1.2',
      ...(mode === 'legacy-rsa' ? { maxVersion: 'TLSv1.2', ciphers: LEGACY_RSA_CIPHERS } : {})
    })
    const timer = setTimeout(() => {
      tls.destroy(new Error('timed out during the TLS handshake'))
    }, timeoutMs)
    tls.once('secureConnect', () => {
      clearTimeout(timer)
      tls.off('error', onError)
      resolve(tls)
    })
    const onError = (error: Error): void => {
      clearTimeout(timer)
      reject(error)
    }
    tls.once('error', onError)
  })
}

/**
 * BoringSSL (Node trong Electron) kiểm keyUsage của chứng chỉ server: ECDHE_RSA và TLS 1.3 cần
 * digitalSignature. Chứng chỉ RDP tự ký của Windows thường chỉ có keyEncipherment +
 * dataEncipherment → "KEY_USAGE_BIT_INCORRECT" (Schannel/mstsc không kiểm). OpenSSL của Node
 * thường không kiểm nên lỗi này chỉ gặp trong app.
 */
export function isKeyUsageError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null
  if (e?.code === 'ERR_SSL_KEY_USAGE_BIT_INCORRECT') return true
  return typeof e?.message === 'string' && e.message.includes('KEY_USAGE_BIT_INCORRECT')
}

/** OID 2.5.29.15 (keyUsage), phần giá trị DER. */
const OID_KEY_USAGE = Buffer.from([0x55, 0x1d, 0x0f])

/**
 * Bit keyUsage của chứng chỉ (DER). null = không có extension keyUsage (dùng được cho mọi việc)
 * hoặc không đọc được.
 */
export function keyUsageOf(
  der: Buffer
): { digitalSignature: boolean; keyEncipherment: boolean } | null {
  try {
    // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
    const tbs = readElements(readSingle(der, TAG_SEQUENCE))[0]
    if (tbs?.tag !== TAG_SEQUENCE) return null
    // extensions [3] EXPLICIT — trường cuối của tbsCertificate (X.509 v3).
    const extensions = readElements(tbs.value).find((e) => e.tag === 0xa3)
    if (!extensions) return null
    for (const ext of readElements(readSingle(extensions.value, TAG_SEQUENCE))) {
      if (ext.tag !== TAG_SEQUENCE) continue
      const parts = readElements(ext.value)
      const oid = parts[0]
      if (oid?.tag !== 0x06 || !oid.value.equals(OID_KEY_USAGE)) continue
      const octets = parts.find((p) => p.tag === TAG_OCTET_STRING)
      if (!octets) return null
      // KeyUsage ::= BIT STRING — byte đầu là số bit thừa, bit 0 = 0x80 của byte kế.
      const bits = readSingle(octets.value, 0x03)
      const first = bits[1] ?? 0
      return { digitalSignature: (first & 0x80) !== 0, keyEncipherment: (first & 0x20) !== 0 }
    }
    return null
  } catch (error) {
    if (error instanceof DerError) return null
    throw error
  }
}

/**
 * Chứng chỉ có keyUsage nhưng thiếu digitalSignature → chỉ bắt tay được bằng trao đổi khoá RSA.
 * Dùng để kiểm lại sau khi lùi về legacy-rsa: lỗi key usage không đến từ đúng chứng chỉ này
 * (ví dụ kẻ đứng giữa chèn chứng chỉ khác để ép hạ cấp) → không chấp nhận.
 */
export function needsLegacyRsa(der: Buffer): boolean {
  const usage = keyUsageOf(der)
  return usage !== null && !usage.digitalSignature && usage.keyEncipherment
}

/** Thông tin phiên TLS để hiện trên thanh trạng thái. */
export function tlsInfo(tls: TLSSocket, mode: TlsMode): RdpTlsInfo {
  return {
    protocol: (tls.getProtocol() ?? 'TLS').slice(0, 32),
    cipher: (tls.getCipher().standardName || tls.getCipher().name).slice(0, 128),
    legacyRsa: mode === 'legacy-rsa'
  }
}

/** Chuỗi chứng chỉ server (DER), chứng chỉ của server trước. */
export function peerChain(tls: TLSSocket): Buffer[] {
  const chain: Buffer[] = []
  const seen = new Set<string>()
  // Không có chứng chỉ → {} ; chứng chỉ gốc tự ký trỏ issuerCertificate về chính nó.
  let cert = tls.getPeerCertificate(true) as Partial<DetailedPeerCertificate> | undefined
  while (cert?.raw && cert.fingerprint256 && !seen.has(cert.fingerprint256) && chain.length < 10) {
    seen.add(cert.fingerprint256)
    chain.push(Buffer.from(cert.raw))
    cert = cert.issuerCertificate
  }
  return chain
}

export function certInfo(der: Buffer): RdpCertInfo {
  const x = new X509Certificate(der)
  const oneLine = (s: string): string => s.split('\n').filter(Boolean).join(', ').slice(0, 2048)
  return {
    fingerprint: x.fingerprint256.toUpperCase(),
    subject: oneLine(x.subject),
    issuer: oneLine(x.issuer),
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: new Date(x.validTo).toISOString(),
    selfSigned: x.subject === x.issuer
  }
}

/** Mã TLS alert từ lỗi OpenSSL của Node (ERR_SSL_TLSV1_ALERT_…), mặc định 40 (handshake failure). */
export function tlsAlertOf(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code
  const known: Record<string, number> = {
    ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION: 70,
    ERR_SSL_UNSUPPORTED_PROTOCOL: 70,
    ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR: 80,
    ERR_SSL_TLSV1_ALERT_ACCESS_DENIED: 49,
    ERR_SSL_TLSV1_ALERT_DECODE_ERROR: 50,
    ERR_SSL_TLSV1_ALERT_INSUFFICIENT_SECURITY: 71
  }
  return typeof code === 'string' ? (known[code] ?? 40) : 40
}
