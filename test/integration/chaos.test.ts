import { createHash, randomBytes } from 'node:crypto'
import { connect, createServer, type AddressInfo } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TransferStatus } from '@shared/sftp'
import { ForwardManager } from '../../src/session-host/forward/manager'
import { SftpService } from '../../src/session-host/sftp/service'
import { PART_SUFFIX, TransferQueue } from '../../src/session-host/sftp/transfers'
import { openSshShell, type SshShell } from '../../src/session-host/ssh/connect'
import type { TransportExit } from '../../src/session-host/transport/types'
import { classifyConnectError } from '../../src/session-host/session/exit-reason'
import { tempDir } from '../unit/helpers'
import { startChaosProxy, type ChaosOptions, type ChaosProxy } from './chaos-proxy'
import { findSftpServer, startTestSshServer, type TestSshServer } from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

async function server(opts: { sftpRoot?: string } = {}): Promise<TestSshServer> {
  const s = await startTestSshServer([{ username: 'u', password: 'p' }], opts)
  cleanups.push(() => s.close())
  return s
}

async function proxy(port: number, options: ChaosOptions = {}): Promise<ChaosProxy> {
  const p = await startChaosProxy(port, options)
  cleanups.push(() => p.close())
  return p
}

interface Conn {
  shell: SshShell
  output: () => string
  exit: Promise<TransportExit>
}

