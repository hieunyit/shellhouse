import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { t } from '@shared/i18n'
import type { RdpProbe, RdpSessionTuning, RdpViewTarget } from '@shared/rdp-viewer'
import { BitmapFixer } from './bitmap-fix'
import { ClientInfoRewriter } from './client-info'
import {
  detectPdu,
  errorPdu,
  negotiationErrorPdu,
  parseRequest,
  responsePdu,
  type RDCleanPathError
} from './rdcleanpath'
import {
  certInfo,
  isKeyUsageError,
  needsLegacyRsa,
  peerChain,
  startTls,
  tlsAlertOf,
  tlsInfo,
  type TlsMode
} from './tls'
import {
  PROTOCOL_RDP,
  connectionRequest,
  isConnectionRequest,
  parseConnectionConfirm,
  readTpkt
} from './x224'

/** Mở luồng byte tới server RDP (TCP thẳng hoặc kênh direct-tcpip của phiên SSH). */
export type Dialer = (target: RdpViewTarget) => Promise<Socket>
type Socket = Duplex & { remoteAddress?: string; remotePort?: number }

export interface RdpProxyOptions {
  dial: Dialer
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  /** Token phải được dùng trong khoảng này (WASM nạp + kết nối mất vài giây). */
  tokenTtlMs?: number
  handshakeTimeoutMs?: number
  /** Không còn token / kết nối nào trong khoảng này → đóng cổng nghe. */
  idleCloseMs?: number
  now?: () => number
  /** Thay bắt tay TLS (test giả lỗi chỉ BoringSSL mới có). */
  startTls?: typeof startTls
}

/** Kết nối tới server đã xong X.224 + TLS. */
interface Link {
  socket: Socket
  tls: TLSSocket
  /** X.224 Connection Confirm của lượt kết nối thành công (gửi lại cho client). */
  confirmRaw: Buffer
  mode: TlsMode
}

/** Lỗi ở một bước bắt tay với server — probe và proxy dịch ra thông báo / PDU khác nhau. */
class StageError extends Error {
  readonly confirmRaw: Buffer | undefined
  readonly code: number | undefined
  constructor(
    readonly stage: 'dial' | 'x224' | 'negotiation' | 'legacy' | 'tls' | 'downgrade',
    readonly error: unknown,
    extra: { confirmRaw?: Buffer; code?: number } = {}
  ) {
    super(errorText(error))
    this.confirmRaw = extra.confirmRaw
    this.code = extra.code
  }
}

interface Grant {
  target: RdpViewTarget
  /** Dấu SHA-256 người dùng đã tin — chứng chỉ khác → từ chối (không chuyển mật khẩu cho ai khác). */
  pin: string
  expiresAt: number
  tuning: RdpSessionTuning | undefined
}

/** Đường dẫn WebSocket — có thêm một lớp kiểm (client lạ gõ nhầm cổng không vào được). */
export const PROXY_PATH = '/rdcleanpath'
const MAX_GRANTS = 64
const MAX_CONNECTIONS = 32
/** Số đích nhớ là cần TLS 1.2 + trao đổi khoá RSA. */
const MAX_LEGACY_TARGETS = 256
/** Ngưỡng dừng đọc từ server khi renderer chưa nhận kịp (backpressure). */
const HIGH_WATER = 4 * 1024 * 1024
const LOW_WATER = 1024 * 1024
/**
 * Gom dữ liệu server trong cùng một lượt event loop thành một message WebSocket (tối đa ngần này):
 * TLS trả từng record ≤ 16 KB, mỗi message là một task + một lượt đánh thức WASM ở renderer.
 */
const BATCH_BYTES = 64 * 1024

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

