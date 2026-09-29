import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createServer,
  connect,
  type AddressInfo,
  type Server as NetServer,
  type Socket
} from 'node:net'
import {
  Server,
  utils,
  type AuthContext,
  type Connection,
  type ParsedKey,
  type ServerChannel
} from 'ssh2'

export interface TestUser {
  username: string
  password?: string
  /** Public key (định dạng OpenSSH) được phép đăng nhập. */
  publicKey?: string
  /** Sau khi qua publickey, bắt nhập OTP bằng keyboard-interactive (2FA). */
  otp?: string
}

/** sftp-server của OpenSSH trên máy chạy test (CI Ubuntu có sẵn ở /usr/lib/openssh). */
export function findSftpServer(): string | null {
  const candidates = [
    process.env['SHELLHOUSE_SFTP_SERVER'],
    '/usr/lib/openssh/sftp-server',
    '/usr/libexec/sftp-server',
    '/usr/libexec/openssh/sftp-server',
    join(homedir(), '.local/opt/openssh-sftp/usr/lib/openssh/sftp-server'),
    // OpenSSH có sẵn trong Windows 10/11.
    'C:\\Windows\\System32\\OpenSSH\\sftp-server.exe'
  ]
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null
}

export interface TestServerEvents {
  /** Cổng server mở cho -R. */
  remoteForwards: { bindAddr: string; port: number }[]
  /** Kênh direct-tcpip (client dùng server này làm jump host / -L). */
  directTcpip: { destIP: string; destPort: number }[]
  ptyRequests: { cols: number; rows: number; term: string }[]
  windowChanges: { cols: number; rows: number }[]
  authAttempts: { method: string; username: string }[]
}

export interface TestSshServer {
  port: number
  hostKeyBlob: Buffer
  /** Để khởi động lại "cùng một server" (cùng host key) trong test. */
  hostKey: { private: string; public: string }
  events: TestServerEvents
  close(): Promise<void>
}

function parsePublic(key: string): ParsedKey {
  const parsed: ParsedKey | Error = utils.parseKey(key)
  if (parsed instanceof Error) throw parsed
  return parsed
}

/**
 * Tạo key ed25519 bằng ssh2 rồi KIỂM CHỨNG (đọc lại + ký/xác minh). `utils.generateKeyPairSync`
 * của ssh2 sinh ~0,4% file hỏng mà cả ssh2 lẫn ssh-keygen đều không đọc được (đã kiểm chứng
 * 11/3000 key, 2026-09-28) — không được dùng trực tiếp, kể cả trong test.
 */
export function generateTestKey(passphrase?: string): { private: string; public: string } {
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = passphrase
      ? utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 16 })
      : utils.generateKeyPairSync('ed25519')
    const priv: ParsedKey | Error = utils.parseKey(key.private, passphrase)
    const pub: ParsedKey | Error = utils.parseKey(key.public)
    if (priv instanceof Error || pub instanceof Error) continue
    const probe = Buffer.from('probe')
    if (pub.verify(probe, priv.sign(probe))) return key
  }
  throw new Error('Không tạo được key hợp lệ')
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Shell giả: echo từng ký tự, hiểu các lệnh
 * `echo <x>`, `size`, `exit <n>`, `flood <bytes>`.
 */
function fakeShell(stream: ServerChannel, size: { cols: number; rows: number }): void {
  let line = ''
  stream.write('welcome to test server\r\n$ ')
  stream.on('data', (chunk: Buffer) => {
    for (const ch of chunk.toString('utf8')) {
      if (ch === '\r') {
        stream.write('\r\n')
        const [cmd, ...rest] = line.trim().split(' ')
        const arg = rest.join(' ')
        line = ''
        if (cmd === 'exit') {
          stream.exit(Number(arg || 0))
          stream.end()
          return
        }
        if (cmd === 'echo') stream.write(`${arg}\r\n`)
        if (cmd === 'size') stream.write(`SIZE=${size.cols}x${size.rows}\r\n`)
        if (cmd === 'flood') stream.write(Buffer.alloc(Number(arg), 'x'))
        stream.write('$ ')
      } else if (ch === '\x7f') {
        line = line.slice(0, -1)
        stream.write('\b \b')
      } else {
        line += ch
        stream.write(ch)
      }
    }
  })
}

