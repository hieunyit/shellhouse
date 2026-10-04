import {
  describeCommand,
  encodeCommand,
  LineDecoder,
  parseEvent,
  type HelperCommand,
  type HelperEvent
} from './protocol'

/** Phần của ChildProcess cần dùng (test thay bằng tiến trình giả). */
export interface HelperChild {
  readonly stdin: {
    write(data: string): unknown
    end(): unknown
    on(event: 'error', listener: (error: Error) => void): unknown
  } | null
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  kill(): boolean
}

export interface HelperLog {
  info(message: string): void
  warn(message: string): void
}

type Ready = Extract<HelperEvent, { type: 'ready' }>
type Reply = Extract<HelperEvent, { type: 'snapshot' | 'state' }>

const STDERR_TAIL = 2048

/**
 * Một tiến trình shellhouse-rdp-host.exe (mỗi tab một tiến trình — control lỗi / treo chỉ hỏng tab
 * đó). Gửi lệnh, nhận sự kiện, hỏi-đáp có id (ảnh chụp, trạng thái cửa sổ).
 */
export class RdpHelper {
  readonly ready: Promise<Ready>
  private settleReady: ((value: Ready | Error) => void) | null = null
  private readonly waiting = new Map<number, (reply: Reply | null) => void>()
  private nextId = 1
  private exited = false
  private stderr = ''

  constructor(
    private readonly child: HelperChild,
    private readonly handlers: {
      event(event: HelperEvent): void
      /** Tiến trình đã thoát; `message` = dòng cuối stderr (nếu có). */
      exit(code: number | null, message: string | null): void
    },
    private readonly log: HelperLog,
    readyTimeoutMs = 20_000
  ) {
    this.ready = new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleReady?.(new Error('The Remote Desktop helper did not start in time'))
      }, readyTimeoutMs)
      timer.unref()
      this.settleReady = (value) => {
        clearTimeout(timer)
        this.settleReady = null
        if (value instanceof Error) reject(value)
        else resolve(value)
      }
    })
    // Không để Promise bị từ chối mà không ai bắt (người gọi có thể chưa kịp await).
    this.ready.catch(() => undefined)

    const decoder = new LineDecoder(
      (line) => {
        this.onLine(line)
      },
      (message) => {
        this.log.warn(`RDP helper: ${message}`)
      }
    )
    child.stdout?.on('data', (chunk) => {
      decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-STDERR_TAIL)
    })
    child.stdin?.on('error', () => undefined)
    child.once('error', (error) => {
      this.finish(null, error.message)
    })
    child.once('exit', (code) => {
      const last = this.stderr
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop()
      this.finish(code, last ?? null)
    })
  }

  get alive(): boolean {
    return !this.exited
  }

  private onLine(line: string): void {
    const event = parseEvent(line)
    if (!event) {
      this.log.warn('RDP helper: invalid message ignored')
      return
    }
    if (event.type === 'ready') {
      this.settleReady?.(event)
      return
    }
    if (event.type === 'snapshot' || event.type === 'state') {
      const waiter = this.waiting.get(event.id)
      this.waiting.delete(event.id)
      waiter?.(event)
      return
    }
    if (event.type === 'log') {
      if (event.level === 'warn') this.log.warn(`RDP helper: ${event.message}`)
      else this.log.info(`RDP helper: ${event.message}`)
      return
    }
    this.handlers.event(event)
  }

  private finish(code: number | null, message: string | null): void {
    if (this.exited) return
    this.exited = true
    this.settleReady?.(new Error(message ?? 'The Remote Desktop helper exited'))
    for (const waiter of this.waiting.values()) waiter(null)
    this.waiting.clear()
    this.handlers.exit(code, message)
  }

  send(command: HelperCommand): void {
    if (this.exited || !this.child.stdin) return
    if (command.type !== 'bounds' && command.type !== 'region')
      this.log.info(`RDP helper ← ${describeCommand(command)}`)
    this.child.stdin.write(encodeCommand(command))
  }

  /** Hỏi-đáp có id; null = hết giờ / tiến trình đã thoát. */
  request(type: 'snapshot' | 'query', timeoutMs = 3_000): Promise<Reply | null> {
    if (this.exited) return Promise.resolve(null)
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve(null)
      }, timeoutMs)
      timer.unref()
      this.waiting.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      this.send({ type, id })
    })
  }

  /** Đóng: xin thoát êm (ngắt phiên), quá hạn thì giết. Đóng stdin cũng làm nó thoát. */
  close(graceMs = 3_000): void {
    if (this.exited) return
    this.send({ type: 'quit' })
    this.child.stdin?.end()
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill()
    }, graceMs)
    timer.unref()
  }

  kill(): void {
    if (!this.exited) this.child.kill()
  }
}
