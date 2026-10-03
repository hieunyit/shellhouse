import type { MessagePortMain } from 'electron'
import { HostEvent, type HostRequest, type NativeModuleStatus } from '@shared/session-host-protocol'
import type { SessionHostStatus } from '@shared/ipc'
import type { ResolvedSessionSpec } from '@shared/stream-protocol'
import type { HostRequest as HostRequestType } from '@shared/session-host-protocol'
import { t } from '@shared/i18n'

/** Phần tối thiểu của một child process mà supervisor cần — tách ra để test không cần Electron. */
export interface HostProcess {
  readonly pid: number | undefined
  postMessage(message: HostRequest, transfer?: MessagePortMain[]): void
  kill(): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number | null) => void): void
}

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface SupervisorOptions {
  spawn: () => HostProcess
  logger: Logger
  /** Độ trễ trước mỗi lần restart liên tiếp; lần sau dùng phần tử kế tiếp, hết thì giữ phần tử cuối. */
  restartDelaysMs?: readonly number[]
  /** Chạy ổn định lâu hơn mức này thì reset chuỗi backoff. */
  stableAfterMs?: number
  /** Không gửi `ready` trong thời gian này thì coi như treo khi khởi động. */
  readyTimeoutMs?: number
  healthIntervalMs?: number
  /** Ping không được trả lời trong thời gian này thì coi như treo. */
  healthTimeoutMs?: number
  requestTimeoutMs?: number
  now?: () => number
}

type StatusListener = (status: SessionHostStatus) => void
type EventListener = (event: HostEvent) => void

interface Pending {
  resolve: (event: HostEvent) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Khởi động, giám sát và tự restart Session Host.
 * Phát hiện cả crash (process thoát) lẫn treo (không trả lời ping).
 */
export class SessionHostSupervisor {
  private readonly opts: Required<Omit<SupervisorOptions, 'spawn' | 'logger'>>
  private child: HostProcess | null = null
  private status: SessionHostStatus = { state: 'stopped', pid: null, restarts: 0, lastExit: null }
  private stopping = false
  private consecutiveFailures = 0
  private readyAt: number | null = null
  private killReason: string | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private pingSentAt: number | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly statusListeners = new Set<StatusListener>()
  private readonly eventListeners = new Set<EventListener>()

  constructor(private readonly deps: SupervisorOptions) {
    this.opts = {
      restartDelaysMs: deps.restartDelaysMs ?? [250, 1_000, 2_000, 5_000, 10_000, 30_000],
      stableAfterMs: deps.stableAfterMs ?? 60_000,
      readyTimeoutMs: deps.readyTimeoutMs ?? 10_000,
      healthIntervalMs: deps.healthIntervalMs ?? 5_000,
      healthTimeoutMs: deps.healthTimeoutMs ?? 10_000,
      requestTimeoutMs: deps.requestTimeoutMs ?? 10_000,
      now: deps.now ?? Date.now
    }
  }

