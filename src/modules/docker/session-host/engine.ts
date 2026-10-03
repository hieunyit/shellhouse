import { request as httpRequest, type IncomingMessage } from 'node:http'
import { Readable, type Duplex } from 'node:stream'
import { t } from '@shared/i18n'

/**
 * Client HTTP tối giản cho Docker Engine API (ADR-014 mục 6.2) — không dùng dockerode (nhiều phụ
 * thuộc). Chạy trên mọi `Duplex`: unix socket / named pipe trên máy này, hoặc kênh streamlocal qua
 * SSH. Mỗi request một kết nối (kênh SSH mở nhanh; không cần keep-alive).
 */

/**
 * Phiên bản API (thương lượng theo từng kết nối — không cố định): Docker Engine 29 nâng mức tối
 * thiểu lên 1.44 nên luôn dùng 1.41 thì bị từ chối ("client version 1.41 is too old"). Dùng
 * min(phiên bản server, MAX_API_VERSION); server không báo (Podman cũ…) → DEFAULT_API_VERSION.
 */
export const DEFAULT_API_VERSION = '1.41'
/** Bản mới nhất mình đã kiểm dạng dữ liệu (Docker 27). */
export const MAX_API_VERSION = '1.47'

/** "1.44" so với "1.41" → dương nếu a mới hơn. Chuỗi hỏng coi như 0.0. */
export function compareApiVersions(a: string, b: string): number {
  const parse = (v: string): [number, number] => {
    const m = /^v?(\d+)\.(\d+)/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2])] : [0, 0]
  }
  const [a1, a2] = parse(a)
  const [b1, b2] = parse(b)
  return a1 !== b1 ? a1 - b1 : a2 - b2
}

/** Phiên bản dùng khi server báo `server` (header Api-Version của /_ping). */
export function negotiateApiVersion(server: string): string {
  if (!/^v?\d+\.\d+/.test(server.trim())) return DEFAULT_API_VERSION
  const clean = server.trim().replace(/^v/, '')
  return compareApiVersions(clean, MAX_API_VERSION) < 0 ? clean : MAX_API_VERSION
}

/**
 * Lỗi 400 "client version 1.41 is too old. Minimum supported API version is 1.44" (hoặc "too new.
 * Maximum supported API version is 1.40") → phiên bản server chấp nhận; null = lỗi khác.
 */
export function versionFromError(status: number, message: string): string | null {
  if (status !== 400) return null
  const m =
    /client version [\d.]+ is too (?:old|new)\.?\s*(?:minimum|maximum) supported API version is (\d+\.\d+)/i.exec(
      message
    )
  return m?.[1] ?? null
}

export type Connect = () => Promise<Duplex>

export class EngineError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  signal?: AbortSignal
  /** Không thêm tiền tố phiên bản (/_ping). */
  raw?: boolean
  /** Header thêm (X-Registry-Auth…). */
  headers?: Record<string, string>
  /** Thân dạng luồng (tar khi tải file vào container) — gửi chunked. */
  upload?: { contentType: string; data: AsyncIterable<Buffer> }
}

function buildPath(path: string, options: RequestOptions, version: string): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(options.query ?? {}))
    if (v !== undefined) params.set(k, String(v))
  const qs = params.toString()
  return `${options.raw ? '' : `/v${version}`}${path}${qs ? `?${qs}` : ''}`
}

async function readAll(res: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new Error(t('The Docker response is too large'))
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function errorMessage(status: number, body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown }
    if (typeof parsed.message === 'string') return parsed.message
  } catch {
    // Không phải JSON.
  }
  const text = body.toString('utf8').trim()
  return text || `Docker answered HTTP ${status}`
}

export class EngineClient {
  /** Phiên bản API của kết nối này (sau `/_ping`). */
  private version = DEFAULT_API_VERSION
  private negotiated: Promise<void> | null = null

  constructor(private readonly connect: Connect) {}

  /** Phiên bản API đang dùng ("1.45"). */
  get apiVersion(): string {
    return this.version
  }

  /** Thương lượng phiên bản một lần (ping); ping lỗi → giữ mặc định, lần sau thử lại. */
  private negotiate(signal?: AbortSignal): Promise<void> {
    if (!this.negotiated) {
      const pending = this.ping(signal).then(() => undefined)
      this.negotiated = pending
      pending.catch(() => {
        if (this.negotiated === pending) this.negotiated = null
      })
    }
    return this.negotiated
  }

