import { createHash } from 'node:crypto'
import {
  Agent,
  request as httpRequest,
  type ClientRequestArgs,
  type IncomingMessage
} from 'node:http'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Duplex } from 'node:stream'
import WebSocket from 'ws'

/**
 * Client Kubernetes API tối giản (ADR-014 mục 7.2): HTTPS dựng trên một kết nối thô do người gọi
 * mở — TCP thẳng tới API server, hoặc kênh `direct-tcpip` qua host SSH (bastion). TLS vẫn kiểm
 * chứng chỉ theo `server` / `tls-server-name` của kubeconfig.
 */

export interface ClusterEndpoint {
  server: string
  ca?: string
  insecure: boolean
  tlsServerName?: string
}

export interface Credentials {
  headers: Record<string, string>
  cert?: string
  key?: string
}

/** Mở kết nối TCP thô tới host:port (thẳng hoặc qua SSH). */
export type RawConnect = (host: string, port: number) => Promise<Duplex>

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string
  ) {
    super(message)
    this.name = 'KubeError'
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | readonly string[]>
  body?: unknown
  contentType?: string
  signal?: AbortSignal
  /** Header Accept (mặc định application/json). */
  accept?: string
  /**
   * Không nhận được byte nào trong chừng này (ms) → huỷ request, báo lỗi. Mặc định: json() / text()
   * dùng `requestTimeout.idleMs`; open() / stream() (watch, log follow) không giới hạn.
   */
  idleMs?: number | false
}

/** Hết thời gian chờ API server (request thường). */
export class KubeTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KubeTimeoutError'
  }
}

/** Request thường (không phải watch / log / exec): không có dữ liệu chừng này → lỗi (test chỉnh được). */
export const requestTimeout = { idleMs: 30_000 }

/**
 * Kết nối giữ lại (HTTP/1.1 keep-alive) cho request thường: qua bastion SSH mỗi kết nối mới là một
 * kênh direct-tcpip + bắt tay TLS (vài RTT) — dùng lại thì một request chỉ còn một RTT. Watch / log /
 * exec / port-forward vẫn mở kết nối riêng (giữ lâu, không chiếm chỗ của request thường).
 */
export const keepAlive = { maxSockets: 16, maxFree: 8, idleMs: 15_000 }

function buildQuery(query: RequestOptions['query']): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const item of v as readonly string[]) params.append(k, item)
    else params.set(k, String(v))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

async function readAll(res: IncomingMessage, limit = 256 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new Error('The API server response is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Thông báo lỗi dễ hiểu từ Status của Kubernetes (403 → "You can't list secrets in …"). */
export function statusMessage(status: number, body: Buffer): { message: string; reason?: string } {
  try {
    const s = JSON.parse(body.toString('utf8')) as {
      message?: string
      reason?: string
      details?: { kind?: string; name?: string }
    }
    if (status === 403 && s.message) {
      // "pods is forbidden: User "x" cannot list resource "pods" in API group "" in the namespace "y""
      const m =
        /cannot (\w+) resource "([^"]+)"(?: in API group "[^"]*")?(?: in the namespace "([^"]+)")?/.exec(
          s.message
        )
      if (m)
        return {
          message: `You can't ${m[1] ?? ''} ${m[2] ?? ''}${m[3] ? ` in namespace ${m[3]}` : ' in this cluster'}`,
          reason: 'Forbidden'
        }
    }
    if (status === 401)
      return { message: 'The cluster did not accept your credentials', reason: 'Unauthorized' }
    if (s.message) return { message: s.message, ...(s.reason ? { reason: s.reason } : {}) }
  } catch {
    // Không phải JSON.
  }
  return { message: body.toString('utf8').trim() || `The API server answered HTTP ${status}` }
}

/** Bắt tay TLS lâu hơn chừng này coi như treo (test chỉnh được). */
export const handshake = { ms: 10_000, attempts: 3 }

/** Bắt tay TLS treo / bị cắt — thử lại bằng kết nối mới được. */
class HandshakeError extends Error {}

/** Lỗi khi gửi trên kết nối giữ lại mà server vừa đóng — gửi lại bằng kết nối mới được. */
const STALE = /ECONNRESET|EPIPE|socket hang up|ECONNABORTED/i

/**
 * Agent cần vài phương thức của net.Socket (setKeepAlive, ref…); kênh SSH (Duplex thô, API server
 * http:// sau bastion) không có → thêm bản rỗng.
 */
