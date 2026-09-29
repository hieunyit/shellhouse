import { getCiphers } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { Client, type ClientChannel } from 'ssh2'
import type { Transport, TransportCallbacks, TransportContext } from '../transport/types'
import { createAuthHandler, defaultAgent, defaultKeyFiles, type StoredCredentials } from './auth'

/** Thứ tự host key mặc định; không có `ssh-rsa` (SHA-1) — chỉ bật theo từng host (legacy). */
const DEFAULT_HOST_KEY_ALGOS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256'
] as const

/** Loại key trong known_hosts → thuật toán chữ ký tương ứng. */
function algosForKeyType(keyType: string): string[] {
  return keyType === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256'] : [keyType]
}

/** Như OpenSSH: ưu tiên loại key đã biết để tránh báo "key đổi" giả khi server có nhiều key. */
export function hostKeyAlgorithms(knownKeyTypes: readonly string[]): string[] {
  const preferred = knownKeyTypes.flatMap(algosForKeyType)
  return [...new Set([...preferred, ...DEFAULT_HOST_KEY_ALGOS])]
}

/**
 * Thuật toán cũ cho thiết bị đời cũ (switch, router, server trước 2015) — CHỈ bật theo từng host.
 * Được nối vào SAU danh sách hiện đại: server mới vẫn thương lượng thuật toán mạnh.
 * Chỉ giữ những cipher mà bản OpenSSL/BoringSSL đang chạy thực sự có.
 */
const LEGACY_CIPHERS = (
  [
    ['aes128-cbc', 'aes-128-cbc'],
    ['aes192-cbc', 'aes-192-cbc'],
    ['aes256-cbc', 'aes-256-cbc'],
    ['3des-cbc', 'des-ede3-cbc']
  ] as const
)
  .filter(([, openssl]) => getCiphers().includes(openssl))
  .map(([name]) => name)

export function algorithmsFor(hop: Pick<HopConfig, 'knownKeyTypes' | 'legacyAlgorithms'>): object {
  const hostKeys = hostKeyAlgorithms(hop.knownKeyTypes)
  if (!hop.legacyAlgorithms) return { serverHostKey: hostKeys }
  return {
    serverHostKey: [...hostKeys, 'ssh-rsa', 'ssh-dss'],
    kex: {
      append: [
        'diffie-hellman-group14-sha1',
        'diffie-hellman-group-exchange-sha1',
        'diffie-hellman-group1-sha1'
      ]
    },
    cipher: { append: LEGACY_CIPHERS },
    hmac: { append: ['hmac-md5'] }
  }
}

export const TIMEOUTS = {
  /** Mở TCP (hoặc kênh qua jump host). */
  tcpMs: 15_000,
  /** Từ lúc có kết nối tới lúc server gửi host key (KEX). Không tính thời gian người dùng trả lời. */
  handshakeMs: 20_000,
  keepaliveIntervalMs: 15_000,
  keepaliveCountMax: 3
}

export interface SshTarget {
  host: string
  port: number
  username: string
}

/** Một chặng SSH: jump host hoặc đích cuối. */
export interface HopConfig {
  target: SshTarget
  knownKeyTypes: readonly string[]
  credentials?: StoredCredentials
  /** Thay cho key mặc định (~/.ssh/id_*), ví dụ IdentityFile từ ~/.ssh/config. */
  keyFiles?: readonly string[]
  /** Cho phép thuật toán cũ (ssh-rsa/SHA-1, DH group1/14-sha1, CBC) — thiết bị đời cũ. */
  legacyAlgorithms?: boolean
  /**
   * Chỉ dùng `credentials` / `keyFiles` của chặng này — không thử agent và key mặc định
   * (~/.ssh/id_*). Host đặt rõ Password / SSH key: tránh lỗi agent và "Too many authentication
   * failures" khi máy có nhiều key.
   */
  storedOnly?: boolean
}

export interface SshOpenOptions {
  /** Đích cuối. */
  destination: HopConfig
  /** Các jump host theo thứ tự (ProxyJump). */
  jumps?: readonly HopConfig[]
  cols: number
  rows: number
  callbacks: TransportCallbacks
  ctx: TransportContext
  /** Cho test: bỏ agent / key mặc định của máy đang chạy. */
  agent?: string | null
  keyFiles?: readonly string[]
  timeouts?: Partial<typeof TIMEOUTS>
}

function openTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // TCP_NODELAY như OpenSSH cho phiên tương tác: gói nhỏ (phím gõ, yêu cầu SFTP) đi ngay, không
    // chờ ACK trễ của gói trước (Nagle + delayed ACK = ~40–90 ms mỗi lượt hỏi-đáp).
    const socket = netConnect({ host, port, noDelay: true })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timed out connecting to ${host}:${port}`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Mở kênh direct-tcpip qua một client đã xác thực (dùng làm "socket" cho chặng sau). */
function forwardThrough(
  client: Client,
  target: SshTarget,
  timeoutMs: number
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out opening a channel to ${target.host}:${target.port}`))
    }, timeoutMs)
    client.forwardOut('127.0.0.1', 0, target.host, target.port, (error, stream) => {
      clearTimeout(timer)
      if (error)
        reject(
          new Error(
            `The jump host could not open a channel to ${target.host}:${target.port}: ${error.message}`
          )
        )
      else resolve(stream)
    })
  })
}

interface HopOptions {
  hop: HopConfig
  sock: Duplex
  ctx: TransportContext
  agent: string | null
  defaultKeys: readonly string[]
  timeouts: typeof TIMEOUTS
}

