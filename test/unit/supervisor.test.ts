import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostRequest } from '@shared/session-host-protocol'
import type { SessionHostStatus } from '@shared/ipc'
import { SessionHostSupervisor, type HostProcess } from '../../src/main/session-host/supervisor'

/** Child process giả, điều khiển được từ test. */
class FakeHost implements HostProcess {
  static nextPid = 100
  readonly pid = FakeHost.nextPid++
  readonly sent: HostRequest[] = []
  killed = false
  /** Khi true, không trả lời ping (mô phỏng treo). */
  hung = false
  private messageListener: ((m: unknown) => void) | null = null
  private exitListener: ((code: number | null) => void) | null = null

  postMessage(message: HostRequest): void {
    this.sent.push(message)
    if (message.type === 'ping' && !this.hung) this.emit({ type: 'pong', id: message.id })
  }
  kill(): void {
    this.killed = true
    this.exit(null)
  }
  onMessage(listener: (m: unknown) => void): void {
    this.messageListener = listener
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener
  }
  emit(message: unknown): void {
    this.messageListener?.(message)
  }
  ready(): void {
    this.emit({ type: 'ready', pid: this.pid })
  }
  exit(code: number | null): void {
    this.exitListener?.(code)
  }
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function setup(options: Partial<ConstructorParameters<typeof SessionHostSupervisor>[0]> = {}) {
  const hosts: FakeHost[] = []
  const statuses: SessionHostStatus[] = []
  const supervisor = new SessionHostSupervisor({
    spawn: () => {
      const host = new FakeHost()
      hosts.push(host)
      return host
    },
    logger: silentLogger,
    restartDelaysMs: [100, 500, 1_000],
    stableAfterMs: 10_000,
    readyTimeoutMs: 2_000,
    healthIntervalMs: 1_000,
    healthTimeoutMs: 3_000,
    requestTimeoutMs: 1_000,
    now: () => Date.now(),
    ...options
  })
  supervisor.onStatus((s) => statuses.push(s))
  const last = (): FakeHost => {
    const host = hosts.at(-1)
    if (!host) throw new Error('chưa spawn')
    return host
  }
  return { supervisor, hosts, statuses, last }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SessionHostSupervisor', () => {
  it('chuyển sang running khi nhận ready', () => {
    const { supervisor, last } = setup()
    supervisor.start()
    expect(supervisor.getStatus().state).toBe('starting')
    last().ready()
    expect(supervisor.getStatus()).toMatchObject({ state: 'running', pid: last().pid, restarts: 0 })
  })

  it('tự khởi động lại khi process crash', () => {
    const { supervisor, hosts, last } = setup()
    supervisor.start()
    last().ready()
    last().exit(70)

    expect(supervisor.getStatus()).toMatchObject({
      state: 'restarting',
      restarts: 1,
      lastExit: { code: 70, reason: 'exited' }
    })
    vi.advanceTimersByTime(100)
    expect(hosts).toHaveLength(2)
    last().ready()
    expect(supervisor.getStatus().state).toBe('running')
  })

  it('tăng dần độ trễ khi crash liên tục và giữ ở mức tối đa', () => {
    const { supervisor, hosts, last } = setup()
    supervisor.start()
    for (const delay of [100, 500, 1_000, 1_000]) {
      last().exit(1)
      vi.advanceTimersByTime(delay - 1)
      const before = hosts.length
      vi.advanceTimersByTime(1)
      expect(hosts.length).toBe(before + 1)
    }
  })

  it('reset backoff sau khi chạy ổn định đủ lâu', () => {
    const { supervisor, hosts, last } = setup()
    supervisor.start()
    last().exit(1) // lần 1 → 100 ms
    vi.advanceTimersByTime(100)
    last().exit(1) // lần 2 → 500 ms
    vi.advanceTimersByTime(500)
    last().ready()
    vi.advanceTimersByTime(10_000) // chạy ổn định
    last().exit(1)
    vi.advanceTimersByTime(100)
    expect(hosts).toHaveLength(4)
  })

  it('giết và khởi động lại khi process treo (không trả lời ping)', () => {
    const { supervisor, hosts, last } = setup()
    supervisor.start()
    const first = last()
    first.ready()
    first.hung = true
    vi.advanceTimersByTime(1_000 + 3_000)
    expect(first.killed).toBe(true)
    expect(supervisor.getStatus().lastExit?.reason).toBe('unresponsive')
    vi.advanceTimersByTime(100)
    expect(hosts).toHaveLength(2)
  })

  it('giết process không gửi ready trong thời hạn', () => {
    const { supervisor, last } = setup()
    supervisor.start()
    vi.advanceTimersByTime(2_000)
    expect(last().killed).toBe(true)
    expect(supervisor.getStatus().lastExit?.reason).toBe('ready-timeout')
  })

  it('không restart sau khi stop()', () => {
    const { supervisor, hosts, last } = setup()
    supervisor.start()
    last().ready()
    supervisor.stop()
    expect(supervisor.getStatus().state).toBe('stopped')
    vi.advanceTimersByTime(60_000)
    expect(hosts).toHaveLength(1)
  })

  it('bỏ qua tin nhắn sai định dạng thay vì crash', () => {
    const { supervisor, last } = setup()
    supervisor.start()
    last().emit({ type: 'ready' }) // thiếu pid
    last().emit('rác')
    expect(supervisor.getStatus().state).toBe('starting')
    expect(silentLogger.warn).toHaveBeenCalled()
  })

  it('selfCheck trả kết quả theo id', async () => {
    const { supervisor, last } = setup()
    supervisor.start()
    last().ready()
    const promise = supervisor.selfCheck()
    const request = last().sent.find((m) => m.type === 'selfcheck')
    expect(request).toBeDefined()
    last().emit({
      type: 'selfcheck:result',
      id: request?.type === 'selfcheck' ? request.id : -1,
      modules: [{ name: 'node-pty', process: 'session-host', ok: true, detail: 'ok' }]
    })
    await expect(promise).resolves.toHaveLength(1)
  })

  it('selfCheck bị reject khi process chết giữa chừng', async () => {
    const { supervisor, last } = setup()
    supervisor.start()
    last().ready()
    const promise = supervisor.selfCheck()
    last().exit(1)
    await expect(promise).rejects.toThrow(/exited/)
  })

  it('selfCheck bị reject khi chưa sẵn sàng', async () => {
    const { supervisor } = setup()
    supervisor.start()
    await expect(supervisor.selfCheck()).rejects.toThrow(/not ready/)
  })

  it('selfCheck hết hạn nếu không có phản hồi', async () => {
    const { supervisor, last } = setup()
    supervisor.start()
    last().ready()
    const promise = supervisor.selfCheck()
    vi.advanceTimersByTime(1_000)
    await expect(promise).rejects.toThrow(/did not respond in time/)
  })

  it('bỏ qua sự kiện từ process cũ sau khi đã restart', () => {
    const { supervisor, last } = setup()
    supervisor.start()
    const old = last()
    old.ready()
    old.exit(1)
    vi.advanceTimersByTime(100)
    old.ready() // process cũ không còn được theo dõi
    // Vẫn là 'restarting' cho tới khi process MỚI gửi ready.
    expect(supervisor.getStatus().state).toBe('restarting')
    last().ready()
    expect(supervisor.getStatus()).toMatchObject({ state: 'running', pid: last().pid })
  })
})
