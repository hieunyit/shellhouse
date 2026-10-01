import type { Client } from 'ssh2'

/** Phần bên trong ssh2 dùng để đo (keepalive có chờ phản hồi). Không có → không đo được. */
interface Internals {
  _protocol?: { ping?: () => void }
  _callbacks?: ((failed: boolean) => void)[]
}

/**
 * Đo thời gian khứ hồi (RTT) tới server: gửi một keepalive@openssh.com có chờ trả lời và đo tới lúc
 * nhận REQUEST_SUCCESS / FAILURE — đúng độ trễ mạng của kết nối SSH, không chạy lệnh nào trên
 * server. ssh2 trả lời global request theo thứ tự hàng đợi callback (như keepalive của chính nó).
 */
export function measureRtt(client: Client, timeoutMs = 5000): Promise<number | null> {
  const c = client as unknown as Internals
  const ping = c._protocol?.ping
  if (typeof ping !== 'function' || !Array.isArray(c._callbacks)) return Promise.resolve(null)
  const callbacks = c._callbacks
  return new Promise((resolve) => {
    const started = performance.now()
    let done = false
    const timer = setTimeout(() => {
      done = true
      resolve(null)
    }, timeoutMs)
    callbacks.push(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(Math.round(performance.now() - started))
    })
    try {
      ping.call(c._protocol)
    } catch {
      // Kết nối vừa đóng — callback thừa không sao (ssh2 bỏ hàng đợi khi đóng).
      done = true
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/** Đo định kỳ khi tab đang hiện. */
export class LatencyMonitor {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly client: Client,
    private readonly listener: (ms: number | null) => void,
    private readonly intervalMs = 10_000
  ) {}

  start(): void {
    if (this.timer) return
    const tick = (): void => {
      void measureRtt(this.client).then((ms) => {
        if (this.timer) this.listener(ms)
      })
    }
    this.timer = setInterval(tick, this.intervalMs)
    tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