/** Bắt tay + kiểm tra host key + xác thực một chặng. Resolve khi 'ready'. */
function connectHop(options: HopOptions): Promise<Client> {
  const { hop, ctx, timeouts } = options
  const { host, port, username } = hop.target
  const client = new Client()
  return new Promise<Client>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(handshakeTimer)
      client.end()
      options.sock.destroy()
      reject(error)
    }
    const handshakeTimer = setTimeout(() => {
      fail(new Error(`Server ${host} did not respond to the SSH handshake`))
    }, timeouts.handshakeMs)

    // ssh2 báo lỗi agent (không có agent chạy, Pageant đóng…) qua 'error' nhưng VẪN tự thử cách
    // xác thực tiếp theo — không được coi là lỗi kết nối (như OpenSSH: agent hỏng thì bỏ qua).
    const onError = (error: Error & { level?: string }): void => {
      if (error.level === 'agent') {
        ctx.log('info', `SSH agent unavailable, trying other methods: ${error.message}`)
        return
      }
      fail(error)
    }
    client.on('error', onError)
    client.once('close', () => {
      fail(new Error(`Server ${host} closed the connection`))
    })
    client.once('ready', () => {
      if (settled) return
      settled = true
      clearTimeout(handshakeTimer)
      client.removeListener('error', onError)
      resolve(client)
    })

    client.connect({
      sock: options.sock,
      username,
      // Thời gian người dùng trả lời prompt không được tính; bắt tay đã có handshakeTimer.
      readyTimeout: 30 * 60 * 1000,
      keepaliveInterval: timeouts.keepaliveIntervalMs,
      keepaliveCountMax: timeouts.keepaliveCountMax,
      algorithms: algorithmsFor(hop),
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        clearTimeout(handshakeTimer)
        ctx
          .verifyHostKey(host, port, key)
          .then((ok) => {
            if (ok) ctx.status('authenticating', `Authenticating ${username}@${host}…`)
            verify(ok)
          })
          .catch(() => {
            verify(false)
          })
      },
      authHandler: createAuthHandler({
        username,
        host,
        agent: hop.storedOnly ? null : options.agent,
        keyFiles: hop.keyFiles ?? (hop.storedOnly ? [] : options.defaultKeys),
        ...(hop.credentials ? { credentials: hop.credentials } : {}),
        ctx
      })
    })
  })
}

/** Shell trên kết nối cuối; giữ mọi client của chuỗi jump để đóng cùng lúc. */
export class SshShell implements Transport {
  private exited = false

  constructor(
    /** Client của đích cuối — dùng cho SFTP và port forwarding. */
    readonly client: Client,
    private readonly chain: readonly Client[],
    private readonly stream: ClientChannel,
    callbacks: TransportCallbacks
  ) {
    let exitCode: number | null = null
    let exitSignal: number | null = null
    const onData = (chunk: Buffer): void => {
      callbacks.onData(chunk)
    }
    stream.on('data', onData)
    stream.stderr.on('data', onData)
    stream.on('exit', (code: number | null, signal?: string) => {
      exitCode = typeof code === 'number' ? code : null
      exitSignal = signal ? 1 : null
    })
    const finish = (error?: string): void => {
      if (this.exited) return
      this.exited = true
      callbacks.onExit({ code: exitCode, signal: exitSignal, ...(error ? { error } : {}) })
      this.endAll()
    }
    stream.on('close', () => {
      finish()
    })
    // Bất kỳ chặng nào rớt (kể cả jump host) đều làm mất shell.
    for (const c of chain) {
      c.on('error', (error: Error) => {
        finish(error.message)
      })
      c.on('close', () => {
        finish(exitCode === null ? 'Connection lost' : undefined)
      })
    }
  }

  write(data: string): void {
    if (!this.exited) this.stream.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.stream.setWindow(rows, cols, 0, 0)
  }

  pause(): void {
    this.stream.pause()
  }

  resume(): void {
    this.stream.resume()
  }

  close(): void {
    if (this.exited) return
    this.stream.close()
    this.endAll()
  }

  private endAll(): void {
    // Đóng từ trong ra ngoài: đích cuối trước, jump host sau.
    for (const c of [...this.chain].reverse()) c.end()
  }
}

/** Kết nối (qua các jump host nếu có), xác thực từng chặng, mở shell có PTY. */
export async function openSshShell(options: SshOpenOptions): Promise<SshShell> {
  const { ctx } = options
  const timeouts = { ...TIMEOUTS, ...options.timeouts }
  const hops = [...(options.jumps ?? []), options.destination]
  const agent = options.agent === undefined ? defaultAgent() : options.agent
  const defaultKeys = options.keyFiles ?? defaultKeyFiles()
  const clients: Client[] = []

  try {
    const first = hops[0] ?? options.destination
    ctx.status('connecting', `Connecting to ${first.target.host}:${first.target.port}…`)
    let sock: Duplex = await openTcp(first.target.host, first.target.port, timeouts.tcpMs)

    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i] as HopConfig
      const client = await connectHop({ hop, sock, ctx, agent, defaultKeys, timeouts })
      clients.push(client)
      const next = hops[i + 1]
      if (next) {
        ctx.status(
          'connecting',
          `Via ${hop.target.host} → ${next.target.host}:${next.target.port}…`
        )
        sock = await forwardThrough(client, next.target, timeouts.tcpMs)
      }
    }

    const last = clients.at(-1) as Client
    ctx.status('connected', 'Authenticated, opening shell…')
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      last.shell({ term: 'xterm-256color', cols: options.cols, rows: options.rows }, (error, s) => {
        if (error) reject(error)
        else resolve(s)
      })
    })
    return new SshShell(last, clients, stream, options.callbacks)
  } catch (error) {
    for (const c of clients.reverse()) c.end()
    throw error
  }
}
