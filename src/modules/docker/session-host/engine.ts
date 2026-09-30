import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * Client HTTP tối giản cho Docker Engine API (ADR-014 mục 6.2) — không dùng dockerode (nhiều phụ
 * thuộc). Chạy trên mọi `Duplex`: unix socket / named pipe trên máy này, hoặc kênh streamlocal qua
 * SSH. Mỗi request một kết nối (kênh SSH mở nhanh; không cần keep-alive).
 */

/** API tối thiểu: Docker 20.10 / Podman 3 (compat API). */
export const API_VERSION = 'v1.41'

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
}

function buildPath(path: string, options: RequestOptions): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(options.query ?? {}))
    if (v !== undefined) params.set(k, String(v))
  const qs = params.toString()
  return `${options.raw ? '' : `/${API_VERSION}`}${path}${qs ? `?${qs}` : ''}`
}

async function readAll(res: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new Error('The Docker response is too large')
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
  constructor(private readonly connect: Connect) {}

  /** Mở request; trả response (người gọi đọc / huỷ). */
  async open(method: string, path: string, options: RequestOptions = {}): Promise<IncomingMessage> {
    const socket = await this.connect()
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest({
        method,
        path: buildPath(path, options),
        // Kết nối đã mở sẵn (socket / kênh SSH). Không đặt `agent` (kể cả false): có agent thì Node
        // bỏ qua createConnection.
        createConnection: () => socket,
        headers: {
          Host: 'docker',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {})
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
      req.end(body)
    })
  }

  /** Request trả JSON (hoặc rỗng). HTTP ≥ 400 → EngineError với thông báo của Docker. */
  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.open(method, path, options)
    const body = await readAll(res)
    const status = res.statusCode ?? 0
    if (status >= 400) throw new EngineError(status, errorMessage(status, body))
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
    const res = await this.open(method, path, options)
    const status = res.statusCode ?? 0
    if (status >= 400) {
      const body = await readAll(res)
      throw new EngineError(status, errorMessage(status, body))
    }
    onStart?.(res)
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) onChunk(chunk)
    } catch (error) {
      if (options.signal?.aborted) return
      throw error
    }
  }

  /** `GET /_ping` — kiểm có nói chuyện được với Engine không; trả phiên bản API của server. */
  async ping(signal?: AbortSignal): Promise<string> {
    const res = await this.open('GET', '/_ping', { raw: true, ...(signal ? { signal } : {}) })
    const body = await readAll(res)
    if ((res.statusCode ?? 0) >= 400)
      throw new EngineError(res.statusCode ?? 0, errorMessage(res.statusCode ?? 0, body))
    const version = res.headers['api-version']
    return typeof version === 'string' ? version : ''
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
