import { STREAM_LIMITS } from '@shared/stream-protocol'

export interface PausableSource {
  pause(): void
  resume(): void
}

export interface PumpLimits {
  maxBatchBytes: number
  flushIntervalMs: number
  highWatermarkBytes: number
  lowWatermarkBytes: number
}

/**
 * Gom output của một nguồn (PTY, kênh SSH) thành batch và áp backpressure.
 *
 * - Gửi khi đủ `maxBatchBytes` hoặc sau `flushIntervalMs` kể từ byte đầu của batch.
 * - Đếm byte đã gửi mà renderer chưa ack; vượt high watermark → `source.pause()`,
 *   ack xuống dưới low watermark → `source.resume()`.
 */
export class OutputPump {
  private chunks: Uint8Array[] = []
  private buffered = 0
  private unacked = 0
  private paused = false
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly send: (chunk: Uint8Array) => void,
    private readonly source: PausableSource,
    private readonly limits: PumpLimits = STREAM_LIMITS
  ) {}

  get unackedBytes(): number {
    return this.unacked
  }

  get isPaused(): boolean {
    return this.paused
  }

  push(data: Uint8Array): void {
    if (this.disposed || data.byteLength === 0) return
    this.chunks.push(data)
    this.buffered += data.byteLength
    if (this.buffered >= this.limits.maxBatchBytes) {
      this.flush()
    } else {
      this.timer ??= setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.limits.flushIntervalMs)
    }
  }

  ack(bytes: number): void {
    if (this.disposed) return
    this.unacked = Math.max(0, this.unacked - bytes)
    if (this.paused && this.unacked < this.limits.lowWatermarkBytes) {
      this.paused = false
      this.source.resume()
    }
  }

  /** Gửi toàn bộ phần đang gom, chia thành các frame tối đa `maxBatchBytes`. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffered === 0 || this.disposed) return

    const all = concat(this.chunks, this.buffered)
    this.chunks = []
    this.buffered = 0

    for (let offset = 0; offset < all.byteLength; offset += this.limits.maxBatchBytes) {
      const frame = standalone(all.subarray(offset, offset + this.limits.maxBatchBytes))
      this.unacked += frame.byteLength
      this.send(frame)
    }

    if (!this.paused && this.unacked >= this.limits.highWatermarkBytes) {
      this.paused = true
      this.source.pause()
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.chunks = []
    this.buffered = 0
    this.disposed = true
  }
}

/**
 * Structured clone (postMessage) sao chép TOÀN BỘ ArrayBuffer phía sau một view, không chỉ phần
 * view. Buffer của Node thường là lát cắt của slab dùng chung → phải copy ra buffer riêng đúng kích
 * thước, nếu không sẽ gửi thừa dữ liệu (có thể là dữ liệu nhạy cảm khác) sang renderer.
 */
export function standalone(view: Uint8Array): Uint8Array {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view
  return view.slice()
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]) return chunks[0]
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