export function downgradeMessage(): string {
  return t(
    'The TLS handshake with the server was inconsistent (possible interception) — connection stopped'
  )
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
  /** Đích (host:port) có chứng chỉ chỉ dùng được với trao đổi khoá RSA — bỏ lượt bắt tay hỏng. */
  private readonly legacyTargets = new Set<string>()
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
  async probe(target: RdpViewTarget): Promise<RdpProbe> {
    let link: Link | null = null
    try {
      link = await this.establish(target, connectionRequest(), () => true)
      const leaf = peerChain(link.tls)[0]
      if (!leaf) throw new Error(t('The server did not send a TLS certificate'))
      return { cert: certInfo(leaf), tls: tlsInfo(link.tls, link.mode) }
    } catch (error) {
      if (!(error instanceof StageError)) throw error
      const cause = error.error
      switch (error.stage) {
        case 'dial':
          throw new Error(dialErrorMessage(target, cause), { cause: error })
        case 'negotiation':
          throw new Error(negotiationFailureMessage(error.code ?? 0), { cause: error })
        case 'legacy':
          throw new Error(negotiationFailureMessage(2), { cause: error })
        case 'downgrade':
          throw new Error(downgradeMessage(), { cause: error })
        default:
          if (cause instanceof Error && cause.message.startsWith('timed out'))
            throw new Error(t('The server did not answer the Remote Desktop handshake'), {
              cause: error
            })
          throw cause
      }
    } finally {
      link?.tls.destroy()
      link?.socket.destroy()
    }
  }

  /**
   * TCP → X.224 → TLS tới đích. Chứng chỉ thiếu digitalSignature (mặc định của Windows) làm
   * BoringSSL từ chối bắt tay ECDHE/TLS 1.3 → làm lại từ đầu (socket cũ đã chết, phải thương lượng
   * X.224 lại) với TLS 1.2 + trao đổi khoá RSA, như mstsc. Chỉ lùi khi gặp đúng lỗi key usage và
   * chứng chỉ nhận được sau đó đúng là cần vậy; nhớ theo đích để lần sau bắt tay một lần.
   */
  private async establish(
    target: RdpViewTarget,
    x224: Buffer,
    alive: () => boolean
  ): Promise<Link> {
    const key = `${target.host}:${target.port}`
    let mode: TlsMode = this.legacyTargets.has(key) ? 'legacy-rsa' : 'modern'
    let fellBack = false
    // Tối đa: legacy (nhớ, nay hỏng) → modern (lỗi key usage) → legacy.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!alive()) throw new Error('client went away')
      const link = await this.connectOnce(target, x224, mode, alive)
      if ('error' in link) {
        if (mode === 'modern' && isKeyUsageError(link.error)) {
          this.opts.log(
            'info',
            `RDP proxy: ${key} certificate does not allow ECDHE key exchange (keyUsage) — retrying with TLS 1.2 RSA key exchange`
          )
          mode = 'legacy-rsa'
          fellBack = true
          continue
        }
        if (mode === 'legacy-rsa' && !fellBack) {
          // Server đã đổi (chứng chỉ / cấu hình) kể từ lần nhớ → thử lại kiểu mặc định.
          this.legacyTargets.delete(key)
          mode = 'modern'
          continue
        }
        throw new StageError('tls', link.error)
      }
      if (mode === 'modern') return link
      const leaf = peerChain(link.tls)[0]
      if (leaf && needsLegacyRsa(leaf)) {
        this.legacyTargets.add(key)
        if (this.legacyTargets.size > MAX_LEGACY_TARGETS) {
          const oldest = this.legacyTargets.values().next().value
          if (oldest !== undefined) this.legacyTargets.delete(oldest)
        }
        return link
      }
      link.tls.destroy()
      link.socket.destroy()
      if (fellBack)
        // Lỗi key usage không khớp chứng chỉ server thật dùng → có thể bị chèn giữa để ép hạ cấp.
        throw new StageError(
          'downgrade',
          new Error('key usage fallback did not match the certificate')
        )
      this.legacyTargets.delete(key)
      mode = 'modern'
    }
    throw new StageError('tls', new Error('TLS handshake failed'))
  }

  /** Một lượt TCP → X.224 → TLS. Lỗi TLS trả về (để quyết định lùi), các lỗi khác ném StageError. */
  private async connectOnce(
    target: RdpViewTarget,
    x224: Buffer,
    mode: TlsMode,
    alive: () => boolean
  ): Promise<Link | { error: unknown }> {
    let socket: Socket
    try {
      socket = await this.opts.dial(target)
    } catch (error) {
      throw new StageError('dial', error)
    }
    try {
      if (!alive()) throw new Error('client went away')
      socket.write(x224)
      let confirmRaw: Buffer
      try {
        confirmRaw = await readTpkt(socket, this.handshakeTimeout)
      } catch (error) {
        throw new StageError('x224', error)
      }
      const confirm = parseConnectionConfirm(confirmRaw)
      if (confirm.kind === 'failure')
        throw new StageError('negotiation', new Error(`negotiation failure ${confirm.code}`), {
          confirmRaw,
          code: confirm.code
        })
      if (confirm.kind === 'legacy' || confirm.protocol === PROTOCOL_RDP)
        throw new StageError('legacy', new Error('server selected legacy RDP security'))
      try {
        const tls = await (this.opts.startTls ?? startTls)(
          socket,
          target.host,
          this.handshakeTimeout,
          mode
        )
        return { socket, tls, confirmRaw, mode }
      } catch (error) {
        socket.destroy()
        return { error }
      }
    } catch (error) {
      socket.destroy()
      throw error
    }
  }

  /** Cấp token cho một phiên (đích + dấu chứng chỉ đã tin). Trả cổng nghe + token. */
  async open(
    target: RdpViewTarget,
    pin: string,
    tuning?: RdpSessionTuning
  ): Promise<{ port: number; token: string }> {
    this.sweep()
    if (this.grants.size >= MAX_GRANTS)
      throw new Error(t('Too many pending Remote Desktop connections'))
    const port = await this.listen()
    const token = randomBytes(32).toString('base64url')
    this.grants.set(token, { target, pin, expiresAt: this.now() + this.ttl, tuning })
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
    let socket: Socket | null = null
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
      let link: Link
      try {
        link = await this.establish(target, request.x224, () => !inbound.isClosed())
      } catch (error) {
        if (!(error instanceof StageError)) throw error
        const reason = errorText(error.error)
        switch (error.stage) {
          case 'dial': {
            const wsa = wsaOf(error.error)
            throw new ProxyFailure(
              `connect failed: ${reason}`,
              errorPdu(wsa !== undefined ? { wsaLastError: wsa } : { httpStatusCode: 502 })
            )
          }
          case 'x224':
            throw new ProxyFailure(`X.224: ${reason}`, errorPdu({ httpStatusCode: 502 }))
          case 'negotiation':
            throw new ProxyFailure(reason, negotiationErrorPdu(error.confirmRaw ?? Buffer.alloc(0)))
          case 'legacy':
            throw new ProxyFailure(reason, errorPdu({ httpStatusCode: 502 }))
          case 'downgrade':
            throw new ProxyFailure(`TLS: ${reason}`, errorPdu({ tlsAlertCode: 40 }))
          default:
            throw new ProxyFailure(
              `TLS: ${reason}`,
              errorPdu({ tlsAlertCode: tlsAlertOf(error.error) })
            )
        }
      }
      socket = link.socket
      tls = link.tls
      const confirmRaw = link.confirmRaw
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
      this.pipe(ws, tls, inbound, `${target.host}:${target.port}`, grant.tuning)
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

  private pipe(
    ws: WebSocket,
    tls: TLSSocket,
    inbound: Inbound,
    label: string,
    tuning: RdpSessionTuning | undefined
  ): void {
    let up = 0
    let down = 0
    let closed = false
    const rewriter = tuning
      ? new ClientInfoRewriter({
          performanceFlags: tuning.performanceFlags,
          autologon: tuning.autologon
        })
      : null
    // Khung đích bitmap lệch kích thước → IronRDP vẽ vỡ hình / panic (xem bitmap-fix.ts).
    const fixer = new BitmapFixer()
    const shutdown = (reason: string): void => {
      if (closed) return
      closed = true
      inbound.dispose()
      tls.destroy()
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000)
      this.opts.log(
        'info',
        `RDP proxy: ${label} closed (${reason}; up ${up} B, down ${down} B${fixer.fixed > 0 ? `; ${fixer.fixed} bitmap rects realigned` : ''})`
      )
    }
    inbound.attach(
      (chunk) => {
        up += chunk.length
        let data = chunk
        if (rewriter && !rewriter.done) {
          data = rewriter.process(chunk)
          if (rewriter.found)
            this.opts.log(
              'info',
              `RDP proxy: ${label} client info: performance flags 0x${(rewriter.found.performanceFlags ?? 0).toString(16)} → 0x${(tuning?.performanceFlags ?? 0).toString(16)}${tuning?.autologon && rewriter.found.hasPassword ? ', autologon' : ''}`
            )
        }
        if (!tls.write(data)) {
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
    const onSent = (): void => {
      if (paused && ws.bufferedAmount < LOW_WATER) {
        paused = false
        tls.resume()
      }
    }
    // Gom các record TLS tới trong cùng lượt event loop (setImmediate chạy ngay sau pha I/O).
    let batch: Buffer[] = []
    let batched = 0
    let scheduled = false
    const flush = (): void => {
      scheduled = false
      if (batched === 0 || closed) return
      const data = batch.length === 1 ? (batch[0] as Buffer) : Buffer.concat(batch, batched)
      batch = []
      batched = 0
      ws.send(data, { binary: true }, onSent)
      if (!paused && ws.bufferedAmount > HIGH_WATER) {
        paused = true
        tls.pause()
      }
    }
    const enqueue = (data: Buffer | null): void => {
      if (!data || data.length === 0) return
      batch.push(data)
      batched += data.length
    }
    tls.on('data', (chunk: Buffer) => {
      down += chunk.length
      enqueue(fixer.push(chunk))
      if (batched >= BATCH_BYTES) flush()
      else if (!scheduled) {
        scheduled = true
        setImmediate(flush)
      }
    })
    tls.on('end', () => {
      enqueue(fixer.flush())
      flush()
      shutdown('server ended')
    })
    tls.on('close', () => {
      enqueue(fixer.flush())
      flush()
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
