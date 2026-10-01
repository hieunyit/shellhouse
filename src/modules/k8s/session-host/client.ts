import { request as httpRequest, type IncomingMessage } from 'node:http'
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
}

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

export class KubeClient {
  private readonly url: URL

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
      socket.once('secureConnect', () => {
        clearTimeout(timer)
        socket.removeListener('error', reject)
        resolve(socket)
      })
      socket.once('error', (e: unknown) => {
        clearTimeout(timer)
        raw.destroy()
        const err = e instanceof Error ? e : new Error(String(e))
        // Lỗi chứng chỉ không thử lại; kết nối bị cắt giữa chừng thì có.
        reject(
          /ECONNRESET|socket hang up|EPIPE/i.test(err.message)
            ? new HandshakeError(err.message)
            : err
        )
      })
    })
  }

  private async openOnce(
    method: string,
    path: string,
    options: RequestOptions,
    refresh: boolean
  ): Promise<IncomingMessage> {
    const creds = await this.credentials(refresh)
    const socket = await this.socket(creds)
    const body =
      options.body === undefined
        ? undefined
        : Buffer.from(
            typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
          )
    // Huỷ trong lúc đang mở kết nối → không tạo request (request bị huỷ trước khi gắn listener
    // lỗi sẽ phát "socket hang up" không ai bắt và làm sập cả Session Host).
    if (options.signal?.aborted) {
      socket.destroy()
      throw new Error('Cancelled')
    }
    return new Promise<IncomingMessage>((resolve, reject) => {
      // Kết nối đã là TLS nếu cần → dùng http.request trên nó; Host đặt tường minh (có cổng).
      const req = httpRequest({
        method,
        setHost: false,
        path: `${this.url.pathname.replace(/\/$/, '')}${path}${buildQuery(options.query)}`,
        // Kết nối (đã TLS) mở sẵn — không đặt `agent` để Node dùng createConnection.
        createConnection: () => socket,
        headers: {
          Host: this.url.host,
          Accept: 'application/json',
          ...creds.headers,
          ...(body
            ? {
                'Content-Type': options.contentType ?? 'application/json',
                'Content-Length': body.length
              }
            : {})
        }
      })
      // Gắn listener lỗi ngay khi tạo request — mọi lỗi về sau (huỷ, kết nối đứt) đều được bắt.
      req.on('error', (e) => {
        options.signal?.removeEventListener('abort', abort)
        socket.destroy()
        reject(e)
      })
      const abort = (): void => {
        req.destroy(new Error('Cancelled'))
        socket.destroy()
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      req.on('response', (res) => {
        res.on('close', () => {
          options.signal?.removeEventListener('abort', abort)
          socket.destroy()
        })
        resolve(res)
      })
      req.end(body)
    })
  }

  /** Mở request; 401 → làm mới thông tin xác thực (plugin exec / OIDC) và thử lại một lần. */
  async open(method: string, path: string, options: RequestOptions = {}): Promise<IncomingMessage> {
    const res = await this.openOnce(method, path, options, false)
    if (res.statusCode !== 401) return res
    res.resume()
    return this.openOnce(method, path, options, true)
  }

  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.open(method, path, options)
    const body = await readAll(res)
    const status = res.statusCode ?? 0
    if (status >= 400) {
      const s = statusMessage(status, body)
      throw new KubeError(status, s.message, s.reason)
    }
    return (body.length ? JSON.parse(body.toString('utf8')) : undefined) as T
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
