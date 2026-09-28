import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ForwardSpec, ForwardStatus } from '@shared/forwards'
import { ForwardManager } from '../../src/session-host/forward/manager'
import { openSshShell, type SshShell } from '../../src/session-host/ssh/connect'
import { startTestSshServer } from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** Echo server: trả lại "echo:" + dữ liệu nhận được. */
async function echoServer(): Promise<number> {
  const server: Server = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`))
    socket.on('error', () => undefined)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(
    () =>
      new Promise<void>((r) =>
        server.close(() => {
          r()
        })
      )
  )
  return (server.address() as AddressInfo).port
}

async function sshWithForwards(options: { allowTcpForwarding?: boolean } = {}) {
  const server = await startTestSshServer([{ username: 'u', password: 'p' }], options)
  cleanups.push(() => server.close())
  const shell: SshShell = await openSshShell({
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
  const updates: ForwardStatus[][] = []
  const manager = new ForwardManager(shell.client, (list) => updates.push(list))
  cleanups.push(() => {
    manager.dispose()
  })
  return { server, manager, updates }
}

/** Kết nối TCP, gửi `payload`, đợi nhận đủ `expected`. */
function roundTrip(
  port: number,
  payload: Uint8Array | string,
  expected: string,
  preface?: (s: ReturnType<typeof connect>) => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let text = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Hết giờ, nhận được: ${JSON.stringify(text)}`))
    }, 3_000)
    socket.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    socket.once('connect', () => {
      void (preface ? preface(socket) : Promise.resolve()).then(() => {
        socket.on('data', (c) => {
          text += c.toString()
          if (text.includes(expected)) {
            clearTimeout(timer)
            socket.end()
            resolve(text)
          }
        })
        socket.write(payload)
      })
    })
  })
}

function readExactly(socket: ReturnType<typeof connect>, n: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c])
      if (buf.length >= n) {
        socket.removeListener('data', onData)
        if (buf.length > n) socket.unshift(buf.subarray(n))
        resolve(buf.subarray(0, n))
      }
    }
    socket.on('data', onData)
  })
}

const spec = (s: Partial<ForwardSpec> & Pick<ForwardSpec, 'id' | 'kind'>): ForwardSpec => ({
  bindAddr: '127.0.0.1',
  bindPort: 0,
  destHost: null,
  destPort: null,
  ...s
})

describe('ForwardManager', () => {
  it('-L: cổng cục bộ → qua SSH → đích; đếm byte; dừng thì đóng cổng', async () => {
    const echo = await echoServer()
    const { manager } = await sshWithForwards()
    await manager.start(spec({ id: 'l1', kind: 'L', destHost: '127.0.0.1', destPort: echo }))
    const status = manager.list()[0]
    expect(status).toMatchObject({ state: 'active', error: null })
    const port = status?.actualPort ?? 0
    expect(port).toBeGreaterThan(0)

    expect(await roundTrip(port, 'xin chào', 'echo:xin chào')).toBe('echo:xin chào')
    await new Promise((r) => setTimeout(r, 50))
    expect(manager.list()[0]).toMatchObject({ totalConnections: 1 })
    expect(manager.list()[0]?.bytesOut).toBe(Buffer.byteLength('xin chào'))

    manager.stop('l1')
    expect(manager.list()[0]?.state).toBe('stopped')
    await expect(roundTrip(port, 'x', 'echo:x')).rejects.toThrow(/ECONNREFUSED/)
  })

  it('-L: cổng đã bị chiếm → trạng thái lỗi dễ hiểu', async () => {
    const busy = createServer()
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r))
    cleanups.push(
      () =>
        new Promise<void>((r) =>
          busy.close(() => {
            r()
          })
        )
    )
    const { manager } = await sshWithForwards()
    const port = (busy.address() as AddressInfo).port
    await manager.start(
      spec({ id: 'l2', kind: 'L', bindPort: port, destHost: '127.0.0.1', destPort: 1 })
    )
    expect(manager.list()[0]).toMatchObject({
      state: 'error',
      error: 'The port is already in use by another program'
    })
  })

  it('-D: SOCKS5 CONNECT tới IPv4 và tên miền', async () => {
    const echo = await echoServer()
    const { manager } = await sshWithForwards()
    await manager.start(spec({ id: 'd1', kind: 'D' }))
    const port = manager.list()[0]?.actualPort ?? 0

    const viaSocks = (addr: number[], atyp: number) => async (s: ReturnType<typeof connect>) => {
      s.write(Uint8Array.from([5, 1, 0]))
      expect([...(await readExactly(s, 2))]).toEqual([5, 0])
      s.write(Uint8Array.from([5, 1, 0, atyp, ...addr, echo >> 8, echo & 0xff]))
      const reply = await readExactly(s, 10)
      expect(reply[1]).toBe(0)
    }
    expect(await roundTrip(port, 'ipv4', 'echo:ipv4', viaSocks([127, 0, 0, 1], 1))).toContain(
      'echo:ipv4'
    )
    const name = [...Buffer.from('localhost')]
    expect(
      await roundTrip(port, 'domain', 'echo:domain', viaSocks([name.length, ...name], 3))
    ).toContain('echo:domain')
  })

  it('-D: client không hỗ trợ no-auth → từ chối (0xFF)', async () => {
    const { manager } = await sshWithForwards()
    await manager.start(spec({ id: 'd2', kind: 'D' }))
    const port = manager.list()[0]?.actualPort ?? 0
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const s = connect(port, '127.0.0.1')
      s.on('error', reject)
      s.once('connect', () => {
        s.write(Uint8Array.from([5, 1, 2])) // chỉ username/password
        void readExactly(s, 2).then(resolve)
      })
    })
    expect([...reply]).toEqual([5, 0xff])
  })

  it('-R: server mở cổng, kết nối vào cổng đó đi ngược về đích trên máy này', async () => {
    const echo = await echoServer()
    const { manager, server } = await sshWithForwards()
    await manager.start(spec({ id: 'r1', kind: 'R', destHost: '127.0.0.1', destPort: echo }))
    const status = manager.list()[0]
    expect(status?.state).toBe('active')
    const serverPort = status?.actualPort ?? 0
    expect(server.events.remoteForwards).toEqual([{ bindAddr: '127.0.0.1', port: serverPort }])
    expect(await roundTrip(serverPort, 'nguoc', 'echo:nguoc')).toContain('echo:nguoc')

    manager.stop('r1')
    await new Promise((r) => setTimeout(r, 100))
    await expect(roundTrip(serverPort, 'x', 'echo:x')).rejects.toThrow(/ECONNREFUSED/)
  })

  it('-R: server không cho mở cổng → lỗi', async () => {
    const { manager } = await sshWithForwards({ allowTcpForwarding: false })
    await manager.start(spec({ id: 'r2', kind: 'R', destHost: '127.0.0.1', destPort: 1 }))
    expect(manager.list()[0]).toMatchObject({ state: 'error' })
    expect(manager.list()[0]?.error).toMatch(/refused to open the port/)
  })
})
