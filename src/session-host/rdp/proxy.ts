import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { t } from '@shared/i18n'
import type { RdpCertInfo, RdpViewTarget } from '@shared/rdp-viewer'
import {
  detectPdu,
  errorPdu,
  negotiationErrorPdu,
  parseRequest,
  responsePdu,
  type RDCleanPathError
} from './rdcleanpath'
import { certInfo, peerChain, startTls, tlsAlertOf } from './tls'
import {
  PROTOCOL_RDP,
  connectionRequest,
  isConnectionRequest,
  parseConnectionConfirm,
  readTpkt
} from './x224'

/** Mở luồng byte tới server RDP (TCP thẳng hoặc kênh direct-tcpip của phiên SSH). */
export type Dialer = (target: RdpViewTarget) => Promise<Duplex & { remoteAddress?: string }>

export interface RdpProxyOptions {
  dial: Dialer
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  /** Token phải được dùng trong khoảng này (WASM nạp + kết nối mất vài giây). */
  tokenTtlMs?: number
  handshakeTimeoutMs?: number
  /** Không còn token / kết nối nào trong khoảng này → đóng cổng nghe. */
  idleCloseMs?: number
  now?: () => number
}

interface Grant {
  target: RdpViewTarget
  /** Dấu SHA-256 người dùng đã tin — chứng chỉ khác → từ chối (không chuyển mật khẩu cho ai khác). */
  pin: string
  expiresAt: number
}

/** Đường dẫn WebSocket — có thêm một lớp kiểm (client lạ gõ nhầm cổng không vào được). */
export const PROXY_PATH = '/rdcleanpath'
const MAX_GRANTS = 64
const MAX_CONNECTIONS = 32
/** Ngưỡng dừng đọc từ server khi renderer chưa nhận kịp (backpressure). */
const HIGH_WATER = 4 * 1024 * 1024
const LOW_WATER = 1024 * 1024

class ProxyFailure extends Error {
  constructor(
    message: string,
    readonly pdu: Buffer
  ) {
    super(message)
  }
}

/** Mã lỗi Windows Sockets cho client hiển thị lý do (RDCleanPath truyền dạng WSA). */
function wsaOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code
  const map: Record<string, number> = {
    ECONNREFUSED: 10061,
    ETIMEDOUT: 10060,
    ECONNRESET: 10054,
    EHOSTUNREACH: 10065,
    ENETUNREACH: 10051,
    EHOSTDOWN: 10064,
    ENOTFOUND: 11001,
    EAI_AGAIN: 11002
  }
  return typeof code === 'string' ? map[code] : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Thông báo dễ hiểu cho lỗi kết nối TCP / SSH. */
export function dialErrorMessage(target: RdpViewTarget, error: unknown): string {
  const address = `${target.host}:${target.port}`
  switch (wsaOf(error)) {
    case 10061:
      return t('{address} refused the connection — is Remote Desktop enabled?', { address })
    case 10060:
      return t('Timed out connecting to {address}', { address })
    case 11001:
    case 11002:
      return t('Could not resolve {host}', { host: target.host })
    case 10065:
    case 10051:
    case 10064:
      return t('{address} is unreachable', { address })
    default:
      return t('Could not connect to {address}: {reason}', { address, reason: errorText(error) })
  }
}

/** [MS-RDPBCGR] 2.2.1.2.2 — lý do server từ chối thương lượng. */
export function negotiationFailureMessage(code: number): string {
  switch (code) {
    case 1:
      return t('The server requires TLS but it is not configured correctly')
    case 2:
      return t('The server only allows legacy RDP security, which is not supported')
    case 3:
      return t('The server has no TLS certificate')
    case 5:
      return t('The server requires Network Level Authentication (CredSSP)')
    case 6:
      return t('The server requires TLS with client certificate authentication')
    default:
      return t('The server rejected the connection settings (code {code})', { code })
  }
}

function serverAddress(
  socket: { remoteAddress?: string; remotePort?: number },
  port: number
): string {
  const ip = socket.remoteAddress ?? '127.0.0.1'
  return ip.includes(':')
    ? `[${ip}]:${socket.remotePort ?? port}`
    : `${ip}:${socket.remotePort ?? port}`
}

