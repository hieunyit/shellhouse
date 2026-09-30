import { afterEach, describe, expect, it } from 'vitest'
import { HostModuleRegistry } from '../../src/modules/registry/session-host'
import type { HostKeyCheck } from '@shared/session-host-protocol'
import type { ServerMessage } from '@shared/stream-protocol'
import {
  Session,
  type HostKeyService,
  type SessionPort
} from '../../src/session-host/session/session'
import { startTestSshServer, type TestSshServer } from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** MessagePort giả: ghi lại tin gửi ra, cho test bơm tin vào. */
class FakePort implements SessionPort {
  readonly sent: ServerMessage[] = []
  private listener: ((data: unknown) => void) | null = null
  private closeListener: (() => void) | null = null
  private waiters: (() => void)[] = []

  postMessage(message: ServerMessage): void {
    this.sent.push(message)
    for (const w of this.waiters.splice(0)) w()
  }
  onMessage(listener: (data: unknown) => void): void {
    this.listener = listener
  }
  onClose(listener: () => void): void {
    this.closeListener = listener
  }
  start(): void {}
  close(): void {
    this.closeListener?.()
  }
  deliver(message: unknown): void {
    this.listener?.(message)
  }
  text(): string {
    return this.sent
      .filter((m): m is Extract<ServerMessage, { t: 'data' }> => m.t === 'data')
      .map((m) => Buffer.from(m.d).toString('utf8'))
      .join('')
  }
  async until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`Hết thời gian chờ; đã nhận: ${JSON.stringify(this.sent.map((m) => m.t))}`)
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 50)
      })
    }
  }
}

function hostKeys(result: HostKeyCheck): HostKeyService & { trusted: Buffer[] } {
  const trusted: Buffer[] = []
  return {
    trusted,
    check: () => Promise.resolve(result),
    trust: (_h, _p, key) => {
      trusted.push(key)
    }
  }
}

function sshSession(
  server: TestSshServer,
  keys: HostKeyService
): { port: FakePort; session: Session; ended: string[] } {
  const port = new FakePort()
  const ended: string[] = []
  const session = new Session(
    'test-session',
    {
      kind: 'ssh',
      cols: 80,
      rows: 24,
      target: { host: '127.0.0.1', port: server.port, username: 'alice' }
    },
    port,
    {
      log: () => undefined,
      appVersion: 'test',
      hostKeys: keys,
      onEnded: (id) => ended.push(id),
      modules: new HostModuleRegistry([], {
        log: () => undefined,
        requestProgramGrant: () => Promise.resolve(false)
      }),
      sshOverrides: { agent: null, keyFiles: [] }
    }
  )
  cleanups.push(() => {
    session.close()
  })
  void session.start()
  return { port, session, ended }
}

function lastPrompt(port: FakePort): Extract<ServerMessage, { t: 'prompt' }> | undefined {
  return port.sent
    .filter((m): m is Extract<ServerMessage, { t: 'prompt' }> => m.t === 'prompt')
    .at(-1)
}

describe('Session (SSH qua MessagePort)', () => {
  it('host mới: prompt host key → tin → prompt mật khẩu → shell; phím gõ sớm không bị mất', async () => {
    const server = await startTestSshServer([{ username: 'alice', password: 'pw' }])
    cleanups.push(() => server.close())
    const keys = hostKeys({ status: 'unknown' })
    const { port } = sshSession(server, keys)

    await port.until(() => lastPrompt(port)?.prompt.kind === 'hostkey')
    const hostPrompt = lastPrompt(port)
    if (hostPrompt?.prompt.kind !== 'hostkey') throw new Error('thiếu prompt host key')
    expect(hostPrompt.prompt.changedFrom).toBeNull()
    expect(hostPrompt.prompt.key.randomart).toContain('[SHA256]')

    // Gõ trước khi shell mở — phải được giữ lại.
    port.deliver({ t: 'input', d: 'echo go-som\r' })
    port.deliver({ t: 'prompt-reply', id: hostPrompt.id, ok: true, answers: [] })

    await port.until(() => lastPrompt(port)?.prompt.kind === 'password')
    port.deliver({ t: 'prompt-reply', id: lastPrompt(port)?.id ?? -1, ok: true, answers: ['pw'] })

    await port.until(() => port.text().includes('go-som\r\n'))
    expect(keys.trusted[0]?.equals(server.hostKeyBlob)).toBe(true)
    expect(port.sent.some((m) => m.t === 'status' && m.phase === 'connected')).toBe(true)
  })

  it('từ chối host key đã đổi → exit reason hostkey, không gửi xác thực', async () => {
    const server = await startTestSshServer([{ username: 'alice', password: 'pw' }])
    cleanups.push(() => server.close())
    const keys = hostKeys({
      status: 'changed',
      known: [{ keyType: 'ssh-ed25519', fingerprint: 'SHA256:old' }]
    })
    const { port, ended } = sshSession(server, keys)

    await port.until(() => lastPrompt(port)?.prompt.kind === 'hostkey')
    const prompt = lastPrompt(port)
    if (prompt?.prompt.kind !== 'hostkey') throw new Error('thiếu prompt')
    expect(prompt.prompt.changedFrom).toEqual([
      { keyType: 'ssh-ed25519', fingerprint: 'SHA256:old' }
    ])
    port.deliver({ t: 'prompt-reply', id: prompt.id, ok: false, answers: [] })

    await port.until(() => port.sent.some((m) => m.t === 'exit'))
    expect(port.sent.find((m) => m.t === 'exit')).toMatchObject({ reason: 'hostkey' })
    expect(keys.trusted).toHaveLength(0)
    expect(server.events.authAttempts).toHaveLength(0)
    expect(ended).toEqual(['test-session'])
  })

  it('host key @revoked → từ chối không cần hỏi', async () => {
    const server = await startTestSshServer([{ username: 'alice', password: 'pw' }])
    cleanups.push(() => server.close())
    const { port } = sshSession(server, hostKeys({ status: 'revoked' }))
    await port.until(() => port.sent.some((m) => m.t === 'exit'))
    expect(port.sent.some((m) => m.t === 'prompt')).toBe(false)
    expect(port.sent.find((m) => m.t === 'exit')).toMatchObject({ reason: 'hostkey' })
  })

  it('server sập giữa chừng → exit reason network', async () => {
    const server = await startTestSshServer([{ username: 'alice', password: 'pw' }])
    const { port } = sshSession(server, hostKeys({ status: 'match' }))
    await port.until(() => lastPrompt(port)?.prompt.kind === 'password')
    port.deliver({ t: 'prompt-reply', id: lastPrompt(port)?.id ?? -1, ok: true, answers: ['pw'] })
    await port.until(() => port.text().includes('welcome'))
    await server.close()
    await port.until(() => port.sent.some((m) => m.t === 'exit'))
    expect(port.sent.find((m) => m.t === 'exit')).toMatchObject({ reason: 'network' })
  })

  it('đóng port (renderer đóng tab) trong lúc đang chờ prompt → kết thúc sạch', async () => {
    const server = await startTestSshServer([{ username: 'alice', password: 'pw' }])
    cleanups.push(() => server.close())
    const { port, ended } = sshSession(server, hostKeys({ status: 'match' }))
    await port.until(() => lastPrompt(port)?.prompt.kind === 'password')
    port.close()
    expect(ended).toEqual(['test-session'])
  })
})
