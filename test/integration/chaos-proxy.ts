import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'

/**
 * TCP proxy gây nhiễu (thay Toxiproxy khi không có Docker). Mỗi hướng dữ liệu đi qua một hàng đợi
 * có trễ / giới hạn băng thông; có thể cắt kết nối sau N byte hoặc "đóng băng" (không RST).
 */
export interface ChaosOptions {
  /** Trễ mỗi chiều (ms). */
  latencyMs?: number
  /** Dao động trễ ± (ms). Thứ tự dữ liệu vẫn được giữ như TCP thật. */
  jitterMs?: number
  /** Giới hạn băng thông mỗi chiều (byte/giây). */
  bytesPerSecond?: number
  /** Huỷ kết nối (RST) sau khi chuyển tổng cộng N byte server → client. */
  cutAfterDownstreamBytes?: number
  /** Huỷ kết nối sau khi chuyển N byte client → server. */
  cutAfterUpstreamBytes?: number
}

export interface ChaosProxy {
  port: number
  /** Ngừng chuyển dữ liệu nhưng giữ socket (giống mạng treo). */
  freeze(): void
  /** Cắt mọi kết nối đang mở ngay lập tức (RST). */
  cutAll(): void
  set(options: ChaosOptions): void
  /** Số kết nối đã nhận. */
  readonly connections: number
  close(): Promise<void>
}

class Lane {
  private queue: { chunk: Buffer; at: number }[] = []
  private timer: NodeJS.Timeout | null = null
  private lastDeliver = 0
  private budgetUntil = 0
  transferred = 0

  constructor(
    private readonly out: Socket,
    private readonly opts: () => ChaosOptions,
    private readonly frozen: () => boolean,
    private readonly onBytes: (n: number) => void
  ) {}

  push(chunk: Buffer): void {
    const { latencyMs = 0, jitterMs = 0 } = this.opts()
    const jitter = jitterMs ? (Math.random() * 2 - 1) * jitterMs : 0
    // Không cho gói sau đến trước gói trước (TCP giữ thứ tự).
    const at = Math.max(Date.now() + latencyMs + jitter, this.lastDeliver)
    this.lastDeliver = at
    this.queue.push({ chunk, at })
    this.schedule()
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return
    const head = this.queue[0]
    if (!head) return
    const wait = Math.max(0, head.at - Date.now(), this.budgetUntil - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.deliver()
    }, wait)
  }

  private deliver(): void {
    if (this.frozen() || this.out.destroyed) return
    const head = this.queue[0]
    if (!head) return
    const { bytesPerSecond } = this.opts()
    let chunk = head.chunk
    if (bytesPerSecond) {
      // Gửi tối đa ~50 ms dữ liệu mỗi lần để băng thông đều.
      const slice = Math.max(1, Math.floor(bytesPerSecond / 20))
      if (chunk.length > slice) {
        head.chunk = chunk.subarray(slice)
        chunk = chunk.subarray(0, slice)
      } else this.queue.shift()
      this.budgetUntil = Date.now() + (chunk.length / bytesPerSecond) * 1000
    } else this.queue.shift()
    this.transferred += chunk.length
    this.out.write(chunk)
    this.onBytes(this.transferred)
    this.schedule()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.queue = []
  }
}

export async function startChaosProxy(
  targetPort: number,
  initial: ChaosOptions = {}
): Promise<ChaosProxy> {
  let options = initial
  let frozen = false
  let connections = 0
  const sockets = new Set<Socket>()

  const server: Server = createServer((down) => {
    connections++
    const up = connect(targetPort, '127.0.0.1')
    sockets.add(down)
    sockets.add(up)
    const kill = (): void => {
      down.resetAndDestroy()
      up.resetAndDestroy()
    }
    const toServer = new Lane(
      up,
      () => options,
      () => frozen,
      (n) => {
        if (options.cutAfterUpstreamBytes !== undefined && n >= options.cutAfterUpstreamBytes)
          kill()
      }
    )
    const toClient = new Lane(
      down,
      () => options,
      () => frozen,
      (n) => {
        if (options.cutAfterDownstreamBytes !== undefined && n >= options.cutAfterDownstreamBytes)
          kill()
      }
    )
    down.on('data', (c: Buffer) => {
      toServer.push(c)
    })
    up.on('data', (c: Buffer) => {
      toClient.push(c)
    })
    const cleanup = (): void => {
      toServer.dispose()
      toClient.dispose()
      sockets.delete(down)
      sockets.delete(up)
      down.destroy()
      up.destroy()
    }
    for (const s of [down, up]) {
      s.on('error', cleanup)
      s.on('close', cleanup)
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    freeze: () => {
      frozen = true
    },
    cutAll: () => {
      for (const s of sockets) s.resetAndDestroy()
    },
    set: (next) => {
      options = { ...options, ...next }
    },
    get connections() {
      return connections
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => {
          resolve()
        })
      })
  }
}
