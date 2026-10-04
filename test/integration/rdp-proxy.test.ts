import { connect as netConnect, createServer } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createDialer } from '../../src/session-host/rdp/dial'
import { PROXY_PATH, RdpProxy } from '../../src/session-host/rdp/proxy'
import {
  RDCLEANPATH_VERSION,
  decodePdu,
  detectPdu,
  encodePdu,
  type RDCleanPathPdu
} from '../../src/session-host/rdp/rdcleanpath'
import {
  isKeyUsageError,
  keyUsageOf,
  needsLegacyRsa,
  startTls
} from '../../src/session-host/rdp/tls'
import { connectionRequest } from '../../src/session-host/rdp/x224'
import { findClientInfo } from '../../src/session-host/rdp/client-info'
import { clientInfoPdu, fakeCertPem, startFakeRdp, type FakeRdp } from './rdp-fake-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function proxy(tls?: typeof startTls, logs?: string[]): RdpProxy {
  const p = new RdpProxy({
    dial: createDialer({ sshClient: () => Promise.resolve(null), connectTimeoutMs: 3_000 }),
    log: (_level, message) => logs?.push(message),
    handshakeTimeoutMs: 3_000,
    ...(tls ? { startTls: tls } : {})
  })
  cleanups.push(() => {
    p.close()
  })
  return p
}

async function fake(options: Parameters<typeof startFakeRdp>[0] = {}): Promise<FakeRdp> {
  const f = await startFakeRdp(options)
  cleanups.push(() => f.close())
  return f
}

