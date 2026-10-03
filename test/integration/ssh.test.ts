import { writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PromptRequest, SshSessionSpec } from '@shared/stream-protocol'
import {
  hostKeyAlgorithms,
  openSshShell,
  type HopConfig,
  type SshOpenOptions,
  type SshShell
} from '../../src/session-host/ssh/connect'
import type { StoredCredentials } from '../../src/session-host/ssh/auth'
import type { PromptReply, Transport, TransportExit } from '../../src/session-host/transport/types'
import { tempDir } from '../unit/helpers'
import {
  generateTestKey,
  startProxy,
  startTestSshServer,
  type TestSshServer,
  type TestUser
} from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function server(users: TestUser[]): Promise<TestSshServer> {
  const s = await startTestSshServer(users)
  cleanups.push(() => s.close())
  return s
}

type Answer = (req: PromptRequest) => PromptReply

interface Harness {
  transport: Transport
  prompts: PromptRequest[]
  trusted: Buffer[]
  output: () => string
  waitFor(text: string, timeoutMs?: number): Promise<void>
  exit: Promise<TransportExit>
}

interface ConnectOpts {
  port: number
  username: string
  answer?: Answer
  hostKey?: 'unknown' | 'match' | 'reject'
  keyFiles?: string[]
  credentials?: StoredCredentials
  timeouts?: SshOpenOptions['timeouts']
  jumps?: HopConfig[]
  /** Ghi lại các host được hỏi host key (theo thứ tự). */
  verifiedHosts?: string[]
  /** Đường dẫn agent (mặc định: không dùng agent). */
  agent?: string
  logs?: string[]
  storedOnly?: boolean
  shell?: boolean
}

async function connectTo(opts: ConnectOpts): Promise<Harness> {
  const prompts: PromptRequest[] = []
  const trusted: Buffer[] = []
  let text = ''
  const waiters: (() => void)[] = []
  let resolveExit: (e: TransportExit) => void = () => undefined
  const exit = new Promise<TransportExit>((r) => (resolveExit = r))
  const spec: SshSessionSpec = {
    kind: 'ssh',
    cols: 100,
    rows: 30,
    target: { host: '127.0.0.1', port: opts.port, username: opts.username }
  }
  const hostKeyMode = opts.hostKey ?? 'unknown'
  const transport = await openSshShell({
    destination: {
      target: spec.target,
      knownKeyTypes: [],
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      ...(opts.storedOnly ? { storedOnly: true } : {})
    },
    ...(opts.jumps ? { jumps: opts.jumps } : {}),
    cols: spec.cols,
    rows: spec.rows,
    ...(opts.shell === false ? { shell: false } : {}),
    agent: opts.agent ?? null,
    keyFiles: opts.keyFiles ?? [],
    ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
    callbacks: {
      onData: (d) => {
        text += Buffer.from(d).toString('utf8')
        for (const w of waiters.splice(0)) w()
      },
      onExit: resolveExit
    },
    ctx: {
      status: () => undefined,
      log: (_level, message) => {
        opts.logs?.push(message)
      },
      prompt: (req) => {
        prompts.push(req)
        return Promise.resolve(opts.answer?.(req) ?? { ok: false, answers: [] })
      },
      verifyHostKey: (h, p, key) => {
        opts.verifiedHosts?.push(`${h}:${p}`)
        if (hostKeyMode === 'match') return Promise.resolve(true)
        if (hostKeyMode === 'reject') return Promise.resolve(false)
        prompts.push({
          kind: 'hostkey',
          key: { host: '', port: 0, keyType: '', fingerprint: '', randomart: '' },
          changedFrom: null
        })
        trusted.push(key)
        return Promise.resolve(true)
      }
    }
  })
  cleanups.push(() => {
    transport.close()
  })
  const waitFor = async (needle: string, timeoutMs = 3_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!text.includes(needle)) {
      if (Date.now() > deadline)
        throw new Error(`Không thấy "${needle}" trong: ${JSON.stringify(text)}`)
      await new Promise<void>((r) => {
        waiters.push(r)
        setTimeout(r, 50)
      })
    }
  }
  return { transport, prompts, trusted, output: () => text, waitFor, exit }
}

const password =
  (pw: string): Answer =>
  (req) =>
    req.kind === 'password' ? { ok: true, answers: [pw] } : { ok: false, answers: [] }

