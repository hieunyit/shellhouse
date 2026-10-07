import { connect, createServer, type Server, type Socket } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openTunnel, proxiedAgents } from '../../src/node-shared/proxy-tunnel'
import {
  bypassProxy,
  envProxy,
  isCertificateError,
  isProxyUrl,
  parseProxy,
  proxyFor,
  type NetworkSettings
} from '../../src/shared/proxy'

const net = (patch: Partial<NetworkSettings> = {}): NetworkSettings => ({
  proxyMode: 'system',
  proxyUrl: '',
  noProxy: 'localhost,127.0.0.1,::1',
  updatesInsecure: false,
  ...patch
})

describe('proxy: cấu hình', () => {
  it('URL proxy hợp lệ / không hợp lệ; tách user:pass, cổng mặc định', () => {
    expect(isProxyUrl('http://proxy:3128')).toBe(true)
    expect(isProxyUrl('socks5h://u:p@10.0.0.1')).toBe(true)
    expect(isProxyUrl('ftp://proxy:21')).toBe(false)
    expect(isProxyUrl('proxy:3128')).toBe(false)
    expect(parseProxy('http://a%40b:p%3Ax@proxy')).toMatchObject({
      protocol: 'http',
      host: 'proxy',
      port: 8080,
      username: 'a@b',
      password: 'p:x'
    })
    expect(parseProxy('socks5://h')).toMatchObject({
      protocol: 'socks5',
      port: 1080,
      remoteDns: false
    })
    expect(parseProxy('socks5h://h:9')).toMatchObject({ port: 9, remoteDns: true })
  })

  it('NO_PROXY: *, tên, hậu tố, CIDR, host:port', () => {
    const list = '.corp.local, example.com, 10.0.0.0/8, s3.vn:9000'
    expect(bypassProxy('a.corp.local', 443, list)).toBe(true)
    expect(bypassProxy('corp.local', 443, list)).toBe(true)
    expect(bypassProxy('api.example.com', 443, list)).toBe(true)
    expect(bypassProxy('notexample.com', 443, list)).toBe(false)
    expect(bypassProxy('10.20.30.40', 6443, list)).toBe(true)
    expect(bypassProxy('11.0.0.1', 6443, list)).toBe(false)
    expect(bypassProxy('s3.vn', 9000, list)).toBe(true)
    expect(bypassProxy('s3.vn', 443, list)).toBe(false)
    expect(bypassProxy('anything', 1, '*')).toBe(true)
  })

  it('chọn proxy theo chế độ: system (biến môi trường), manual, none', () => {
    const env = { HTTPS_PROXY: 'proxy:3128', no_proxy: '.internal' }
    expect(envProxy(env, true)).toEqual({ url: 'http://proxy:3128', noProxy: '.internal' })
    expect(envProxy(env, false)).toBeNull()
    expect(proxyFor(net(), 's3.aws.com', 443, true, env)).toBe('http://proxy:3128')
    expect(proxyFor(net(), 'k8s.internal', 6443, true, env)).toBeNull()
    expect(proxyFor(net(), '127.0.0.1', 9000, true, env)).toBeNull()
    expect(proxyFor(net({ proxyMode: 'none' }), 's3.aws.com', 443, true, env)).toBeNull()
    const manual = net({ proxyMode: 'manual', proxyUrl: 'socks5://p:1080', noProxy: '.lan' })
    expect(proxyFor(manual, 's3.aws.com', 443, true, env)).toBe('socks5://p:1080')
    expect(proxyFor(manual, 'nas.lan', 443, true, env)).toBeNull()
    expect(proxyFor(net({ proxyMode: 'manual' }), 's3.aws.com', 443, true, env)).toBeNull()
  })

  it('nhận ra lỗi chứng chỉ', () => {
    expect(isCertificateError('self-signed certificate in certificate chain')).toBe(true)
    expect(isCertificateError('unable to verify the first certificate')).toBe(true)
    expect(isCertificateError('net::ERR_CERT_AUTHORITY_INVALID')).toBe(true)
    expect(isCertificateError('connect ECONNREFUSED')).toBe(false)
  })
})