  /** Mở request; trả response (người gọi đọc / huỷ). */
  async open(method: string, path: string, options: RequestOptions = {}): Promise<IncomingMessage> {
    if (!options.raw) await this.negotiate(options.signal).catch(() => undefined)
    const socket = await this.connect()
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest({
        method,
        path: buildPath(path, options, this.version),
        // Kết nối đã mở sẵn (socket / kênh SSH). Không đặt `agent` (kể cả false): có agent thì Node
        // bỏ qua createConnection.
        createConnection: () => socket,
        headers: {
          Host: 'docker',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
          ...(options.upload ? { 'Content-Type': options.upload.contentType } : {}),
          ...options.headers
        }
      })
      const abort = (): void => {
        req.destroy(new Error('Cancelled'))
        socket.destroy()
      }
      if (options.signal?.aborted) {
        abort()
        reject(new Error('Cancelled'))
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      req.on('response', (res) => {
        res.on('close', () => {
          options.signal?.removeEventListener('abort', abort)
          socket.destroy()
        })
        resolve(res)
      })
      req.on('error', (error) => {
        options.signal?.removeEventListener('abort', abort)
        socket.destroy()
        reject(error)
      })
      if (options.upload) {
        // Lỗi đọc nguồn (file biến mất…) → huỷ request, báo lỗi đó (không treo chờ Docker).
        const source = Readable.from(options.upload.data)
        source.on('error', (error) => {
          req.destroy(error)
        })
        source.pipe(req)
      } else req.end(body)
    })
  }

  /**
   * Mở request; HTTP ≥ 400 → EngineError. Server từ chối phiên bản ("client version … is too old")
   * → đổi sang phiên bản server nêu rồi thử lại một lần.
   */
  async openOk(method: string, path: string, options: RequestOptions): Promise<IncomingMessage> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.open(method, path, options)
      const status = res.statusCode ?? 0
      if (status < 400) return res
      const body = await readAll(res)
      const message = errorMessage(status, body)
      const wanted = options.raw ? null : versionFromError(status, message)
      if (attempt === 0 && wanted && wanted !== this.version) {
        this.version = wanted
        continue
      }
      throw new EngineError(status, message)
    }
  }

  /** Request trả JSON (hoặc rỗng). HTTP ≥ 400 → EngineError với thông báo của Docker. */
  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.openOk(method, path, options)
    const body = await readAll(res)
    if (body.length === 0) return undefined as T
    return JSON.parse(body.toString('utf8')) as T
  }

  /**
   * Request dạng luồng (log, stats, events, pull): gọi `onChunk` cho từng mảnh tới khi luồng kết
   * thúc hoặc bị huỷ.
   */
  async stream(
    method: string,
    path: string,
    options: RequestOptions,
    onChunk: (chunk: Buffer) => void,
    onStart?: (res: IncomingMessage) => void
  ): Promise<void> {
    const res = await this.openOk(method, path, options)
    onStart?.(res)
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) onChunk(chunk)
    } catch (error) {
      if (options.signal?.aborted) return
      throw error
    }
  }

  /**
   * `GET /_ping` — kiểm có nói chuyện được với Engine không; trả phiên bản API của server và chọn
   * phiên bản cho các request sau của kết nối này.
   */
  async ping(signal?: AbortSignal): Promise<string> {
    const res = await this.open('GET', '/_ping', { raw: true, ...(signal ? { signal } : {}) })
    const body = await readAll(res)
    if ((res.statusCode ?? 0) >= 400)
      throw new EngineError(res.statusCode ?? 0, errorMessage(res.statusCode ?? 0, body))
    const header = res.headers['api-version']
    const version = typeof header === 'string' ? header : ''
    this.version = negotiateApiVersion(version)
    this.negotiated ??= Promise.resolve()
    return version
  }
}

/**
 * Tách luồng log khi container không có TTY: mỗi khung = 8 byte header (1 = stdout, 2 = stderr;
 * 3 byte 0; độ dài uint32 big-endian) + dữ liệu. Mảnh TCP cắt ngang khung bất kỳ chỗ nào.
 */
export class LogDemuxer {
  private pending: Buffer = Buffer.alloc(0)

  constructor(private readonly onFrame: (stream: 'stdout' | 'stderr', data: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE(4)
      if (this.pending.length < 8 + size) break
      const type = this.pending[0]
      const data = this.pending.subarray(8, 8 + size)
      this.onFrame(type === 2 ? 'stderr' : 'stdout', data)
      this.pending = this.pending.subarray(8 + size)
    }
  }
}

/** Luồng JSON theo dòng (events, stats, pull): gọi `onValue` cho từng đối tượng hoàn chỉnh. */
export class JsonLines {
  private pending = ''
  private readonly decoder = new TextDecoder()

  constructor(private readonly onValue: (value: unknown) => void) {}

  push(chunk: Buffer): void {
    this.pending += this.decoder.decode(chunk, { stream: true })
    let nl = this.pending.indexOf('\n')
    while (nl >= 0) {
      const line = this.pending.slice(0, nl).trim()
      this.pending = this.pending.slice(nl + 1)
      if (line) {
        try {
          this.onValue(JSON.parse(line))
        } catch {
          // Dòng hỏng — bỏ qua, không làm đứt luồng.
        }
      }
      nl = this.pending.indexOf('\n')
    }
  }
}
