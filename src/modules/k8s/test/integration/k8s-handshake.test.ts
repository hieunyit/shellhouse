import { connect, createServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handshake, KubeClient } from '../../session-host/client'
import { startApiTestServer, TEST_CA, TOKEN } from '../api-test-server'

const saved = { ...handshake }
afterEach(() => {
  Object.assign(handshake, saved)
})

const rawConnect = (host: string, port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = connect({ host, port })
    s.once('connect', () => {
      resolve(s)
    })
    s.once('error', reject)
  })

describe('KubeClient — bắt tay TLS treo', () => {
  it('server nhận TCP nhưng không trả lời TLS → báo lỗi sau thời hạn, đã thử lại, không treo', async () => {
    const accepted: Socket[] = []
    const server = createServer((s) => accepted.push(s))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    Object.assign(handshake, { ms: 150, attempts: 3 })
    const client = new KubeClient(
      { server: `https://127.0.0.1:${String(port)}`, ca: TEST_CA, insecure: false },
      rawConnect,
      () => Promise.resolve({ headers: { Authorization: `Bearer ${TOKEN}` } })
    )
    const started = Date.now()
    await expect(client.json('GET', '/version')).rejects.toThrow(/TLS handshake .* timed out/)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(accepted).toHaveLength(3)
    for (const s of accepted) s.destroy()
    await new Promise<void>((r) =>
      server.close(() => {
        r()
      })
    )
  })

  it('lần đầu treo, lần sau trả lời → request vẫn thành công', async () => {
    const api = await startApiTestServer()
    Object.assign(handshake, { ms: 150, attempts: 3 })
    let first = true
    const client = new KubeClient(
      { server: api.url, ca: TEST_CA, insecure: false },
      (host, port) => {
        if (!first) return rawConnect(host, port)
        first = false
        // Kết nối "câm": TCP tới một server không bao giờ bắt tay.
        return new Promise((resolve) => {
          const mute = createServer(() => undefined)
          mute.listen(0, '127.0.0.1', () => {
            void rawConnect('127.0.0.1', (mute.address() as AddressInfo).port).then((s) => {
              s.once('close', () => mute.close())
              resolve(s)
            })
          })
        })
      },
      () => Promise.resolve({ headers: { Authorization: `Bearer ${TOKEN}` } })
    )
    await expect(client.json('GET', '/version')).resolves.toMatchObject({ gitVersion: 'v1.31.2' })
    await api.close()
  })
})