describe('SSH: xác thực', () => {
  it('password qua prompt; host mới được hỏi và tin; shell chạy', async () => {
    const s = await server([{ username: 'alice', password: 's3cret' }])
    const h = await connectTo({ port: s.port, username: 'alice', answer: password('s3cret') })
    expect(h.trusted[0]?.equals(s.hostKeyBlob)).toBe(true)
    expect(h.prompts.map((p) => p.kind)).toEqual(['hostkey', 'password'])
    await h.waitFor('welcome')
    h.transport.write('echo xin-chao\r')
    await h.waitFor('xin-chao\r\n')
    expect(s.events.ptyRequests[0]).toEqual({ cols: 100, rows: 30, term: 'xterm-256color' })
  })

  it('agent không chạy (Windows không bật OpenSSH agent / Pageant) → bỏ qua, vẫn đăng nhập bằng password', async () => {
    // Server cho cả publickey (để app thử agent trước) lẫn password.
    const s = await server([
      { username: 'alice', password: 's3cret', publicKey: generateTestKey().public }
    ])
    const logs: string[] = []
    const h = await connectTo({
      port: s.port,
      username: 'alice',
      hostKey: 'match',
      answer: password('s3cret'),
      agent:
        process.platform === 'win32'
          ? '\\\\.\\pipe\\shellhouse-no-such-agent'
          : join(tempDir(), 'no-such-agent.sock'),
      logs
    })
    await h.waitFor('welcome')
    expect(logs.some((l) => l.startsWith('SSH agent unavailable'))).toBe(true)
  })

  it('host đặt rõ Password: chỉ gửi password đã lưu — không thử agent, không thử key mặc định', async () => {
    const key = generateTestKey()
    const keyFile = join(tempDir(), 'id_ed25519')
    writeFileSync(keyFile, key.private)
    const s = await server([{ username: 'alice', password: 's3cret', publicKey: key.public }])
    const logs: string[] = []
    const h = await connectTo({
      port: s.port,
      username: 'alice',
      hostKey: 'match',
      credentials: { password: 's3cret' },
      storedOnly: true,
      keyFiles: [keyFile],
      agent:
        process.platform === 'win32'
          ? '\\\\.\\pipe\\shellhouse-no-such-agent'
          : join(tempDir(), 'no-such-agent.sock'),
      logs
    })
    await h.waitFor('welcome')
    expect(logs.some((l) => l.includes('agent'))).toBe(false)
    expect(s.events.authAttempts.map((a) => a.method)).not.toContain('publickey')
    expect(h.prompts.filter((p) => p.kind === 'password')).toEqual([])
  })

  it('sai password 3 lần → thất bại, không hỏi quá 3 lần', async () => {
    const s = await server([{ username: 'alice', password: 's3cret' }])
    const prompts: PromptRequest[] = []
    await expect(
      connectTo({
        port: s.port,
        username: 'alice',
        hostKey: 'match',
        answer: (req) => {
          prompts.push(req)
          return { ok: true, answers: ['sai'] }
        }
      })
    ).rejects.toThrow(/authentication methods failed/i)
    expect(prompts.filter((p) => p.kind === 'password')).toHaveLength(3)
  })

  it('huỷ ô nhập password → dừng ngay', async () => {
    const s = await server([{ username: 'alice', password: 's3cret' }])
    let asked = 0
    await expect(
      connectTo({
        port: s.port,
        username: 'alice',
        hostKey: 'match',
        answer: () => {
          asked++
          return { ok: false, answers: [] }
        }
      })
    ).rejects.toThrow()
    expect(asked).toBe(1)
  })

  it('từ chối host key → không xác thực, không gửi password', async () => {
    const s = await server([{ username: 'alice', password: 's3cret' }])
    await expect(
      connectTo({ port: s.port, username: 'alice', hostKey: 'reject', answer: password('s3cret') })
    ).rejects.toThrow()
    expect(s.events.authAttempts).toHaveLength(0)
  })

  it('password đã lưu → không hỏi', async () => {
    const s = await server([{ username: 'alice', password: 's3cret' }])
    const h = await connectTo({
      port: s.port,
      username: 'alice',
      hostKey: 'match',
      credentials: { password: 's3cret' }
    })
    expect(h.prompts).toHaveLength(0)
    await h.waitFor('welcome')
  })

  it('key file không mã hoá → đăng nhập không cần prompt', async () => {
    const key = generateTestKey()
    const keyFile = join(tempDir(), 'id_ed25519')
    writeFileSync(keyFile, key.private)
    const s = await server([{ username: 'bob', publicKey: key.public }])
    const h = await connectTo({
      port: s.port,
      username: 'bob',
      hostKey: 'match',
      keyFiles: [keyFile]
    })
    expect(h.prompts).toHaveLength(0)
    await h.waitFor('welcome')
  })

  it('key có passphrase → hỏi passphrase (sai lần đầu, đúng lần hai)', async () => {
    const key = generateTestKey('pp-123')
    const keyFile = join(tempDir(), 'id_ed25519')
    writeFileSync(keyFile, key.private)
    const s = await server([{ username: 'bob', publicKey: key.public }])
    const answers = ['sai', 'pp-123']
    const h = await connectTo({
      port: s.port,
      username: 'bob',
      hostKey: 'match',
      keyFiles: [keyFile],
      answer: (req) =>
        req.kind === 'passphrase'
          ? { ok: true, answers: [answers.shift() ?? ''] }
          : { ok: false, answers: [] }
    })
    expect(h.prompts.map((p) => p.kind)).toEqual(['passphrase', 'passphrase'])
    await h.waitFor('welcome')
  }, 30_000) // sinh khoá có passphrase + hai lượt bắt tay: chậm khi máy bận

  it('2FA: publickey rồi keyboard-interactive (OTP)', async () => {
    const key = generateTestKey()
    const keyFile = join(tempDir(), 'id')
    writeFileSync(keyFile, key.private)
    const s = await server([{ username: 'carol', publicKey: key.public, otp: '424242' }])
    const h = await connectTo({
      port: s.port,
      username: 'carol',
      hostKey: 'match',
      keyFiles: [keyFile],
      answer: (req) =>
        req.kind === 'keyboard-interactive'
          ? { ok: true, answers: ['424242'] }
          : { ok: false, answers: [] }
    })
    const kbd = h.prompts.find((p) => p.kind === 'keyboard-interactive')
    expect(kbd).toMatchObject({ fields: [{ prompt: 'Mã OTP: ', echo: false }] })
    await h.waitFor('welcome')
  })
})