  getStatus(): SessionHostStatus {
    return structuredClone(this.status)
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  start(): void {
    if (this.child) return
    this.stopping = false
    this.setStatus({ state: 'starting' })
    this.spawnChild()
  }

  stop(): void {
    this.stopping = true
    this.clearTimers()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.rejectAllPending(new Error(t('The session host stopped')))
    if (this.child) {
      this.child.kill()
    } else {
      this.setStatus({ state: 'stopped', pid: null })
    }
  }

  /** Buộc Session Host thoát (dùng cho E2E kiểm tra tự phục hồi). */
  crashForTest(): void {
    this.child?.postMessage({ type: 'crash' })
  }

  /** Chuyển một đầu MessagePort sang Session Host để nối thẳng với renderer. */
  openSession(
    sessionId: string,
    spec: ResolvedSessionSpec,
    port: MessagePortMain,
    ssh?: Extract<HostRequestType, { type: 'session:open' }>['ssh'],
    log?: Extract<HostRequestType, { type: 'session:open' }>['log']
  ): void {
    const child = this.child
    if (!child || this.status.state !== 'running') {
      port.close()
      throw new Error(t('The session host is not ready ({state})', { state: this.status.state }))
    }
    child.postMessage(
      { type: 'session:open', sessionId, spec, ...(ssh ? { ssh } : {}), ...(log ? { log } : {}) },
      [port]
    )
  }

  /** Gửi tin trả lời cho Session Host (ví dụ kết quả kiểm tra host key). */
  send(message: HostRequest): void {
    if (this.status.state === 'running') this.child?.postMessage(message)
  }

  closeSession(sessionId: string): void {
    if (this.status.state === 'running')
      this.child?.postMessage({ type: 'session:close', sessionId })
  }

  async selfCheck(): Promise<NativeModuleStatus[]> {
    const id = this.nextId++
    const event = await this.request({ type: 'selfcheck', id }, id)
    if (event.type !== 'selfcheck:result') throw new Error(`Invalid response: ${event.type}`)
    return event.modules
  }

  private request(message: HostRequest, id: number): Promise<HostEvent> {
    const child = this.child
    if (!child || this.status.state !== 'running') {
      return Promise.reject(
        new Error(t('The session host is not ready ({state})', { state: this.status.state }))
      )
    }
    return new Promise<HostEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(t('The session host did not respond in time')))
      }, this.opts.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.postMessage(message)
    })
  }

  private spawnChild(): void {
    let child: HostProcess
    try {
      child = this.deps.spawn()
    } catch (error) {
      this.deps.logger.error(`Could not spawn the session host: ${String(error)}`)
      this.handleExit(null, 'spawn-failed')
      return
    }
    this.child = child
    this.readyAt = null
    this.killReason = null
    this.pingSentAt = null

    child.onMessage((raw) => {
      if (this.child === child) this.handleMessage(raw)
    })
    child.onExit((code) => {
      if (this.child !== child) return
      this.child = null
      this.handleExit(code, this.killReason ?? 'exited')
    })

    this.readyTimer = setTimeout(() => {
      this.killChild('ready-timeout')
    }, this.opts.readyTimeoutMs)
  }

  private handleMessage(raw: unknown): void {
    const parsed = HostEvent.safeParse(raw)
    if (!parsed.success) {
      this.deps.logger.warn(
        `Ignoring invalid message from the session host: ${parsed.error.message}`
      )
      return
    }
    const event = parsed.data
    switch (event.type) {
      case 'ready':
        if (this.readyTimer) clearTimeout(this.readyTimer)
        this.readyTimer = null
        this.readyAt = this.opts.now()
        this.setStatus({ state: 'running', pid: event.pid })
        this.startHealthChecks()
        this.deps.logger.info(`Session host ready (pid ${event.pid})`)
        break
      case 'pong':
        this.pingSentAt = null
        break
      case 'selfcheck:result': {
        const pending = this.pending.get(event.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(event.id)
          pending.resolve(event)
        }
        break
      }
      case 'log':
        this.deps.logger[event.level === 'debug' ? 'info' : event.level](
          `[session-host] ${event.message}`
        )
        break
    }
    for (const listener of this.eventListeners) listener(event)
  }

  private startHealthChecks(): void {
    this.healthTimer = setInterval(() => {
      const child = this.child
      if (!child) return
      const now = this.opts.now()
      if (this.pingSentAt !== null) {
        if (now - this.pingSentAt >= this.opts.healthTimeoutMs) this.killChild('unresponsive')
        return
      }
      this.pingSentAt = now
      child.postMessage({ type: 'ping', id: this.nextId++ })
    }, this.opts.healthIntervalMs)
  }

  private killChild(reason: string): void {
    if (!this.child) return
    this.deps.logger.warn(`Stopping session host: ${reason}`)
    this.killReason = reason
    this.child.kill()
  }

  private handleExit(code: number | null, reason: string): void {
    this.clearTimers()
    this.rejectAllPending(new Error(t('The session host exited ({reason})', { reason })))

    if (this.stopping) {
      this.setStatus({ state: 'stopped', pid: null })
      return
    }

    const now = this.opts.now()
    if (this.readyAt !== null && now - this.readyAt >= this.opts.stableAfterMs) {
      this.consecutiveFailures = 0
    }
    const delays = this.opts.restartDelaysMs
    const delay = delays[Math.min(this.consecutiveFailures, delays.length - 1)] ?? 1_000
    this.consecutiveFailures++

    this.deps.logger.error(
      `Session host exited unexpectedly (code ${String(code)}, ${reason}); restarting in ${delay} ms`
    )
    this.setStatus({
      state: 'restarting',
      pid: null,
      restarts: this.status.restarts + 1,
      lastExit: { code, reason, at: now }
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.spawnChild()
    }, delay)
  }

  private clearTimers(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.readyTimer = null
    this.healthTimer = null
    this.pingSentAt = null
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private setStatus(patch: Partial<SessionHostStatus>): void {
    this.status = { ...this.status, ...patch }
    const snapshot = this.getStatus()
    for (const listener of this.statusListeners) listener(snapshot)
  }
}