function socketLike(stream: Duplex): Duplex {
  const s = stream as Duplex & Record<string, unknown>
  for (const m of ['setKeepAlive', 'setNoDelay', 'setTimeout', 'ref', 'unref'])
    if (typeof s[m] !== 'function') s[m] = () => s
  return stream
}

/** Agent giữ kết nối của một cluster; kết nối do KubeClient mở (thẳng hoặc qua SSH, TLS nếu cần). */
class PoolAgent extends Agent {
  private retired = false

  constructor(private readonly open: () => Promise<Duplex>) {
    super({
      keepAlive: true,
      maxSockets: keepAlive.maxSockets,
      maxFreeSockets: keepAlive.maxFree,
      scheduling: 'lifo'
    })
  }

  override createConnection(
    _options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    this.open().then(
      (socket) => {
        // Kết nối rảnh quá keepAlive.idleMs → đóng (không giữ kênh SSH / TLS mãi).
        let timer: NodeJS.Timeout | null = null
        const idle = (): void => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            const free = Object.values(this.freeSockets).some((list) =>
              (list as Duplex[] | undefined)?.includes(socket)
            )
            if (free) socket.destroy()
          }, keepAlive.idleMs)
          timer.unref()
        }
        socket.on('free', idle)
        socket.once('close', () => {
          if (timer) clearTimeout(timer)
        })
        callback?.(null, socketLike(socket))
      },
      (error: unknown) => {
        callback?.(error instanceof Error ? error : new Error(String(error)), undefined as never)
      }
    )
    return undefined
  }

  override keepSocketAlive(socket: Duplex): boolean {
    if (this.retired) return false
    super.keepSocketAlive(socket)
    return true
  }

  /** Thôi dùng: đóng kết nối rảnh; request đang chạy chạy nốt rồi đóng kết nối của nó. */
  retire(): void {
    this.retired = true
    for (const list of Object.values(this.freeSockets))
      for (const s of (list as Duplex[] | undefined) ?? []) s.destroy()
  }
}

export class KubeClient {
  private readonly url: URL
  /** Agent theo chứng chỉ client (exec plugin có thể đổi chứng chỉ → kết nối cũ không dùng nữa). */
  private pool: { key: string; agent: PoolAgent } | null = null
  private closed = false

  constructor(
    private readonly endpoint: ClusterEndpoint,
    private readonly connect: RawConnect,
    /** Thông tin xác thực hiện tại (plugin exec / OIDC có thể làm mới). */
    private readonly credentials: (refresh: boolean) => Promise<Credentials>
  ) {
    this.url = new URL(endpoint.server)
  }

  get secure(): boolean {
    return this.url.protocol === 'https:'
  }

  private get port(): number {
    return Number(this.url.port) || (this.secure ? 443 : 80)
  }

  /** Đóng mọi kết nối giữ lại (đổi context / đóng phiên). */
  close(): void {
    this.closed = true
    this.pool?.agent.retire()
    this.pool = null
  }

  private agentFor(creds: Credentials): PoolAgent {
    const key = creds.cert
      ? createHash('sha256')
          .update(creds.cert)
          .update('\0')
          .update(creds.key ?? '')
          .digest('hex')
      : ''
    if (this.pool?.key === key) return this.pool.agent
    this.pool?.agent.retire()
    const agent = new PoolAgent(() => this.socket(creds))
    this.pool = { key, agent }
    return agent
  }