describe('SSH: ProxyJump', () => {
  it('qua 2 jump host: mỗi chặng kiểm tra host key + xác thực riêng, đích thấy shell', async () => {
    const target = await server([{ username: 'app', password: 'pw-target' }])
    const inner = await server([{ username: 'j2', password: 'pw-inner' }])
    const outer = await server([{ username: 'j1', password: 'pw-outer' }])
    const verifiedHosts: string[] = []
    const passwordsAsked: string[] = []
    const passwords: Record<string, string> = { j1: 'pw-outer', j2: 'pw-inner', app: 'pw-target' }

    const h = await connectTo({
      port: target.port,
      username: 'app',
      hostKey: 'match',
      verifiedHosts,
      jumps: [
        { target: { host: '127.0.0.1', port: outer.port, username: 'j1' }, knownKeyTypes: [] },
        { target: { host: '127.0.0.1', port: inner.port, username: 'j2' }, knownKeyTypes: [] }
      ],
      answer: (req) => {
        if (req.kind !== 'password') return { ok: false, answers: [] }
        passwordsAsked.push(req.username)
        return { ok: true, answers: [passwords[req.username] ?? ''] }
      }
    })
    await h.waitFor('welcome')
    h.transport.write('echo qua-2-chang\r')
    await h.waitFor('qua-2-chang\r\n')

    expect(verifiedHosts).toEqual([
      `127.0.0.1:${outer.port}`,
      `127.0.0.1:${inner.port}`,
      `127.0.0.1:${target.port}`
    ])
    expect(passwordsAsked).toEqual(['j1', 'j2', 'app'])
    // Chặng ngoài mở kênh tới chặng trong; chặng trong mở kênh tới đích.
    expect(outer.events.directTcpip).toEqual([{ destIP: '127.0.0.1', destPort: inner.port }])
    expect(inner.events.directTcpip).toEqual([{ destIP: '127.0.0.1', destPort: target.port }])
  })

  it('jump host sập → shell ở đích cũng kết thúc với lỗi', async () => {
    const target = await server([{ username: 'app', password: 'p' }])
    const jump = await startTestSshServer([{ username: 'j', password: 'p' }])
    const h = await connectTo({
      port: target.port,
      username: 'app',
      hostKey: 'match',
      credentials: { password: 'p' },
      jumps: [
        {
          target: { host: '127.0.0.1', port: jump.port, username: 'j' },
          knownKeyTypes: [],
          credentials: { password: 'p' }
        }
      ]
    })
    await h.waitFor('$ ')
    await jump.close()
    const exit = await h.exit
    expect(exit.error).toBeTruthy()
  })

  it('jump host không cho chuyển tiếp → lỗi rõ ràng', async () => {
    const target = await server([{ username: 'app', password: 'p' }])
    const jump = await startTestSshServer([{ username: 'j', password: 'p' }], {
      allowTcpForwarding: false
    })
    cleanups.push(() => jump.close())
    await expect(
      connectTo({
        port: target.port,
        username: 'app',
        hostKey: 'match',
        credentials: { password: 'p' },
        jumps: [
          {
            target: { host: '127.0.0.1', port: jump.port, username: 'j' },
            knownKeyTypes: [],
            credentials: { password: 'p' }
          }
        ]
      })
    ).rejects.toThrow(/could not open a channel/)
  })
})

