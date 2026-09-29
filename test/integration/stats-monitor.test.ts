import { afterEach, describe, expect, it } from 'vitest'
import type { ServerStats } from '@shared/server-stats'
import { openSshShell } from '../../src/session-host/ssh/connect'
import { StatsMonitor } from '../../src/session-host/ssh/stats-monitor'
import { tempDir } from '../unit/helpers'
import { startTestSshServer } from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function connect(options: { exec: boolean }) {
  const server = await startTestSshServer(
    [{ username: 'u', password: 'p' }],
    options.exec ? { execHome: tempDir() } : {}
  )
  cleanups.push(() => server.close())
  const shell = await openSshShell({
    destination: {
      target: { host: '127.0.0.1', port: server.port, username: 'u' },
      knownKeyTypes: [],
      credentials: { password: 'p' }
    },
    cols: 80,
    rows: 24,
    agent: null,
    keyFiles: [],
    callbacks: { onData: () => undefined, onExit: () => undefined },
    ctx: {
      status: () => undefined,
      log: () => undefined,
      prompt: () => Promise.resolve({ ok: false, answers: [] }),
      verifyHostKey: () => Promise.resolve(true)
    }
  })
  cleanups.push(() => {
    shell.close()
  })
  return shell
}

async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Hết giờ chờ: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

// Server thử chạy lệnh bằng /bin/sh của máy test: Linux có /proc, macOS thì không.
describe.skipIf(process.platform === 'win32')('Thanh theo dõi server (kênh exec riêng)', () => {
  it.runIf(process.platform === 'linux')(
    'Linux: số liệu thật, lần đo thứ hai có CPU %',
    async () => {
      const shell = await connect({ exec: true })
      const updates: ServerStats[] = []
      const monitor = new StatsMonitor(shell.client, (u) => {
        if ('stats' in u) updates.push(u.stats)
      })
      cleanups.push(() => {
        monitor.stop()
      })
      monitor.start()
      await until(() => updates.length >= 2, 'hai lần đo')
      const [first, second] = updates
      expect(first?.cpu).toBeNull()
      expect(second?.cpu).toBeGreaterThanOrEqual(0)
      expect(second?.memTotal).toBeGreaterThan(0)
      expect(second?.uptimeSeconds).toBeGreaterThan(0)
    }
  )

  it.runIf(process.platform === 'darwin')('macOS (không có /proc): báo không hỗ trợ', async () => {
    const shell = await connect({ exec: true })
    let reason = ''
    const monitor = new StatsMonitor(shell.client, (u) => {
      if ('unsupported' in u) reason = u.unsupported
    })
    monitor.start()
    await until(() => reason !== '', 'báo không hỗ trợ')
    expect(reason).toMatch(/Linux/)
  })

  it('server không cho exec (thiết bị mạng…) → báo không hỗ trợ, không lỗi', async () => {
    const shell = await connect({ exec: false })
    let reason = ''
    const monitor = new StatsMonitor(shell.client, (u) => {
      if ('unsupported' in u) reason = u.unsupported
    })
    monitor.start()
    await until(() => reason !== '', 'báo không hỗ trợ')
    // Đã báo một lần thì start lại không làm gì.
    monitor.start()
    expect(monitor.running).toBe(false)
  })
})