  /**
   * Kết nối (TLS nếu https) sẵn sàng để gửi request. Bắt tay TLS treo (mạng chập chờn, proxy /
   * bastion kẹt) → bỏ sau handshake.ms và thử kết nối mới — không để request (và bảng) chờ mãi.
   */
  async socket(creds: Credentials): Promise<Duplex> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.socketOnce(creds)
      } catch (error) {
        if (!(error instanceof HandshakeError) || attempt >= handshake.attempts) throw error
      }
    }
  }

  private async socketOnce(creds: Credentials): Promise<Duplex> {
    const raw = await this.connect(this.url.hostname, this.port)
    if (!this.secure) return raw
    return new Promise<TLSSocket>((resolve, reject) => {
      const host = this.url.hostname.replace(/^\[|\]$/g, '')
      const isIp = /^[\d.]+$/.test(host) || host.includes(':')
      // SNI không nhận địa chỉ IP; kiểm chứng chỉ theo tls-server-name nếu có, không thì theo host
      // (IP → so với IP SAN).
      const servername = this.endpoint.tlsServerName ?? (isIp ? undefined : host)
      const socket = tlsConnect({
        socket: raw,
        host,
        ...(servername ? { servername } : {}),
        ...(this.endpoint.ca ? { ca: this.endpoint.ca } : {}),
        ...(creds.cert ? { cert: creds.cert } : {}),
        ...(creds.key ? { key: creds.key } : {}),
        rejectUnauthorized: !this.endpoint.insecure,
        ALPNProtocols: ['http/1.1']
      })
      const timer = setTimeout(() => {
        socket.destroy()
        raw.destroy()
        reject(new HandshakeError(`TLS handshake with ${this.url.host} timed out`))
      }, handshake.ms)
      const onError = (e: unknown): void => {
        clearTimeout(timer)
        raw.destroy()
        const err = e instanceof Error ? e : new Error(String(e))
        // Lỗi chứng chỉ không thử lại; kết nối bị cắt giữa chừng thì có.
        reject(
          /ECONNRESET|socket hang up|EPIPE/i.test(err.message)
            ? new HandshakeError(err.message)
            : err
        )
      }
      socket.once('secureConnect', () => {
        clearTimeout(timer)
        socket.removeListener('error', onError)
        // Lỗi về sau do request đang dùng kết nối bắt; kết nối rảnh trong agent cũng có listener.
        // Listener rỗng này chỉ để lỗi muộn (sau khi request đã xong) không làm sập Session Host.
        socket.on('error', () => undefined)
        resolve(socket)
      })
      socket.once('error', onError)
    })
  }

  private async openOnce(
    method: string,
    path: string,
    options: RequestOptions,
    refresh: boolean,
    pooled: boolean
  ): Promise<IncomingMessage> {
    if (this.closed && pooled) pooled = false
    const creds = await this.credentials(refresh)
    const body =
      options.body === undefined
        ? undefined
        : Buffer.from(
            typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
          )
    if (options.signal?.aborted) throw new Error('Cancelled')
    const socket = pooled ? null : await this.socket(creds)
    // Huỷ trong lúc đang mở kết nối → không tạo request (request bị huỷ trước khi gắn listener
    // lỗi sẽ phát "socket hang up" không ai bắt và làm sập cả Session Host).
    if (options.signal?.aborted) {
      socket?.destroy()
      throw new Error('Cancelled')
    }
    const idleMs = options.idleMs || 0
    return new Promise<IncomingMessage>((resolve, reject) => {
      // Kết nối đã là TLS nếu cần → dùng http.request trên nó; Host đặt tường minh (có cổng).
      const req = httpRequest({
        method,
        setHost: false,
        path: `${this.url.pathname.replace(/\/$/, '')}${path}${buildQuery(options.query)}`,
        ...(socket
          ? // Kết nối mở sẵn — không đặt `agent` để Node dùng createConnection.
            { createConnection: () => socket }
          : { agent: this.agentFor(creds), host: this.url.hostname, port: this.port }),
        headers: {
          Host: this.url.host,
          Accept: options.accept ?? 'application/json',
          ...creds.headers,
          ...(body
            ? {
                'Content-Type': options.contentType ?? 'application/json',
                'Content-Length': body.length
              }
            : {})
        }
      })
      let response: IncomingMessage | null = null
      let timer: NodeJS.Timeout | null = null
      let watched: Duplex | null = null
      let finished = false
      const done = (): void => {
        finished = true
        if (timer) clearTimeout(timer)
        timer = null
        watched?.removeListener('data', arm)
        watched = null
        options.signal?.removeEventListener('abort', abort)
      }
      // Hẹn giờ "im lặng": đặt lại mỗi khi có byte tới (chờ header lẫn lúc đọc body).
      function arm(): void {
        if (!idleMs) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          const error = new KubeTimeoutError(
            `The API server did not answer for ${Math.round(idleMs / 1000)} s`
          )
          if (response) response.destroy(error)
          else req.destroy(error)
          done()
        }, idleMs)
      }
      // Bắt đầu đếm khi request có kết nối: request xếp hàng chờ socket của agent (đủ maxSockets)
      // không bị tính là server im lặng.
      if (idleMs)
        req.once('socket', (s: Duplex) => {
          if (finished) return
          watched = s
          s.on('data', arm)
          arm()
        })
      // Gắn listener lỗi ngay khi tạo request — mọi lỗi về sau (huỷ, kết nối đứt) đều được bắt.
      req.on('error', (e) => {
        const reused = req.reusedSocket
        done()
        socket?.destroy()
        // Kết nối giữ lại vừa bị server đóng (trước khi có phản hồi): gửi lại bằng kết nối mới —
        // chỉ với request không đổi gì (GET / HEAD).
        if (
          reused &&
          !response &&
          !options.signal?.aborted &&
          (method === 'GET' || method === 'HEAD') &&
          STALE.test(`${(e as { code?: string }).code ?? ''} ${e.message}`)
        ) {
          this.openOnce(method, path, options, refresh, false).then(resolve, reject)
          return
        }
        reject(e)
      })
      const abort = (): void => {
        req.destroy(new Error('Cancelled'))
        socket?.destroy()
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      req.on('response', (res) => {
        response = res
        res.on('close', () => {
          done()
          socket?.destroy()
        })
        res.on('end', done)
        resolve(res)
      })
      req.end(body)
    })
  }

  /** Mở request; 401 → làm mới thông tin xác thực (plugin exec / OIDC) và thử lại một lần. */
  async open(
    method: string,
    path: string,
    options: RequestOptions = {},
    /** Dùng kết nối giữ lại (request ngắn, đọc hết body). */
    pooled = false
  ): Promise<IncomingMessage> {
    const res = await this.openOnce(method, path, options, false, pooled)
    if (res.statusCode !== 401) return res
    res.resume()
    return this.openOnce(method, path, options, true, pooled)
  }

  /** Request thường, đọc hết body (có giới hạn thời gian chờ, dùng kết nối giữ lại). */
  private async read(
    method: string,
    path: string,
    options: RequestOptions
  ): Promise<{ status: number; body: Buffer }> {
    const res = await this.open(
      method,
      path,
      { ...options, idleMs: options.idleMs ?? requestTimeout.idleMs },
      true
    )
    try {
      return { status: res.statusCode ?? 0, body: await readAll(res) }
    } catch (error) {
      res.destroy()
      throw error
    }
  }

  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { status, body } = await this.read(method, path, options)
    if (status >= 400) {
      const s = statusMessage(status, body)
      throw new KubeError(status, s.message, s.reason)
    }
    return (body.length ? JSON.parse(body.toString('utf8')) : undefined) as T
  }

  /** Văn bản (metrics Prometheus qua proxy…); HTTP lỗi → KubeError. */
  async text(method: string, path: string, options: RequestOptions = {}): Promise<string> {
    const { status, body } = await this.read(method, path, { accept: '*/*', ...options })
    if (status >= 400) {
      const s = statusMessage(status, body)
      throw new KubeError(status, s.message.slice(0, 300), s.reason)
    }
    return body.toString('utf8')
  }

  /** Luồng (watch, log): gọi onChunk tới khi hết / bị huỷ. */
  async stream(
    method: string,
    path: string,
    options: RequestOptions,
    onChunk: (chunk: Buffer) => void
  ): Promise<void> {
    const res = await this.open(method, path, options)
    const status = res.statusCode ?? 0
    if (status >= 400) {
      const s = statusMessage(status, await readAll(res))
      throw new KubeError(status, s.message, s.reason)
    }
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) onChunk(chunk)
    } catch (error) {
      if (options.signal?.aborted) return
      throw error
    }
  }

  /** WebSocket (exec, port-forward) trên cùng kiểu kết nối. */
  async websocket(
    path: string,
    query: RequestOptions['query'],
    protocols: string[]
  ): Promise<WebSocket> {
    const creds = await this.credentials(false)
    const socket = await this.socket(creds)
    const scheme = this.secure ? 'wss' : 'ws'
    const url = `${scheme}://${this.url.host}${this.url.pathname.replace(/\/$/, '')}${path}${buildQuery(query)}`
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, protocols, {
        headers: creds.headers,
        // Server nhận kết nối mà không trả lời nâng cấp → không chờ mãi.
        handshakeTimeout: requestTimeout.idleMs,
        // Kết nối đã mở sẵn (TLS nếu cần) — ws không tự quay số.
        createConnection: () => socket as unknown as import('node:net').Socket
      })
      ws.binaryType = 'nodebuffer'
      ws.once('open', () => {
        ws.removeListener('error', reject)
        resolve(ws)
      })
      ws.once('unexpected-response', (_req, res) => {
        void readAll(res).then((body) => {
          const s = statusMessage(res.statusCode ?? 0, body)
          reject(new KubeError(res.statusCode ?? 0, s.message, s.reason))
        }, reject)
      })
      ws.once('error', reject)
    })
  }
}