/** Client WebSocket tối giản như IronRDP: gửi yêu cầu, đọc PDU trả lời rồi chuyển byte. */
class Client {
  private buf = Buffer.alloc(0)
  private waiters: (() => void)[] = []
  closed = false
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.buf = Buffer.concat([this.buf, data])
      for (const w of this.waiters.splice(0)) w()
    })
    ws.on('close', () => {
      this.closed = true
      for (const w of this.waiters.splice(0)) w()
    })
  }

  static open(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${PROXY_PATH}`)
      ws.once('open', () => {
        resolve(new Client(ws))
      })
      ws.once('error', reject)
    })
  }

  private async until(check: () => boolean): Promise<void> {
    while (!check()) {
      if (this.closed) throw new Error('closed')
      await new Promise<void>((r) => this.waiters.push(r))
    }
  }

  async pdu(): Promise<RDCleanPathPdu> {
    let total = 0
    await this.until(() => {
      const d = detectPdu(this.buf)
      if (d.kind === 'detected' && this.buf.length >= d.totalLength) total = d.totalLength
      return total > 0
    })
    const pdu = decodePdu(this.buf.subarray(0, total))
    this.buf = this.buf.subarray(total)
    return pdu
  }

  async bytes(n: number): Promise<Buffer> {
    await this.until(() => this.buf.length >= n)
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  waitClosed(): Promise<void> {
    return this.until(() => this.closed).catch(() => undefined)
  }
}

const requestPdu = (token: string, x224 = connectionRequest()): Buffer =>
  encodePdu({
    version: RDCLEANPATH_VERSION,
    destination: 'attacker.example:3389',
    proxyAuth: token,
    x224ConnectionPdu: x224
  })

describe('RdpProxy (server RDP giả: X.224 + TLS)', () => {
  it('probe trả chứng chỉ server', async () => {
    const server = await fake()
    const info = await proxy().probe({ host: '127.0.0.1', port: server.port })
    expect(info.cert.subject).toContain('fake-rdp-a.test')
    expect(info.cert.selfSigned).toBe(true)
    expect(info.cert.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(server.requests[0]?.[5]).toBe(0xe0)
  })

  it('RDCleanPath đầy đủ: phản hồi X.224 + chuỗi chứng chỉ, rồi chuyển byte hai chiều', async () => {
    const server = await fake()
    const p = proxy()
    const target = { host: '127.0.0.1', port: server.port }
    const { fingerprint } = (await p.probe(target)).cert
    const { port, token } = await p.open(target, fingerprint)
    const client = await Client.open(port)
    // Gửi yêu cầu chia hai frame + byte RDP tới sớm ngay sau (proxy phải giữ lại, không làm rơi).
    const req = requestPdu(token)
    client.ws.send(req.subarray(0, 10))
    client.ws.send(Buffer.concat([req.subarray(10), Buffer.from('early')]))
    const res = await client.pdu()
    expect(res.error).toBeUndefined()
    expect(res.x224ConnectionPdu?.[5]).toBe(0xd0)
    const leaf = res.serverCertChain?.[0]
    expect(leaf).toBeDefined()
    expect(new X509Certificate(leaf ?? Buffer.alloc(0)).fingerprint256).toBe(fingerprint)
    expect(res.serverAddr).toBe(`127.0.0.1:${server.port}`)
    expect((await client.bytes(5)).toString()).toBe('early')
    const big = Buffer.alloc(3 * 1024 * 1024, 0x5a)
    client.ws.send(big)
    expect((await client.bytes(big.length)).equals(big)).toBe(true)
    // Server đóng → proxy đóng WebSocket.
    client.ws.send(Buffer.from('bye'))
    await client.waitClosed()
    await expect.poll(() => p.activeConnections).toBe(0)
  })

  it('sửa cờ hiệu năng / autologon trong Client Info; gom dữ liệu server thành ít message', async () => {
    const server = await fake()
    const logs: string[] = []
    const p = proxy(undefined, logs)
    const target = { host: '127.0.0.1', port: server.port }
    const { fingerprint } = (await p.probe(target)).cert
    const { port, token } = await p.open(target, fingerprint, {
      performanceFlags: 0x25,
      autologon: true
    })
    const client = await Client.open(port)
    client.ws.send(requestPdu(token))
    expect((await client.pdu()).error).toBeUndefined()
    let messages = 0
    client.ws.on('message', () => {
      messages++
    })
    // Bắt tay CredSSP (không phải TPKT) đi nguyên vẹn, rồi Client Info (server giả trả lại y nguyên).
    const credssp = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x06])
    client.ws.send(credssp)
    expect((await client.bytes(credssp.length)).equals(credssp)).toBe(true)
    const info = clientInfoPdu({ password: 'pw', perf: 0x86 })
    client.ws.send(info)
    const echoed = await client.bytes(info.length)
    const f = findClientInfo(echoed)
    expect(f?.performanceFlags).toBe(0x25)
    expect((f?.flags ?? 0) & 0x8).toBe(0x8)
    expect(logs.some((l) => l.includes('performance flags 0x86 → 0x25, autologon'))).toBe(true)
    // PDU sau không bị đụng tới.
    const again = clientInfoPdu({ password: 'pw', perf: 0x86 })
    client.ws.send(again)
    expect((await client.bytes(again.length)).equals(again)).toBe(true)
    // 200 lần ghi nhỏ liền nhau của server → ít message WebSocket hơn nhiều.
    messages = 0
    for (let i = 0; i < 200; i++) client.ws.send(Buffer.alloc(100, i))
    await client.bytes(200 * 100)
    expect(messages).toBeLessThan(200)
  })

  it('token sai / đã dùng → 401; proxy bỏ qua destination của client (không relay mở)', async () => {
    const server = await fake()
    const p = proxy()
    const target = { host: '127.0.0.1', port: server.port }
    const { fingerprint } = (await p.probe(target)).cert
    const { port, token } = await p.open(target, fingerprint)

    const bad = await Client.open(port)
    bad.ws.send(requestPdu('not-a-token'))
    expect((await bad.pdu()).error).toEqual({ errorCode: 1, httpStatusCode: 401 })
    await bad.waitClosed()

    const ok = await Client.open(port)
    ok.ws.send(requestPdu(token))
    expect((await ok.pdu()).serverAddr).toBe(`127.0.0.1:${server.port}`)
    ok.ws.close()

    const reuse = await Client.open(port)
    reuse.ws.send(requestPdu(token))
    expect((await reuse.pdu()).error?.httpStatusCode).toBe(401)
  })

  it('token hết hạn', async () => {
    let now = 1_000
    const p = new RdpProxy({
      dial: createDialer({ sshClient: () => Promise.resolve(null) }),
      log: () => undefined,
      tokenTtlMs: 1_000,
      now: () => now
    })
    cleanups.push(() => {
      p.close()
    })
    const { port, token } = await p.open({ host: '127.0.0.1', port: 1 }, 'AA')
    now += 5_000
    const c = await Client.open(port)
    c.ws.send(requestPdu(token))
    expect((await c.pdu()).error?.httpStatusCode).toBe(401)
  })

  it('chứng chỉ khác dấu đã tin → TLS alert 42, không chuyển gì', async () => {
    const server = await fake()
    const p = proxy()
    const target = { host: '127.0.0.1', port: server.port }
    const { fingerprint } = (await p.probe(target)).cert
    server.setCert('b')
    const { port, token } = await p.open(target, fingerprint)
    const c = await Client.open(port)
    c.ws.send(requestPdu(token))
    expect((await c.pdu()).error).toEqual({ errorCode: 1, tlsAlertCode: 42 })
    await c.waitClosed()
  })

  it('server từ chối thương lượng → lỗi negotiation kèm X.224 của server', async () => {
    const server = await fake({ negotiation: 'failure' })
    const p = proxy()
    await expect(p.probe({ host: '127.0.0.1', port: server.port })).rejects.toThrow(/CredSSP/)
    const { port, token } = await p.open({ host: '127.0.0.1', port: server.port }, 'AA')
    const c = await Client.open(port)
    c.ws.send(requestPdu(token))
    const res = await c.pdu()
    expect(res.error?.errorCode).toBe(2)
    expect(res.x224ConnectionPdu?.[11]).toBe(3)
  })

  it('server chỉ có RDP security cũ → báo không hỗ trợ', async () => {
    const server = await fake({ negotiation: 'legacy' })
    await expect(proxy().probe({ host: '127.0.0.1', port: server.port })).rejects.toThrow(
      /legacy RDP security/
    )
  })

  it('cổng đóng → lỗi WSA 10061 / thông báo dễ hiểu', async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const a = s.address()
        s.close(() => {
          resolve(typeof a === 'object' && a ? a.port : 1)
        })
      })
    })
    const p = proxy()
    await expect(p.probe({ host: '127.0.0.1', port: closed })).rejects.toThrow(
      /refused the connection/
    )
    const { port, token } = await p.open({ host: '127.0.0.1', port: closed }, 'AA')
    const c = await Client.open(port)
    c.ws.send(requestPdu(token))
    expect((await c.pdu()).error?.wsaLastError).toBe(10061)
  })

  it('yêu cầu không phải X.224 CR → 400; byte rác → đóng', async () => {
    const server = await fake()
    const p = proxy()
    const { port, token } = await p.open({ host: '127.0.0.1', port: server.port }, 'AA')
    const c = await Client.open(port)
    c.ws.send(requestPdu(token, Buffer.from('GET / HTTP/1.1\r\n\r\n')))
    expect((await c.pdu()).error?.httpStatusCode).toBe(400)
    expect(server.requests).toHaveLength(0)
    const junk = await Client.open(port)
    junk.ws.send(Buffer.from('hello'))
    await junk.waitClosed()
  })

  it('chỉ nghe 127.0.0.1, sai đường dẫn bị từ chối', async () => {
    const p = proxy()
    const { port } = await p.open({ host: '127.0.0.1', port: 1 }, 'AA')
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/other`)
        ws.once('open', resolve)
        ws.once('error', reject)
      })
    ).rejects.toThrow()
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${PROXY_PATH}`, {
          origin: 'https://evil.example'
        })
        ws.once('open', resolve)
        ws.once('error', reject)
      })
    ).rejects.toThrow()
    // Không nghe trên địa chỉ khác của máy (thử qua ::1 nếu có).
    const v6 = await new Promise<boolean>((resolve) => {
      const s = netConnect({ host: '::1', port }, () => {
        s.destroy()
        resolve(true)
      })
      s.on('error', () => {
        resolve(false)
      })
    })
    expect(v6).toBe(false)
  })
})

const der = (pem: string): Buffer => new X509Certificate(pem).raw

/**
 * Giả BoringSSL (Node của Electron): bắt tay kiểu mặc định với chứng chỉ thiếu digitalSignature →
 * KEY_USAGE_BIT_INCORRECT. OpenSSL của Node trong Vitest không kiểm keyUsage nên phải giả lập; e2e
 * (rdp-view.spec.ts) kiểm với BoringSSL thật.
 */
const boringTls: typeof startTls = async (socket, host, timeoutMs, mode) => {
  const tls = await startTls(socket, host, timeoutMs, mode)
  const leaf = tls.getPeerCertificate().raw
  if (mode !== 'legacy-rsa' && needsLegacyRsa(leaf)) {
    tls.destroy()
    throw Object.assign(
      new Error('error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT'),
      { code: 'ERR_SSL_KEY_USAGE_BIT_INCORRECT' }
    )
  }
  return tls
}

describe('RdpProxy: chứng chỉ RDP mặc định của Windows (thiếu digitalSignature)', () => {
  it('đọc keyUsage của chứng chỉ', () => {
    expect(keyUsageOf(der(fakeCertPem('legacy')))).toEqual({
      digitalSignature: false,
      keyEncipherment: true
    })
    expect(needsLegacyRsa(der(fakeCertPem('legacy')))).toBe(true)
    // Không có extension keyUsage → dùng được cho mọi việc.
    expect(keyUsageOf(der(fakeCertPem('a')))).toBeNull()
    expect(needsLegacyRsa(der(fakeCertPem('a')))).toBe(false)
    expect(keyUsageOf(Buffer.from('not a certificate'))).toBeNull()
    expect(isKeyUsageError({ code: 'ERR_SSL_KEY_USAGE_BIT_INCORRECT' })).toBe(true)
    expect(
      isKeyUsageError(
        new Error('1:error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT')
      )
    ).toBe(true)
    expect(isKeyUsageError({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' })).toBe(false)
  })

  it('lỗi key usage → làm lại X.224 + TLS 1.2 trao đổi khoá RSA; nhớ cho lần sau; cùng chứng chỉ', async () => {
    const server = await fake({ cert: 'legacy' })
    const logs: string[] = []
    const p = proxy(boringTls, logs)
    const target = { host: '127.0.0.1', port: server.port }
    const probe = await p.probe(target)
    expect(probe.tls).toMatchObject({ protocol: 'TLSv1.2', legacyRsa: true })
    expect(probe.tls.cipher).toMatch(/^TLS_RSA_WITH_AES/)
    expect(probe.cert.subject).toContain('fake-rdp-legacy.test')
    // Hai lượt X.224: lượt đầu chết ở TLS, lượt hai thương lượng lại từ đầu.
    expect(server.requests).toHaveLength(2)
    expect(server.handshakes.at(-1)).toMatchObject({ protocol: 'TLSv1.2' })
    expect(server.handshakes.at(-1)?.cipher).not.toMatch(/ECDHE|DHE/)
    expect(logs.join('\n')).toMatch(/RSA key exchange/)

    // Kết nối thật: đã nhớ đích → một lượt X.224 + TLS; chứng chỉ khớp dấu đã tin.
    const { port, token } = await p.open(target, probe.cert.fingerprint)
    const client = await Client.open(port)
    client.ws.send(requestPdu(token))
    const res = await client.pdu()
    expect(res.error).toBeUndefined()
    expect(res.serverCertChain?.[0]).toEqual(der(fakeCertPem('legacy')))
    expect(server.requests).toHaveLength(3)
    client.ws.send(Buffer.from('ping'))
    expect((await client.bytes(4)).toString()).toBe('ping')
    client.ws.close()
  })

  it('kết nối thẳng (chưa probe) cũng tự lùi; chứng chỉ khác dấu đã tin vẫn bị từ chối', async () => {
    const server = await fake({ cert: 'legacy' })
    const pin = (await proxy(boringTls).probe({ host: '127.0.0.1', port: server.port })).cert
      .fingerprint
    const p = proxy(boringTls)
    const target = { host: '127.0.0.1', port: server.port }
    const ok = await p.open(target, pin)
    const c1 = await Client.open(ok.port)
    c1.ws.send(requestPdu(ok.token))
    expect((await c1.pdu()).error).toBeUndefined()
    c1.ws.close()
    const bad = await p.open(target, 'AA')
    const c2 = await Client.open(bad.port)
    c2.ws.send(requestPdu(bad.token))
    expect((await c2.pdu()).error).toEqual({ errorCode: 1, tlsAlertCode: 42 })
  })

  it('không lùi khi lỗi TLS khác; lỗi key usage không khớp chứng chỉ thật → dừng (chống ép hạ cấp)', async () => {
    const server = await fake({ cert: 'a' })
    const target = { host: '127.0.0.1', port: server.port }
    let calls = 0
    const otherError: typeof startTls = () => {
      calls++
      return Promise.reject(
        Object.assign(new Error('wrong version'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' })
      )
    }
    await expect(proxy(otherError).probe(target)).rejects.toThrow(/wrong version/)
    expect(calls).toBe(1)

    // Kẻ đứng giữa gây lỗi key usage, nhưng chứng chỉ server thật không cần trao đổi khoá RSA.
    const forged: typeof startTls = async (socket, host, timeoutMs, mode) => {
      if (mode !== 'legacy-rsa')
        throw Object.assign(new Error('KEY_USAGE_BIT_INCORRECT'), {
          code: 'ERR_SSL_KEY_USAGE_BIT_INCORRECT'
        })
      return startTls(socket, host, timeoutMs, 'modern')
    }
    const p = proxy(forged)
    await expect(p.probe(target)).rejects.toThrow(/possible interception/)
    const pin = (await proxy().probe(target)).cert.fingerprint
    const { port, token } = await p.open(target, pin)
    const c = await Client.open(port)
    c.ws.send(requestPdu(token))
    expect((await c.pdu()).error).toEqual({ errorCode: 1, tlsAlertCode: 40 })
  })

  it('đã nhớ cần RSA nhưng server đổi sang chứng chỉ thường → quay lại bắt tay mặc định', async () => {
    const server = await fake({ cert: 'legacy' })
    const p = proxy(boringTls)
    const target = { host: '127.0.0.1', port: server.port }
    expect((await p.probe(target)).tls.legacyRsa).toBe(true)
    server.setCert('a')
    const again = await p.probe(target)
    expect(again.tls.legacyRsa).toBe(false)
    expect(again.cert.subject).toContain('fake-rdp-a.test')
  })
})