export async function startTestSshServer(
  users: TestUser[],
  options: {
    port?: number
    hostKey?: { private: string; public: string }
    /** false = từ chối direct-tcpip (không làm jump host được). */
    allowTcpForwarding?: boolean
    /** Thư mục bắt đầu của SFTP. */
    sftpRoot?: string
    /** Bật exec: lệnh chạy bằng /bin/sh với HOME này. */
    execHome?: string
  } = {}
): Promise<TestSshServer> {
  const hostKey = options.hostKey ?? generateTestKey()
  const hostKeyBlob = parsePublic(hostKey.public).getPublicSSH()
  const events: TestServerEvents = {
    remoteForwards: [],
    directTcpip: [],
    ptyRequests: [],
    windowChanges: [],
    authAttempts: []
  }

  const clients = new Set<Connection>()
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    let keyPassed = false
    client.on('authentication', (ctx: AuthContext) => {
      events.authAttempts.push({ method: ctx.method, username: ctx.username })
      const user = users.find((u) => u.username === ctx.username)
      const allowed: ('password' | 'publickey' | 'keyboard-interactive')[] = []
      if (user?.password) allowed.push('password')
      if (user?.publicKey || options.execHome) allowed.push('publickey')
      if (!user) {
        ctx.reject(['password', 'publickey'])
        return
      }

      if (ctx.method === 'password' && user.password) {
        if (sameBytes(Buffer.from(ctx.password), Buffer.from(user.password))) {
          ctx.accept()
          return
        }
      }

      // Như sshd: chấp nhận key có trong $HOME/.ssh/authorized_keys (HOME = execHome).
      if (ctx.method === 'publickey' && options.execHome && !user.publicKey) {
        const lines = ((): string[] => {
          try {
            return readFileSync(join(options.execHome, '.ssh', 'authorized_keys'), 'utf8').split(
              '\n'
            )
          } catch {
            return []
          }
        })()
        const match = lines
          .filter((l) => l.trim())
          .map((l) => {
            try {
              return parsePublic(l.trim())
            } catch {
              return null
            }
          })
          .find((k) => k && sameBytes(ctx.key.data, k.getPublicSSH()))
        if (match) {
          if (!ctx.signature) {
            ctx.accept()
            return
          }
          if (ctx.blob && match.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
            ctx.accept()
            return
          }
        }
      }

      if (ctx.method === 'publickey' && user.publicKey) {
        const allowedKey = parsePublic(user.publicKey)
        if (sameBytes(ctx.key.data, allowedKey.getPublicSSH())) {
          if (!ctx.signature) {
            ctx.accept() // chỉ hỏi "key này có được không"
            return
          }
          if (ctx.blob && allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
            if (user.otp) {
              keyPassed = true
              ctx.reject(['keyboard-interactive'], true) // partial success
              return
            }
            ctx.accept()
            return
          }
        }
      }

      if (ctx.method === 'keyboard-interactive' && user.otp && keyPassed) {
        ctx.prompt([{ prompt: 'Mã OTP: ', echo: false }], 'Xác thực 2 bước', '', (answers) => {
          if (answers[0] === user.otp) ctx.accept()
          else ctx.reject(['keyboard-interactive'], true)
        })
        return
      }

      ctx.reject(keyPassed ? ['keyboard-interactive'] : allowed)
    })

    client.on('ready', () => {
      // -R: server mở cổng, mỗi kết nối vào cổng đó được đẩy ngược về client (forwarded-tcpip).
      const remoteListeners = new Map<string, NetServer>()
      client.on('close', () => {
        for (const s of remoteListeners.values()) s.close()
      })
      client.on('request', (accept, reject, name, info) => {
        const bind = info
        if (name === 'tcpip-forward') {
          if (options.allowTcpForwarding === false) {
            reject?.()
            return
          }
          const listener = createServer((incoming) => {
            const address = listener.address() as AddressInfo
            client.forwardOut(
              bind.bindAddr,
              address.port,
              incoming.remoteAddress ?? '127.0.0.1',
              incoming.remotePort ?? 0,
              (error, channel) => {
                if (error) {
                  incoming.destroy()
                  return
                }
                incoming.pipe(channel).pipe(incoming)
                incoming.on('close', () => {
                  channel.close()
                })
                channel.on('close', () => incoming.destroy())
              }
            )
          })
          listener.on('error', () => reject?.())
          listener.listen(bind.bindPort, '127.0.0.1', () => {
            const port = (listener.address() as AddressInfo).port
            remoteListeners.set(`${bind.bindAddr}:${port}`, listener)
            events.remoteForwards.push({ bindAddr: bind.bindAddr, port })
            accept?.(port)
          })
        } else {
          // cancel-tcpip-forward
          const key = `${bind.bindAddr}:${bind.bindPort}`
          remoteListeners.get(key)?.close()
          remoteListeners.delete(key)
          accept?.()
        }
      })
      client.on('tcpip', (accept, reject, info) => {
        events.directTcpip.push({ destIP: info.destIP, destPort: info.destPort })
        if (options.allowTcpForwarding === false) {
          reject()
          return
        }
        const upstream = connect(info.destPort, info.destIP)
        upstream.once('connect', () => {
          const channel = accept()
          channel.pipe(upstream).pipe(channel)
          channel.on('close', () => upstream.destroy())
          upstream.on('close', () => {
            channel.close()
          })
        })
        upstream.once('error', () => {
          reject()
        })
      })
      client.on('session', (accept) => {
        const session = accept()
        const size = { cols: 80, rows: 24 }
        session.on('pty', (acceptPty, _reject, info) => {
          size.cols = info.cols
          size.rows = info.rows
          events.ptyRequests.push({ cols: info.cols, rows: info.rows, term: info.term })
          acceptPty()
        })
        session.on('window-change', (acceptChange, _reject, info) => {
          size.cols = info.cols
          size.rows = info.rows
          events.windowChanges.push({ cols: info.cols, rows: info.rows })
          // @types/ssh2 khai báo luôn có, nhưng ssh2 chỉ truyền `accept` khi client cần phản hồi.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          acceptChange?.()
        })
        session.on('shell', (acceptShell) => {
          fakeShell(acceptShell(), size)
        })
        // exec: chạy lệnh thật bằng /bin/sh với HOME là thư mục tạm (để test triển khai key).
        session.on('exec', (acceptExec, rejectExec, info) => {
          if (!options.execHome) {
            rejectExec()
            return
          }
          const channel = acceptExec()
          const child = spawn('/bin/sh', ['-c', info.command], {
            env: { HOME: options.execHome, PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
          })
          channel.pipe(child.stdin)
          child.stdout.pipe(channel)
          child.stderr.pipe(channel.stderr)
          child.on('exit', (code) => {
            channel.exit(code ?? 1)
            channel.end()
          })
        })
        // SFTP: nối kênh thô vào sftp-server THẬT của OpenSSH (không tự viết server SFTP giả).
        session.on('subsystem', (acceptSub, rejectSub, info) => {
          const binary = findSftpServer()
          if (info.name !== 'sftp' || !binary) {
            rejectSub()
            return
          }
          const channel = acceptSub()
          const child = spawn(
            binary,
            ['-e', ...(options.sftpRoot ? ['-d', options.sftpRoot] : [])],
            {
              stdio: ['pipe', 'pipe', 'ignore']
            }
          )
          channel.pipe(child.stdin)
          child.stdout.pipe(channel)
          child.on('exit', (code) => {
            channel.exit(code ?? 0)
            channel.end()
          })
          channel.on('close', () => child.kill())
        })
      })
    })
    client.on('error', () => {
      // Client ngắt đột ngột trong test — bỏ qua.
    })
  })

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    hostKeyBlob,
    hostKey,
    events,
    // Ngắt mọi client đang nối (server.close() chỉ ngừng nhận kết nối mới và chờ client cũ).
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        for (const client of clients) client.end()
      })
  }
}

/** TCP proxy có thể "đóng băng" (ngừng chuyển dữ liệu, không đóng socket) — giả lập mất mạng. */
export interface FreezableProxy {
  port: number
  freeze(): void
  close(): Promise<void>
}

export async function startProxy(targetPort: number): Promise<FreezableProxy> {
  const sockets: Socket[] = []
  let frozen = false
  const server: NetServer = createServer((downstream) => {
    const upstream = connect(targetPort, '127.0.0.1')
    sockets.push(downstream, upstream)
    const forward = (from: Socket, to: Socket): void => {
      from.on('data', (chunk) => {
        if (!frozen) to.write(chunk)
      })
    }
    forward(downstream, upstream)
    forward(upstream, downstream)
    const closeBoth = (): void => {
      downstream.destroy()
      upstream.destroy()
    }
    downstream.on('error', closeBoth)
    upstream.on('error', closeBoth)
    downstream.on('close', closeBoth)
    upstream.on('close', closeBoth)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    freeze: () => {
      frozen = true
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => {
          resolve()
        })
      })
  }
}