/**
 * Proxy RDCleanPath: WebSocket chỉ nghe 127.0.0.1 (cổng ngẫu nhiên), mỗi kết nối phải mang token
 * dùng-một-lần do main cấp cho đúng một host. Proxy chỉ kết nối tới đích gắn với token (bỏ qua
 * `destination` client gửi — không phải relay mở), kiểm chứng chỉ TLS theo dấu đã tin, rồi chuyển
 * byte hai chiều có backpressure.
 */
export class RdpProxy {
  private server: WebSocketServer | null = null
  private listening: Promise<number> | null = null
  private readonly grants = new Map<string, Grant>()
  private readonly connections = new Set<WebSocket>()
  private idleTimer: NodeJS.Timeout | null = null
  private readonly ttl: number
  private readonly handshakeTimeout: number
  private readonly idleClose: number
  private readonly now: () => number

  constructor(private readonly opts: RdpProxyOptions) {
    this.ttl = opts.tokenTtlMs ?? 60_000
    this.handshakeTimeout = opts.handshakeTimeoutMs ?? 15_000
    this.idleClose = opts.idleCloseMs ?? 60_000
    this.now = opts.now ?? Date.now
  }

  get activeConnections(): number {
    return this.connections.size
  }

  /** Dò chứng chỉ server (TCP → X.224 → TLS), không giữ kết nối. */
  async probe(target: RdpViewTarget): Promise<RdpCertInfo> {
    let socket: Duplex
    try {
      socket = await this.opts.dial(target)
    } catch (error) {
      throw new Error(dialErrorMessage(target, error), { cause: error })
    }
    let tls: TLSSocket | null = null
    try {
      socket.write(connectionRequest())
      const confirm = parseConnectionConfirm(await readTpkt(socket, this.handshakeTimeout))
      if (confirm.kind === 'failure') throw new Error(negotiationFailureMessage(confirm.code))
      if (confirm.kind === 'legacy' || confirm.protocol === PROTOCOL_RDP)
        throw new Error(negotiationFailureMessage(2))
      tls = await startTls(socket, target.host, this.handshakeTimeout)
      const leaf = peerChain(tls)[0]
      if (!leaf) throw new Error(t('The server did not send a TLS certificate'))
      return certInfo(leaf)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('timed out'))
        throw new Error(t('The server did not answer the Remote Desktop handshake'), {
          cause: error
        })
      throw error
    } finally {
      tls?.destroy()
      socket.destroy()
    }
  }

  /** Cấp token cho một phiên (đích + dấu chứng chỉ đã tin). Trả cổng nghe + token. */
  async open(target: RdpViewTarget, pin: string): Promise<{ port: number; token: string }> {
    this.sweep()
    if (this.grants.size >= MAX_GRANTS)
      throw new Error(t('Too many pending Remote Desktop connections'))
    const port = await this.listen()
    const token = randomBytes(32).toString('base64url')
    this.grants.set(token, { target, pin, expiresAt: this.now() + this.ttl })
    this.scheduleIdle()
    return { port, token }
  }

  close(): void {
    this.grants.clear()
    for (const ws of this.connections) ws.terminate()
    this.connections.clear()
    this.stopServer()
  }

  private sweep(): void {
    const now = this.now()
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token)
  }

  private listen(): Promise<number> {
    if (this.listening) return this.listening
    this.listening = new Promise<number>((resolve, reject) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        path: PROXY_PATH,
        perMessageDeflate: false,
        maxPayload: 16 * 1024 * 1024,
        verifyClient: (info: { origin: string; req: IncomingMessage }) => allowedOrigin(info.origin)
      })
      server.once('listening', () => {
        resolve((server.address() as AddressInfo).port)
      })
      server.once('error', (error) => {
        this.listening = null
        this.server = null
        reject(error)
      })
      server.on('connection', (ws) => {
        if (this.connections.size >= MAX_CONNECTIONS) {
          ws.close(1013)
          return
        }
        this.connections.add(ws)
        this.cancelIdle()
        ws.once('close', () => {
          this.connections.delete(ws)
          this.scheduleIdle()
        })
        void this.handle(ws)
      })
      this.server = server
    })
    return this.listening
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private scheduleIdle(): void {
    this.cancelIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.sweep()
      if (this.grants.size === 0 && this.connections.size === 0) this.stopServer()
      else this.scheduleIdle()
    }, this.idleClose)
    this.idleTimer.unref()
  }

  private stopServer(): void {
    this.cancelIdle()
    this.server?.close()
    this.server = null
    this.listening = null
  }

  private async handle(ws: WebSocket): Promise<void> {
    let socket: (Duplex & { remoteAddress?: string; remotePort?: number }) | null = null
    let tls: TLSSocket | null = null
    // Một listener suốt vòng đời: gom PDU yêu cầu → giữ byte tới sớm trong lúc bắt tay với server
    // → chuyển thẳng sang TLS. Không có khoảng nào frame bị rơi vì chưa ai nghe.
    const inbound = new Inbound(ws, this.handshakeTimeout)
    try {
      const pdu = await inbound.request
      let request
      try {
        request = parseRequest(pdu)
      } catch (error) {
        throw new ProxyFailure(
          `bad request: ${errorText(error)}`,
          errorPdu({ httpStatusCode: 400 })
        )
      }
      this.sweep()
      const grant = this.grants.get(request.proxyAuth)
      // Dùng một lần: xoá ngay cả khi các bước sau lỗi.
      this.grants.delete(request.proxyAuth)
      if (!grant)
        throw new ProxyFailure('invalid or expired token', errorPdu({ httpStatusCode: 401 }))
      if (!isConnectionRequest(request.x224))
        throw new ProxyFailure('not an X.224 Connection Request', errorPdu({ httpStatusCode: 400 }))
      const { target } = grant
      try {
        socket = await this.opts.dial(target)
      } catch (error) {
        const wsa = wsaOf(error)
        throw new ProxyFailure(
          `connect failed: ${errorText(error)}`,
          errorPdu(wsa !== undefined ? { wsaLastError: wsa } : { httpStatusCode: 502 })
        )
      }
      if (inbound.isClosed()) throw new Error('client went away')
      socket.write(request.x224)
      let confirmRaw: Buffer
      try {
        confirmRaw = await readTpkt(socket, this.handshakeTimeout)
      } catch (error) {
        throw new ProxyFailure(`X.224: ${errorText(error)}`, errorPdu({ httpStatusCode: 502 }))
      }
      const confirm = parseConnectionConfirm(confirmRaw)
      if (confirm.kind === 'failure')
        throw new ProxyFailure(
          `negotiation failure ${confirm.code}`,
          negotiationErrorPdu(confirmRaw)
        )
      if (confirm.kind === 'legacy' || confirm.protocol === PROTOCOL_RDP)
        throw new ProxyFailure(
          'server selected legacy RDP security',
          errorPdu({ httpStatusCode: 502 })
        )
      try {
        tls = await startTls(socket, target.host, this.handshakeTimeout)
      } catch (error) {
        throw new ProxyFailure(
          `TLS: ${errorText(error)}`,
          errorPdu({ tlsAlertCode: tlsAlertOf(error) })
        )
      }
      const chain = peerChain(tls)
      const leaf = chain[0]
      const fingerprint = leaf ? certInfo(leaf).fingerprint : null
      if (!leaf || fingerprint !== grant.pin)
        // 42 = bad certificate: renderer hiểu là chứng chỉ đổi kể từ lúc dò → dò / hỏi lại.
        throw new ProxyFailure(
          'certificate does not match the trusted one',
          errorPdu({ tlsAlertCode: 42 })
        )
      if (inbound.isClosed()) throw new Error('client went away')
      ws.send(responsePdu(serverAddress(socket, target.port), confirmRaw, chain))
      this.pipe(ws, tls, inbound, `${target.host}:${target.port}`)
    } catch (error) {
      inbound.dispose()
      const failure = error instanceof ProxyFailure ? error : null
      this.opts.log('warn', `RDP proxy: ${failure ? failure.message : errorText(error)}`)
      if (failure && ws.readyState === ws.OPEN) ws.send(failure.pdu)
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000)
      tls?.destroy()
      socket?.destroy()
    }
  }

  private pipe(ws: WebSocket, tls: TLSSocket, inbound: Inbound, label: string): void {
    let up = 0
    let down = 0
    let closed = false
    const shutdown = (reason: string): void => {
      if (closed) return
      closed = true
      inbound.dispose()
      tls.destroy()
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000)
      this.opts.log('info', `RDP proxy: ${label} closed (${reason}; up ${up} B, down ${down} B)`)
    }
    inbound.attach(
      (chunk) => {
        up += chunk.length
        if (!tls.write(chunk)) {
          ws.pause()
          tls.once('drain', () => {
            ws.resume()
          })
        }
      },
      (reason) => {
        shutdown(reason)
      }
    )
    let paused = false
    tls.on('data', (chunk: Buffer) => {
      down += chunk.length
      ws.send(chunk, { binary: true }, () => {
        if (paused && ws.bufferedAmount < LOW_WATER) {
          paused = false
          tls.resume()
        }
      })
      if (!paused && ws.bufferedAmount > HIGH_WATER) {
        paused = true
        tls.pause()
      }
    })
    tls.on('end', () => {
      shutdown('server ended')
    })
    tls.on('close', () => {
      shutdown('server closed')
    })
    tls.on('error', (error: Error) => {
      shutdown(`server error: ${error.message}`)
    })
    ws.on('error', (error) => {
      shutdown(`client error: ${error.message}`)
    })
  }
}

