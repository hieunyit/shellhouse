import { Agent as HttpAgent, type AgentOptions } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { connect as netConnect, isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls'
import { parseProxy, type ParsedProxy } from '@shared/proxy'

/** Mở kết nối TCP thô tới (host, port) — mặc định net.connect; Kubernetes qua bastion dùng kênh SSH. */
export type RawConnect = (host: string, port: number) => Promise<Duplex>

const directConnect: RawConnect = (host, port) =>
  new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })

const TIMEOUT_MS = 20_000

/**
 * Đọc ở chế độ paused ('readable' + read()): phần thừa trả lại bằng unshift mà không bị phát mất
 * (ở chế độ flowing, unshift khi không còn listener 'data' sẽ làm rơi dữ liệu).
 */
function readUntil<T>(socket: Duplex, take: () => T | null): Promise<T> {
  return new Promise((resolve, reject) => {
    const onReadable = (): void => {
      try {
        const value = take()
        if (value !== null) {
          cleanup()
          resolve(value)
        }
      } catch (e) {
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error('The proxy closed the connection'))
    }
    const onError = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const cleanup = (): void => {
      socket.removeListener('readable', onReadable)
      socket.removeListener('end', onEnd)
      socket.removeListener('error', onError)
    }
    socket.on('readable', onReadable)
    socket.once('end', onEnd)
    socket.once('error', onError)
  })
}

/** Đọc tới khi có `\r\n\r\n` (header phản hồi CONNECT); phần dư sau header trả lại luồng. */
function readHead(socket: Duplex): Promise<string> {
  let buf = Buffer.alloc(0)
  return readUntil(socket, () => {
    let chunk: Buffer | null
    while ((chunk = socket.read() as Buffer | null) !== null) buf = Buffer.concat([buf, chunk])
    const end = buf.indexOf('\r\n\r\n')
    if (end >= 0) {
      if (end + 4 < buf.length) socket.unshift(buf.subarray(end + 4))
      return buf.subarray(0, end).toString('latin1')
    }
    if (buf.length > 64 * 1024) throw new Error('Proxy sent an invalid response')
    return null
  })
}

/** Đọc đúng `n` byte (bắt tay SOCKS). */
function readBytes(socket: Duplex, n: number): Promise<Buffer> {
  return readUntil(socket, () => socket.read(n) as Buffer | null)
}

