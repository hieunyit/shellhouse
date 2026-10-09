import { isIP } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Duplex } from 'node:stream'
import { t } from '@shared/i18n'
import type { DockerTcpConfig } from '../shared/ops'

const CONNECT_TIMEOUT_MS = 15_000

/**
 * Lỗi TLS / mạng → câu nói rõ cần sửa gì (CA sai, thiếu chứng chỉ client, tên máy không khớp…),
 * kèm mã gốc để tra cứu.
 */
export function describeTlsError(
  error: unknown,
  cfg: Pick<DockerTcpConfig, 'host' | 'port'>
): Error {
  const e = error as { code?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const raw = typeof e.message === 'string' ? e.message : String(error)
  const where = `${cfg.host}:${String(cfg.port)}`
  let text: string
  if (code === 'ECONNREFUSED')
    text = t('Nothing is listening on {where} (connection refused).', { where })
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    text = t('Could not find the host {host}.', { host: cfg.host })
  else if (code === 'ETIMEDOUT' || /timed out/i.test(raw))
    text = t('{where} did not answer in time.', { where })
  else if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
  )
    text = t(
      'The server certificate is not signed by the CA you gave (or you gave none). Add the CA that signed the Docker daemon certificate.'
    )
  else if (code === 'ERR_TLS_CERT_ALTNAME_INVALID')
    text = t(
      'The server certificate is not valid for {host}. Connect with a name or address listed in it.',
      { host: cfg.host }
    )
  else if (code === 'CERT_HAS_EXPIRED') text = t('The server certificate has expired.')
  else if (
    /certificate required|bad certificate|unknown ca|handshake failure|ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED|ERR_SSL_SSLV3_ALERT/i.test(
      `${code} ${raw}`
    )
  )
    text = t(
      'The server refused the client certificate (or none was given). Check that it is signed by the CA the daemon trusts.'
    )
  else if (code === 'ECONNRESET' || /socket hang up|wrong version number|packet length/i.test(raw))
    text = t(
      '{where} closed the connection during the TLS handshake. It may not be a TLS port (Docker uses 2376 for TLS, 2375 for plain).',
      { where }
    )
  else return error instanceof Error ? error : new Error(raw)
  return new Error(code ? `${text} (${code})` : text, { cause: error })
}

/**
 * Kết nối TLS tới Docker daemon. Luôn kiểm chứng chỉ máy chủ: có CA → chỉ tin CA đó (daemon thường
 * dùng CA riêng), không có → CA hệ thống. Có chứng chỉ client + khoá → mTLS (`--tlsverify`).
 */
export function connectTls(cfg: DockerTcpConfig): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const socket: TLSSocket = tlsConnect({
      host: cfg.host,
      port: cfg.port,
      // IP thì kiểm theo SAN kiểu IP; servername chỉ dành cho tên miền.
      ...(isIP(cfg.host) === 0 ? { servername: cfg.host } : {}),
      ...(cfg.ca ? { ca: cfg.ca } : {}),
      ...(cfg.cert && cfg.key ? { cert: cfg.cert, key: cfg.key } : {}),
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true
    })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(describeTlsError(new Error('timed out'), cfg))
    }, CONNECT_TIMEOUT_MS)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socket)
    })
    const onError = (e: Error): void => {
      clearTimeout(timer)
      reject(describeTlsError(e, cfg))
    }
    socket.once('error', onError)
  })
}
