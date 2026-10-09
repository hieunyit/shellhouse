import { readFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'
import type { EngineTestServer } from './engine-test-server'

const FIXTURES = join(__dirname, 'fixtures')

/** PEM của bộ chứng chỉ test (xem fixtures/README.md). */
export const pem = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

export interface TlsProxy {
  port: number
  close(): Promise<void>
}

/**
 * TLS (mTLS tuỳ chọn) đặt trước Engine giả: mỗi kết nối TLS được nối sang socket unix của Engine —
 * đủ để thử Docker qua `tcp://127.0.0.1:<port>` như một daemon `--tlsverify` thật.
 */
export async function startTlsProxy(
  engine: EngineTestServer,
  requireClientCert: boolean
): Promise<TlsProxy> {
  const open = new Set<{ destroy(): void }>()
  const server = createTlsServer(
    {
      key: pem('server-key.pem'),
      cert: pem('server.pem'),
      ca: pem('ca.pem'),
      requestCert: requireClientCert,
      rejectUnauthorized: requireClientCert,
      minVersion: 'TLSv1.2'
    },
    (socket) => {
      const upstream = netConnect(engine.path)
      open.add(socket)
      socket.on('close', () => {
        open.delete(socket)
      })
      socket.pipe(upstream).pipe(socket)
      socket.on('error', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
    }
  )
  // Bắt tay hỏng (thiếu chứng chỉ client…) là chuyện bình thường của các test này.
  server.on('tlsClientError', () => undefined)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        for (const s of open) s.destroy()
      })
  }
}
