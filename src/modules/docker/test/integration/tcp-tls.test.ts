import { createServer as createNetServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { describeTlsError } from '../../session-host/tls'
import type { DockerTcpConfig } from '../../shared/ops'
import type { ContainerRow } from '../../shared/ops'
import { startEngineTestServer } from '../engine-test-server'
import { pem, startTlsProxy } from '../tls-proxy-server'
import { tcpServiceForTest } from './tcp-service'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function tlsProxy(requireClientCert: boolean): Promise<{ port: number }> {
  const engine = await startEngineTestServer()
  cleanups.push(() => engine.close())
  const proxy = await startTlsProxy(engine, requireClientCert)
  cleanups.push(() => proxy.close())
  return { port: proxy.port }
}

const config = (port: number, extra: Partial<DockerTcpConfig> = {}): DockerTcpConfig => ({
  id: 'e1',
  host: '127.0.0.1',
  port,
  ca: pem('ca.pem'),
  cert: pem('client.pem'),
  key: pem('client-key.pem'),
  ...extra
})

async function run<T>(cfg: DockerTcpConfig, op: unknown): Promise<T> {
  const { service } = tcpServiceForTest(cfg)
  cleanups.push(() => {
    service.dispose()
  })
  return (await service.run(op, new AbortController().signal)) as T
}

describe('Docker qua TCP + TLS', () => {
  it('mTLS đúng CA + chứng chỉ client → liệt kê container như mọi nguồn khác', async () => {
    const { port } = await tlsProxy(true)
    const containers = await run<ContainerRow[]>(config(port), { op: 'containers', all: true })
    expect(containers.map((c) => c.name).sort()).toEqual(['db', 'old-job', 'web'])
  })

  it('server TLS không đòi chứng chỉ client → chỉ cần CA', async () => {
    const { port } = await tlsProxy(false)
    const containers = await run<ContainerRow[]>(
      config(port, { cert: undefined, key: undefined }),
      { op: 'containers', all: true }
    )
    expect(containers).toHaveLength(3)
  })

  it('server đòi chứng chỉ client mà không đưa → câu nói rõ', async () => {
    const { port } = await tlsProxy(true)
    await expect(
      run(config(port, { cert: undefined, key: undefined }), { op: 'info' })
    ).rejects.toThrow(/refused the client certificate/)
  })

  it('sai CA → "không ký bởi CA đã cho"', async () => {
    const { port } = await tlsProxy(true)
    await expect(run(config(port, { ca: pem('other-ca.pem') }), { op: 'info' })).rejects.toThrow(
      /not signed by the CA you gave/
    )
  })

  it('không đưa CA → CA hệ thống không tin chứng chỉ riêng → cùng câu hướng dẫn', async () => {
    const { port } = await tlsProxy(true)
    await expect(run(config(port, { ca: undefined }), { op: 'info' })).rejects.toThrow(
      /not signed by the CA/
    )
  })

  it('cổng không ai nghe → "connection refused"', async () => {
    const closed = createNetServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as { port: number }).port
    await new Promise<void>((resolve) => {
      closed.close(() => {
        resolve()
      })
    })
    await expect(run(config(port), { op: 'info' })).rejects.toThrow(/connection refused/)
  })

  it('cổng không phải TLS (HTTP thường) → gợi ý cổng 2376 / 2375', async () => {
    const sockets: { destroy(): void }[] = []
    const plain: Server = createNetServer((socket) => {
      sockets.push(socket)
      socket.on('error', () => undefined)
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK')
    })
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy()
          plain.close(() => {
            resolve()
          })
        })
    )
    const port = (plain.address() as { port: number }).port
    await expect(run(config(port), { op: 'info' })).rejects.toThrow(/TLS port|2376/)
  })

  it('Compose / build / shell cần docker CLI → báo chưa hỗ trợ, không chạy gì', async () => {
    const { port } = await tlsProxy(true)
    await expect(
      run(config(port), { op: 'compose', project: 'shop', action: 'down' })
    ).rejects.toThrow(/docker command line/)
  })
})

describe('describeTlsError', () => {
  const cfg = { host: 'docker.internal', port: 2376 }
  const err = (code: string, message = ''): Error =>
    describeTlsError(Object.assign(new Error(message || code), { code }), cfg)
  it('đổi mã lỗi thành câu cần làm gì, giữ mã gốc ở cuối', () => {
    expect(err('ENOTFOUND').message).toMatch(/Could not find the host docker\.internal/)
    expect(err('ETIMEDOUT').message).toMatch(/did not answer in time\. \(ETIMEDOUT\)/)
    expect(err('ERR_TLS_CERT_ALTNAME_INVALID').message).toMatch(/not valid for docker\.internal/)
    expect(err('CERT_HAS_EXPIRED').message).toMatch(/has expired/)
    expect(err('DEPTH_ZERO_SELF_SIGNED_CERT').message).toMatch(/not signed by the CA/)
  })
  it('lỗi lạ giữ nguyên', () => {
    const original = new Error('something else')
    expect(describeTlsError(original, cfg)).toBe(original)
  })
})
