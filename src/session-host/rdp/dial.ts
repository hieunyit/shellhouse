import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client } from 'ssh2'
import { t } from '@shared/i18n'
import type { RdpViewTarget } from '@shared/rdp-viewer'
import type { Dialer } from './proxy'

export interface DialDeps {
  /** Kết nối SSH tích hợp của một phiên đang mở (null = không có / không phải SSH tích hợp). */
  sshClient(sessionId: string): Promise<Client | null>
  connectTimeoutMs?: number
}

function tcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30_000)
    const timer = setTimeout(() => {
      socket.destroy(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolve(socket)
    })
    const onError = (error: Error): void => {
      clearTimeout(timer)
      reject(error)
    }
    socket.once('error', onError)
  })
}

function forward(client: Client, host: string, port: number, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
      clearTimeout(timer)
      if (error) {
        // ssh2: "(SSH) Channel open failure: Connection refused" — đổi về mã kiểu socket.
        const refused = /refused/i.test(error.message)
        reject(refused ? Object.assign(error, { code: 'ECONNREFUSED' }) : error)
        return
      }
      resolve(stream)
    })
  })
}

/** TCP thẳng, hoặc kênh direct-tcpip trên kết nối SSH của phiên `viaSessionId`. */
export function createDialer(deps: DialDeps): Dialer {
  const timeout = deps.connectTimeoutMs ?? 15_000
  return async (target: RdpViewTarget) => {
    if (!target.viaSessionId) return tcp(target.host, target.port, timeout)
    const client = await deps.sshClient(target.viaSessionId)
    if (!client) throw new Error(t('The SSH connection for the tunnel is not open'))
    return forward(client, target.host, target.port, timeout)
  }
}