async function httpConnect(
  socket: Duplex,
  p: ParsedProxy,
  host: string,
  port: number
): Promise<void> {
  const target = `${isIP(host) === 6 ? `[${host}]` : host}:${String(port)}`
  const auth =
    p.username !== undefined
      ? `Proxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password ?? ''}`).toString('base64')}\r\n`
      : ''
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
  const head = await readHead(socket)
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0)
  if (status === 407) throw new Error('The proxy requires authentication (407)')
  if (status < 200 || status > 299)
    throw new Error(
      `The proxy refused the connection to ${target} (${head.split('\r\n')[0] ?? ''})`
    )
}

const SOCKS_ERRORS: Record<number, string> = {
  1: 'general failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported'
}

async function socks5Connect(
  socket: Duplex,
  p: ParsedProxy,
  host: string,
  port: number
): Promise<void> {
  const withAuth = p.username !== undefined
  socket.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]))
  const [ver, method] = await readBytes(socket, 2)
  if (ver !== 5) throw new Error('Not a SOCKS5 proxy')
  if (method === 2) {
    const user = Buffer.from(p.username ?? '')
    const pass = Buffer.from(p.password ?? '')
    socket.write(
      Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass])
    )
    const [, ok] = await readBytes(socket, 2)
    if (ok !== 0) throw new Error('The SOCKS proxy rejected the username or password')
  } else if (method !== 0) throw new Error('The SOCKS proxy requires an unsupported login method')
  const kind = isIP(host)
  const addr =
    kind === 4
      ? Buffer.from([1, ...host.split('.').map(Number)])
      : kind === 6
        ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
        : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)])
  const portBuf = Buffer.alloc(2)
  portBuf.writeUInt16BE(port)
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portBuf]))
  const head = await readBytes(socket, 4)
  if (head[1] !== 0)
    throw new Error(`The SOCKS proxy could not connect: ${SOCKS_ERRORS[head[1] ?? 1] ?? 'error'}`)
  // Bỏ phần địa chỉ ràng buộc trong phản hồi.
  const atyp = head[3]
  const len = atyp === 1 ? 4 : atyp === 4 ? 16 : ((await readBytes(socket, 1))[0] ?? 0)
  await readBytes(socket, len + 2)
}

function ipv6Bytes(host: string): Buffer {
  const [head = '', tail = ''] = host.split('::')
  const a = head ? head.split(':') : []
  const b = tail ? tail.split(':') : []
  const parts = host.includes('::')
    ? [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b]
    : a
  const out = Buffer.alloc(16)
  parts.forEach((x, i) => out.writeUInt16BE(parseInt(x || '0', 16), i * 2))
  return out
}

/**
 * Kết nối tới (host, port) qua proxy: HTTP / HTTPS proxy bằng CONNECT, SOCKS5 (có / không đăng nhập).
 * `raw` mở kết nối tới chính proxy (thẳng, hoặc qua kênh SSH của bastion).
 */
export async function openTunnel(
  proxyUrl: string,
  host: string,
  port: number,
  raw: RawConnect = directConnect
): Promise<Duplex> {
  const p = parseProxy(proxyUrl)
  let socket = await raw(p.host, p.port)
  const timer = setTimeout(() => {
    socket.destroy(new Error(`The proxy ${p.host}:${String(p.port)} did not answer in time`))
  }, TIMEOUT_MS)
  try {
    if (p.protocol === 'https') {
      const tls = tlsConnect({ socket, servername: isIP(p.host) ? undefined : p.host })
      await new Promise<void>((resolve, reject) => {
        tls.once('secureConnect', resolve)
        tls.once('error', reject)
      })
      socket = tls
    }
    if (p.protocol === 'socks5') await socks5Connect(socket, p, host, port)
    else await httpConnect(socket, p, host, port)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Agent http / https đi qua proxy (cho AWS SDK…): mỗi kết nối mở đường hầm rồi bắt tay TLS với đích.
 * `tls`: tuỳ chọn TLS của đích (rejectUnauthorized…).
 */
export function proxiedAgents(
  proxyUrl: string | null,
  options: AgentOptions,
  tls: ConnectionOptions = {}
): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  if (!proxyUrl)
    return {
      httpAgent: new HttpAgent(options),
      httpsAgent: new HttpsAgent({ ...options, ...tls })
    }
  type Callback = (error: Error | null, socket?: Duplex) => void
  class TunnelHttpAgent extends HttpAgent {
    override createConnection(
      opts: { host?: string | null; port?: number | string | null },
      callback: Callback
    ): undefined {
      openTunnel(proxyUrl as string, opts.host ?? 'localhost', Number(opts.port) || 80).then(
        (s) => {
          callback(null, s)
        },
        (e: unknown) => {
          callback(e instanceof Error ? e : new Error(String(e)))
        }
      )
      return undefined
    }
  }
  class TunnelHttpsAgent extends HttpsAgent {
    override createConnection(
      opts: { host?: string | null; port?: number | string | null; servername?: string },
      callback: Callback
    ): undefined {
      const host = opts.host ?? 'localhost'
      openTunnel(proxyUrl as string, host, Number(opts.port) || 443).then(
        (raw) => {
          const socket = tlsConnect({
            ...tls,
            socket: raw,
            servername: opts.servername ?? (isIP(host) ? undefined : host)
          })
          // Lỗi trước khi bắt tay xong → báo cho agent; sau đó lỗi thuộc về request đang dùng socket.
          const onError = (e: Error): void => {
            callback(e)
          }
          socket.once('error', onError)
          socket.once('secureConnect', () => {
            socket.removeListener('error', onError)
            callback(null, socket)
          })
        },
        (e: unknown) => {
          callback(e instanceof Error ? e : new Error(String(e)))
        }
      )
      return undefined
    }
  }
  return {
    httpAgent: new TunnelHttpAgent(options),
    httpsAgent: new TunnelHttpsAgent({ ...options, ...tls })
  }
}