async function ssh(port: number, keepaliveMs = 15_000): Promise<Conn> {
  let text = ''
  let resolveExit: (e: TransportExit) => void = () => undefined
  const exit = new Promise<TransportExit>((r) => (resolveExit = r))
  const shell = await openSshShell({
    destination: {
      target: { host: '127.0.0.1', port, username: 'u' },
      knownKeyTypes: [],
      credentials: { password: 'p' }
    },
    cols: 120,
    rows: 40,
    agent: null,
    keyFiles: [],
    timeouts: { keepaliveIntervalMs: keepaliveMs, keepaliveCountMax: 2, handshakeMs: 10_000 },
    callbacks: {
      onData: (d) => {
        text += Buffer.from(d).toString('utf8')
      },
      onExit: resolveExit
    },
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
  return { shell, output: () => text, exit }
}

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('Mạng xấu: terminal', () => {
  it('trễ 150 ms ± 100 ms: 100 lệnh liên tiếp, output đủ và đúng thứ tự', async () => {
    const s = await server()
    const p = await proxy(s.port, { latencyMs: 150, jitterMs: 100 })
    const c = await ssh(p.port)
    await until(() => c.output().includes('$ '), 10_000, 'prompt')
    for (let i = 0; i < 100; i++) c.shell.write(`echo line-${i}-end\r`)
    await until(() => c.output().includes('line-99-end\r\n'), 30_000, 'last line')
    const seen = [...c.output().matchAll(/\r\nline-(\d+)-end\r\n/g)].map((m) => Number(m[1]))
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i))
  }, 40_000)

  it('băng thông 256 KB/s: 1 MB output đến đủ, không mất byte', async () => {
    const s = await server()
    const p = await proxy(s.port, { bytesPerSecond: 256 * 1024 })
    const c = await ssh(p.port)
    await until(() => c.output().includes('$ '), 10_000, 'prompt')
    const before = c.output().length
    c.shell.write('flood 1048576\r')
    await until(() => (c.output().match(/x/g)?.length ?? 0) >= 1048576, 20_000, '1 MB of output')
    expect(c.output().length - before).toBeGreaterThanOrEqual(1048576)
  }, 30_000)

  it('mạng treo (không RST) → keepalive phát hiện trong thời gian giới hạn', async () => {
    const s = await server()
    const p = await proxy(s.port)
    const c = await ssh(p.port, 200)
    await until(() => c.output().includes('$ '), 10_000, 'prompt')
    const started = Date.now()
    p.freeze()
    const exit = await c.exit
    expect(exit.error).toBeTruthy()
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 15_000)

  it('RST giữa lúc bắt tay → lỗi, được phân loại là lỗi mạng (để tự nối lại)', async () => {
    const s = await server()
    const p = await proxy(s.port, { cutAfterDownstreamBytes: 200 })
    const error = await ssh(p.port).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(classifyConnectError(error)).toBe('network')
  }, 15_000)
})

describe.skipIf(!findSftpServer())('Mạng xấu: SFTP', () => {
  async function sftpSetup(port: number) {
    const c = await ssh(port)
    const sftp = new SftpService(c.shell.client)
    const updates: TransferStatus[][] = []
    const queue = new TransferQueue(sftp, (l) => updates.push(l))
    cleanups.push(() => {
      queue.dispose()
      sftp.close()
    })
    const wait = async (id: string, states: TransferStatus['state'][], timeoutMs = 30_000) => {
      let status: TransferStatus | undefined
      await until(
        () => {
          status = queue.list().find((t) => t.id === id)
          return !!status && states.includes(status.state)
        },
        timeoutMs,
        `transfer ${states.join('/')}`
      )
      return status as TransferStatus
    }
    return { queue, wait }
  }

  it('đứt kết nối giữa lúc tải xuống → lỗi (không treo) → kết nối mới tải tiếp đúng sha256', async () => {
    const remote = tempDir()
    const local = tempDir()
    const data = randomBytes(8 * 1024 * 1024)
    writeFileSync(join(remote, 'big.bin'), data)
    const s = await server({ sftpRoot: remote })
    const p = await proxy(s.port, { bytesPerSecond: 4 * 1024 * 1024 })

    const first = await sftpSetup(p.port)
    const id = first.queue.enqueue(
      'download',
      join(local, 'big.bin'),
      join(remote, 'big.bin'),
      false
    )
    await until(
      () => (first.queue.list().find((t) => t.id === id)?.transferred ?? 0) > 2 * 1024 * 1024,
      20_000,
      '2 MB'
    )
    p.cutAll()
    const failed = await first.wait(id, ['error', 'done'])
    expect(failed.state).toBe('error')
    const partSize = readFileSync(join(local, 'big.bin' + PART_SUFFIX)).length
    expect(partSize).toBeGreaterThan(0)

    // Kết nối lại (trực tiếp) và tải lại cùng file → tiếp tục từ file part.
    const second = await sftpSetup(s.port)
    const id2 = second.queue.enqueue(
      'download',
      join(local, 'big.bin'),
      join(remote, 'big.bin'),
      false
    )
    const done = await second.wait(id2, ['done', 'error'])
    expect(done.state).toBe('done')
    expect(done.resumedFrom).toBe(partSize)
    expect(sha(readFileSync(join(local, 'big.bin')))).toBe(sha(data))
  }, 60_000)

  it('mạng treo (không RST) rồi phiên đóng → lượt đang chạy chốt thành lỗi và được báo ngay (không "ma")', async () => {
    const remote = tempDir()
    const local = tempDir()
    writeFileSync(join(remote, 'big.bin'), randomBytes(8 * 1024 * 1024))
    const s = await server({ sftpRoot: remote })
    const p = await proxy(s.port, { bytesPerSecond: 4 * 1024 * 1024 })
    const c = await ssh(p.port)
    const sftp = new SftpService(c.shell.client)
    const updates: TransferStatus[][] = []
    const queue = new TransferQueue(sftp, (l) => updates.push(l))
    const id = queue.enqueue('download', join(local, 'big.bin'), join(remote, 'big.bin'), false)
    await until(
      () => (queue.list().find((t) => t.id === id)?.transferred ?? 0) > 1024 * 1024,
      20_000,
      '1 MB'
    )
    // Treo hẳn: callback của ssh2 không bao giờ được gọi nữa — chỉ dispose() mới chốt được trạng thái.
    p.freeze()
    queue.dispose()
    sftp.close()
    const last = updates.at(-1)?.find((t) => t.id === id)
    expect(last?.state).toBe('error')
    expect(last?.error).toMatch(/Connection closed/)
    expect(last?.bytesPerSecond).toBe(0)
    expect((await queue.settled(id)).state).toBe('error')
    // File part (đủ lớn để tiếp tục) được giữ lại cho lần tải sau.
    await until(() => queue.list().length === 1, 2_000, 'list')
  }, 40_000)

  it('đứt kết nối giữa lúc tải lên → kết nối mới tải tiếp đúng sha256', async () => {
    const remote = tempDir()
    const local = tempDir()
    const data = randomBytes(8 * 1024 * 1024)
    writeFileSync(join(local, 'up.bin'), data)
    const s = await server({ sftpRoot: remote })
    const p = await proxy(s.port, { bytesPerSecond: 4 * 1024 * 1024 })

    const first = await sftpSetup(p.port)
    const id = first.queue.enqueue('upload', join(local, 'up.bin'), join(remote, 'up.bin'), false)
    await until(
      () => (first.queue.list().find((t) => t.id === id)?.transferred ?? 0) > 2 * 1024 * 1024,
      20_000,
      '2 MB'
    )
    p.cutAll()
    expect((await first.wait(id, ['error', 'done'])).state).toBe('error')

    const second = await sftpSetup(s.port)
    const id2 = second.queue.enqueue('upload', join(local, 'up.bin'), join(remote, 'up.bin'), false)
    const done = await second.wait(id2, ['done', 'error'])
    expect(done.state).toBe('done')
    expect(done.resumedFrom).toBeGreaterThan(0)
    expect(sha(readFileSync(join(remote, 'up.bin')))).toBe(sha(data))
  }, 60_000)
})

describe('Mạng xấu: port forwarding', () => {
  it('-L qua đường trễ 100 ms ± 50 ms, 256 KB/s: 1 MB ngẫu nhiên đi qua nguyên vẹn', async () => {
    const echo = createServer((sock) => sock.pipe(sock))
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r))
    cleanups.push(
      () =>
        new Promise<void>((r) =>
          echo.close(() => {
            r()
          })
        )
    )
    const echoPort = (echo.address() as AddressInfo).port

    const s = await server()
    const p = await proxy(s.port, { latencyMs: 100, jitterMs: 50, bytesPerSecond: 512 * 1024 })
    const c = await ssh(p.port)
    const manager = new ForwardManager(c.shell.client, () => undefined)
    cleanups.push(() => {
      manager.dispose()
    })
    await manager.start({
      id: 'l',
      kind: 'L',
      bindAddr: '127.0.0.1',
      bindPort: 0,
      destHost: '127.0.0.1',
      destPort: echoPort
    })
    const port = manager.list()[0]?.actualPort ?? 0

    const payload = randomBytes(1024 * 1024)
    const received = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      const sock = connect(port, '127.0.0.1')
      sock.on('error', reject)
      sock.on('data', (d: Buffer) => {
        chunks.push(d)
        total += d.length
        if (total >= payload.length) {
          sock.end()
          resolve(Buffer.concat(chunks))
        }
      })
      sock.on('connect', () => sock.write(payload))
    })
    expect(sha(received)).toBe(sha(payload))
  }, 60_000)
})