/** Phía WebSocket của một kết nối: PDU yêu cầu, rồi byte RDP (giữ lại cho tới khi có TLS). */
class Inbound {
  readonly request: Promise<Buffer>
  private closed = false
  private buf: Buffer = Buffer.alloc(0)
  private phase: 'request' | 'hold' | 'pipe' = 'request'
  private held: Buffer[] = []
  private sink: ((chunk: Buffer) => void) | null = null
  private onEnd: ((reason: string) => void) | null = null
  private settle: { resolve: (pdu: Buffer) => void; reject: (error: Error) => void } | null = null
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly ws: WebSocket,
    timeoutMs: number
  ) {
    this.request = new Promise((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    this.timer = setTimeout(() => {
      this.fail(new Error('timed out waiting for the RDCleanPath request'))
    }, timeoutMs)
    ws.on('message', this.onMessage)
    ws.on('close', this.onClose)
  }

  private readonly onMessage = (data: RawData, isBinary: boolean): void => {
    if (!isBinary) {
      this.end('text frame')
      return
    }
    const chunk = toBuffer(data)
    if (this.phase === 'pipe') {
      this.sink?.(chunk)
      return
    }
    if (this.phase === 'hold') {
      this.held.push(chunk)
      // Client không được gửi nhiều trước khi nhận phản hồi RDCleanPath.
      if (this.held.reduce((n, b) => n + b.length, 0) > 1024 * 1024) this.end('too much early data')
      return
    }
    this.buf = Buffer.concat([this.buf, chunk])
    const detected = detectPdu(this.buf)
    if (detected.kind === 'failed') this.fail(new Error('invalid RDCleanPath request'))
    else if (detected.kind === 'detected' && this.buf.length >= detected.totalLength) {
      clearTimeout(this.timer)
      this.phase = 'hold'
      const rest = this.buf.subarray(detected.totalLength)
      if (rest.length > 0) this.held.push(rest)
      const pdu = this.buf.subarray(0, detected.totalLength)
      this.buf = Buffer.alloc(0)
      this.settle?.resolve(pdu)
      this.settle = null
    } else if (this.buf.length > 64 * 1024) this.fail(new Error('RDCleanPath request too large'))
  }

  private readonly onClose = (): void => {
    this.closed = true
    this.end('client closed')
  }

  private fail(error: Error): void {
    clearTimeout(this.timer)
    this.settle?.reject(error)
    this.settle = null
  }

  private end(reason: string): void {
    this.closed = true
    this.fail(new Error(reason))
    this.onEnd?.(reason)
  }

  isClosed(): boolean {
    return this.closed
  }

  /** Bắt đầu chuyển: xả byte đang giữ rồi chuyển thẳng. */
  attach(sink: (chunk: Buffer) => void, onEnd: (reason: string) => void): void {
    this.sink = sink
    this.onEnd = onEnd
    this.phase = 'pipe'
    for (const chunk of this.held.splice(0)) sink(chunk)
    if (this.closed) onEnd('client closed')
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.ws.off('message', this.onMessage)
    this.ws.off('close', this.onClose)
    this.held = []
    this.sink = null
    this.onEnd = null
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/**
 * Chỉ renderer của app (file:// → Origin "file://" hoặc "null"; bản dev: http://localhost) hoặc
 * client không gửi Origin. Trang web bất kỳ trong trình duyệt của máy không tự mở được (vẫn cần token).
 */
export function allowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null' || origin === 'file://') return true
  try {
    const url = new URL(origin)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    )
  } catch {
    return false
  }
}

export type { RDCleanPathError }
