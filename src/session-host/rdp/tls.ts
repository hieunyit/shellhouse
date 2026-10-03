import { X509Certificate } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, type DetailedPeerCertificate, type TLSSocket } from 'node:tls'
import { isIP } from 'node:net'
import type { RdpCertInfo } from '@shared/rdp-viewer'

/**
 * TLS tới server RDP. Chứng chỉ server RDP gần như luôn tự ký → không kiểm theo CA ở đây; thay vào
 * đó Shellhouse ghim (TOFU) dấu SHA-256 của chứng chỉ, như known_hosts của SSH. Chuỗi chứng chỉ
 * được trả cho client (CredSSP cần khoá công khai của server).
 */
export function startTls(socket: Duplex, host: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({
      socket,
      rejectUnauthorized: false,
      // SNI chỉ cho tên miền (không gửi IP — RFC 6066).
      ...(isIP(host) === 0 ? { servername: host } : {}),
      minVersion: 'TLSv1.2'
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