/** Đích: server HTTP trả lời "ok <đường dẫn>". */
let target: ReturnType<typeof createHttpServer>
let targetPort = 0
/** Proxy HTTP CONNECT (yêu cầu Basic auth u:p). */
let httpProxy: Server
let httpProxyPort = 0
/** Proxy SOCKS5 không đăng nhập. */
let socksProxy: Server
let socksProxyPort = 0
const seen: string[] = []

function pipeTo(port: number, client: Socket, head: Buffer = Buffer.alloc(0)): void {
  const upstream = connect(port, '127.0.0.1', () => {
    if (head.length) upstream.write(head)
    client.pipe(upstream).pipe(client)
  })
  upstream.on('error', () => client.destroy())
}

beforeAll(async () => {
  target = createHttpServer((req, res) => {
    res.end(`ok ${req.url ?? ''}`)
  })
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  targetPort = (target.address() as AddressInfo).port

  httpProxy = createServer((client) => {
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      client.removeListener('data', onData)
      const head = buf.subarray(0, end).toString()
      seen.push(head.split('\r\n')[0] ?? '')
      const auth = `Basic ${Buffer.from('u:p').toString('base64')}`
      if (!head.includes(`Proxy-Authorization: ${auth}`)) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
        return
      }
      const port = Number(/CONNECT [^:]+:(\d+)/.exec(head)?.[1])
      client.write('HTTP/1.1 200 Connection established\r\n\r\n')
      pipeTo(port, client, buf.subarray(end + 4))
    }
    client.on('data', onData)
  })
  await new Promise<void>((r) => httpProxy.listen(0, '127.0.0.1', r))
  httpProxyPort = (httpProxy.address() as AddressInfo).port

  socksProxy = createServer((client) => {
    let stage = 0
    client.on('data', function onData(chunk: Buffer) {
      if (stage === 0) {
        stage = 1
        client.write(Buffer.from([5, 0]))
        return
      }
      client.removeListener('data', onData)
      // [5, 1, 0, atyp, ...addr, portHi, portLo]
      const atyp = chunk[3]
      const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : (chunk[4] ?? 0) + 1
      const port = chunk.readUInt16BE(4 + addrLen)
      const host = atyp === 3 ? chunk.subarray(5, 5 + addrLen - 1).toString() : 'ip'
      seen.push(`SOCKS ${host}:${String(port)}`)
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
      pipeTo(port, client)
    })
  })
  await new Promise<void>((r) => socksProxy.listen(0, '127.0.0.1', r))
  socksProxyPort = (socksProxy.address() as AddressInfo).port
})

afterAll(() => {
  target.close()
  httpProxy.close()
  socksProxy.close()
})

async function get(agent: import('node:http').Agent, path: string): Promise<string> {
  const { request } = await import('node:http')
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port: targetPort, path, agent }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => {
        resolve(body)
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('proxy: đường hầm', () => {
  it('HTTP CONNECT có đăng nhập', async () => {
    const { httpAgent } = proxiedAgents(`http://u:p@127.0.0.1:${String(httpProxyPort)}`, {})
    expect(await get(httpAgent, '/a')).toBe('ok /a')
    expect(seen).toContain(`CONNECT localhost:${String(targetPort)} HTTP/1.1`)
  })

  it('HTTP CONNECT sai mật khẩu → lỗi 407 rõ ràng', async () => {
    await expect(
      openTunnel(`http://u:wrong@127.0.0.1:${String(httpProxyPort)}`, 'localhost', targetPort)
    ).rejects.toThrow('requires authentication (407)')
  })

  it('SOCKS5 gửi tên miền cho proxy phân giải', async () => {
    const { httpAgent } = proxiedAgents(`socks5h://127.0.0.1:${String(socksProxyPort)}`, {})
    expect(await get(httpAgent, '/b')).toBe('ok /b')
    expect(seen).toContain(`SOCKS localhost:${String(targetPort)}`)
  })
})