describe('SSH: chỉ truyền file (không mở shell)', () => {
  it('không có yêu cầu PTY/shell tới server; SFTP vẫn dùng được; đóng thì báo kết thúc', async () => {
    const s = await server([{ username: 'alice', password: 's3cret' }])
    const h = await connectTo({
      port: s.port,
      username: 'alice',
      hostKey: 'match',
      credentials: { password: 's3cret' },
      shell: false
    })
    expect(s.events.ptyRequests).toEqual([])
    const shell = h.transport as SshShell
    const channel = await new Promise((resolve, reject) => {
      shell.client.sftp((err, sftp) => {
        if (err) reject(err)
        else resolve(sftp)
      })
    })
    expect(channel).toBeTruthy()
    h.transport.write('ignored\r') // không có shell → không làm gì, không lỗi
    h.transport.close()
    await expect(h.exit).resolves.toBeTruthy()
  })
})

describe('SSH: phiên làm việc', () => {
  it('resize gửi window-change', async () => {
    const s = await server([{ username: 'a', password: 'p' }])
    const h = await connectTo({
      port: s.port,
      username: 'a',
      hostKey: 'match',
      credentials: { password: 'p' }
    })
    await h.waitFor('$ ')
    h.transport.resize(132, 43)
    h.transport.write('size\r')
    await h.waitFor('SIZE=132x43')
    expect(s.events.windowChanges).toContainEqual({ cols: 132, rows: 43 })
  })

  it('exit trả về mã thoát, không có lỗi', async () => {
    const s = await server([{ username: 'a', password: 'p' }])
    const h = await connectTo({
      port: s.port,
      username: 'a',
      hostKey: 'match',
      credentials: { password: 'p' }
    })
    await h.waitFor('$ ')
    h.transport.write('exit 3\r')
    const exit = await h.exit
    expect(exit.code).toBe(3)
    expect(exit.error).toBeUndefined()
  })

  it('mất mạng (không có RST) → keepalive phát hiện và báo lỗi', async () => {
    const s = await server([{ username: 'a', password: 'p' }])
    const proxy = await startProxy(s.port)
    cleanups.push(() => proxy.close())
    const h = await connectTo({
      port: proxy.port,
      username: 'a',
      hostKey: 'match',
      credentials: { password: 'p' },
      timeouts: { keepaliveIntervalMs: 100, keepaliveCountMax: 2 }
    })
    await h.waitFor('$ ')
    const frozenAt = Date.now()
    proxy.freeze()
    const exit = await h.exit
    expect(exit.error).toBeTruthy()
    expect(Date.now() - frozenAt).toBeLessThan(2_000)
  })
})

describe('SSH: lỗi kết nối', () => {
  it('port đóng → lỗi nhanh', async () => {
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((r) => {
      probe.close(() => {
        r()
      })
    })
    await expect(connectTo({ port, username: 'x' })).rejects.toThrow(/ECONNREFUSED/)
  })

  it('server nhận TCP nhưng không bắt tay → hết thời gian', async () => {
    // Đọc (bỏ) dữ liệu để thấy EOF khi client đóng; không bao giờ trả lời.
    const silent = createServer((c) => c.resume())
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          silent.close(() => {
            r()
          })
        })
    )
    const port = (silent.address() as AddressInfo).port
    const started = Date.now()
    await expect(
      connectTo({ port, username: 'x', timeouts: { handshakeMs: 300 } })
    ).rejects.toThrow(/handshake/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('hostKeyAlgorithms', () => {
  it('ưu tiên loại key đã biết, không có ssh-rsa SHA-1', () => {
    expect(hostKeyAlgorithms([])[0]).toBe('ssh-ed25519')
    expect(hostKeyAlgorithms(['ssh-rsa']).slice(0, 2)).toEqual(['rsa-sha2-512', 'rsa-sha2-256'])
    expect(hostKeyAlgorithms(['ecdsa-sha2-nistp384'])[0]).toBe('ecdsa-sha2-nistp384')
    expect(hostKeyAlgorithms(['ssh-ed25519'])).not.toContain('ssh-rsa')
    expect(new Set(hostKeyAlgorithms(['ssh-ed25519'])).size).toBe(
      hostKeyAlgorithms(['ssh-ed25519']).length
    )
  })
})
