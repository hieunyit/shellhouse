import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createDialer } from '../../src/session-host/rdp/dial'
import { PROXY_PATH, RdpProxy } from '../../src/session-host/rdp/proxy'
import { RDCLEANPATH_VERSION, decodePdu, encodePdu } from '../../src/session-host/rdp/rdcleanpath'
import { connectionRequest } from '../../src/session-host/rdp/x224'

/**
 * Chỉ chạy khi có server RDP thật (mặc định bỏ qua):
 *   docker run -d -p 127.0.0.1:33890:3389 scottyhardy/docker-remote-desktop
 *   SHELLHOUSE_TEST_RDP_SERVER=127.0.0.1:33890 pnpm vitest run test/integration/rdp-xrdp.test.ts
 */
const server = process.env['SHELLHOUSE_TEST_RDP_SERVER']
const [host = '', portText = '3389'] = server?.split(/:(?=\d+$)/) ?? []
const port = Number(portText)

describe.skipIf(!server)('RdpProxy với server RDP thật', () => {
  it('probe + RDCleanPath: X.224 Confirm và chuỗi chứng chỉ thật', async () => {
    const proxy = new RdpProxy({
      dial: createDialer({ sshClient: () => Promise.resolve(null) }),
      log: () => undefined
    })
    try {
      const target = { host, port }
      const cert = await proxy.probe(target)
      expect(cert.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
      const { port: wsPort, token } = await proxy.open(target, cert.fingerprint)
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}${PROXY_PATH}`)
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const reply = new Promise<Buffer>((resolve) => {
        ws.once('message', (data: Buffer) => {
          resolve(data)
        })
      })
      ws.send(
        encodePdu({
          version: RDCLEANPATH_VERSION,
          destination: `${host}:${port}`,
          proxyAuth: token,
          x224ConnectionPdu: connectionRequest()
        })
      )
      const pdu = decodePdu(await reply)
      expect(pdu.error).toBeUndefined()
      expect(pdu.x224ConnectionPdu?.[5]).toBe(0xd0)
      expect(pdu.serverCertChain?.length).toBeGreaterThan(0)
      ws.close()
    } finally {
      proxy.close()
    }
  }, 20_000)
})
