import { t } from '@shared/i18n'
import {
  connect as netConnect,
  createServer,
  type AddressInfo,
  type Server,
  type Socket
} from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { ForwardSpec, ForwardStatus } from '@shared/forwards'
import {
  MAX_HANDSHAKE_BYTES,
  METHOD_NO_AUTH,
  METHOD_NONE_ACCEPTABLE,
  parseGreeting,
  parseRequest,
  REPLY,
  replyBytes,
  SOCKS_VERSION
} from './socks5'

const SOCKS_HANDSHAKE_TIMEOUT_MS = 10_000

interface Runtime {
  status: ForwardStatus
  server: Server | null
  sockets: Set<Socket>
  channels: Set<Duplex>
  /** Cổng server đang nghe cho forward R (để huỷ). */
  remote: { addr: string; port: number } | null
  /**
   * stop / remove / dispose trong lúc đang mở (listen chờ tra DNS, forwardIn chờ server): khi mở
   * xong phải đóng ngay, không được ghi đè thành 'active' (cổng rò mãi, kể cả sau dispose).
   */
  cancelled: boolean
}

function errorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'EADDRINUSE') return t('The port is already in use by another program')
  if (code === 'EACCES')
    return t('Not allowed to open this port (ports below 1024 need administrator rights)')
  if (code === 'EADDRNOTAVAIL') return t('The bind address does not exist on this machine')
  return error instanceof Error ? error.message : String(error)
}

/**
 * Quản lý port forwarding trên một kết nối SSH đã xác thực.
 * Mỗi thay đổi trạng thái gọi `onChange` (đã gom tối đa 2 lần/giây cho bộ đếm byte).
 */
export class ForwardManager {
  private readonly forwards = new Map<string, Runtime>()
  private notifyTimer: NodeJS.Timeout | null = null
  private disposed = false
  private readonly onTcpConnection = (
    info: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void
  ): void => {
    this.handleRemoteConnection(info, accept, reject)
  }

  constructor(
    private readonly client: Client,
    private readonly onChange: (list: ForwardStatus[]) => void
  ) {
    client.on('tcp connection', this.onTcpConnection)
  }

  list(): ForwardStatus[] {
    return [...this.forwards.values()].map((r) => ({ ...r.status, spec: { ...r.status.spec } }))
  }

  async start(spec: ForwardSpec): Promise<void> {
    const existing = this.forwards.get(spec.id)
    if (existing && (existing.status.state === 'active' || existing.status.state === 'starting'))
      return
    const runtime: Runtime = {
      status: {
        spec,
        state: 'starting',
        actualPort: null,
        activeConnections: 0,
        totalConnections: 0,
        bytesIn: 0,
        bytesOut: 0,
        error: null
      },
      server: null,
      sockets: new Set(),
      channels: new Set(),
      remote: null,
      cancelled: false
    }
    if (existing) existing.cancelled = true
    this.forwards.set(spec.id, runtime)
    this.notify(true)
    try {
      if (spec.kind === 'R') await this.startRemote(runtime)
      else await this.startLocal(runtime)
      if (runtime.cancelled || this.disposed) {
        this.teardown(runtime)
        return
      }
      runtime.status.state = 'active'
    } catch (error) {
      if (runtime.cancelled || this.disposed) {
        this.teardown(runtime)
        return
      }
      runtime.status.state = 'error'
      runtime.status.error = errorText(error)
      this.teardown(runtime)
    }
    this.notify(true)
  }

  stop(id: string): void {
    const runtime = this.forwards.get(id)
    if (!runtime) return
    runtime.cancelled = true
    this.teardown(runtime)
    runtime.status.state = 'stopped'
    runtime.status.activeConnections = 0
    this.notify(true)
  }

  /** Bỏ hẳn khỏi danh sách. */
  remove(id: string): void {
    this.stop(id)
    this.forwards.delete(id)
    this.notify(true)
  }

  dispose(): void {
    this.disposed = true
    this.client.removeListener('tcp connection', this.onTcpConnection)
    for (const runtime of this.forwards.values()) {
      runtime.cancelled = true
      this.teardown(runtime)
    }
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
  }

  // ---------- L và D: nghe trên máy này ----------

  private startLocal(runtime: Runtime): Promise<void> {
    const { spec } = runtime.status
    const server = createServer((socket) => {
      this.track(runtime, socket)
      if (spec.kind === 'D') this.handleSocks(runtime, socket)
      else this.openChannel(runtime, socket, spec.destHost ?? '', spec.destPort ?? 0, null)
    })
    runtime.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      // close() lúc đang tra DNS: Node bỏ luôn lượt listen (callback không bao giờ đến) → không
      // để start() treo mãi.
      server.once('close', () => {
        if (runtime.cancelled) resolve()
      })
      server.listen(spec.bindPort, spec.bindAddr, () => {
        server.removeListener('error', reject)
        server.on('error', () => undefined)
        if (runtime.cancelled) {
          // Đã dừng trong lúc listen (server.close() lúc đó chưa có tác dụng) → đóng ngay.
          server.close()
          resolve()
          return
        }
        runtime.status.actualPort = (server.address() as AddressInfo).port
        resolve()
      })
    })
  }

  /** Mở kênh direct-tcpip tới đích và nối với socket cục bộ. `onReady` cho SOCKS trả lời trước. */
  private openChannel(
    runtime: Runtime,
    socket: Socket,
    host: string,
    port: number,
    onReady: ((ok: boolean, code: number) => void) | null
  ): void {
    socket.pause()
    this.client.forwardOut(
      socket.remoteAddress ?? '127.0.0.1',
      socket.remotePort ?? 0,
      host,
      port,
      (error, channel) => {
        if (error) {
          // SOCKS: onReady gửi mã lỗi rồi end() — destroy() ngay sẽ có thể bỏ mất câu trả lời.
          if (onReady)
            onReady(
              false,
              /refused/i.test(error.message) ? REPLY.connectionRefused : REPLY.hostUnreachable
            )
          else socket.destroy()
          return
        }
        if (socket.destroyed) {
          channel.close()
          return
        }
        onReady?.(true, REPLY.succeeded)
        this.pipe(runtime, socket, channel)
        socket.resume()
      }
    )
  }

  private handleSocks(runtime: Runtime, socket: Socket): void {
    let buffer = Buffer.alloc(0)
    let stage: 'greeting' | 'request' = 'greeting'
    const timer = setTimeout(() => socket.destroy(), SOCKS_HANDSHAKE_TIMEOUT_MS)
    socket.on('close', () => {
      clearTimeout(timer)
    })

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_HANDSHAKE_BYTES) {
        socket.destroy()
        return
      }
      if (stage === 'greeting') {
        const greeting = parseGreeting(buffer)
        if (greeting.status === 'more') return
        if (greeting.status === 'error' || !greeting.noAuthOffered) {
          socket.end(Uint8Array.from([SOCKS_VERSION, METHOD_NONE_ACCEPTABLE]))
          return
        }
        socket.write(Uint8Array.from([SOCKS_VERSION, METHOD_NO_AUTH]))
        buffer = buffer.subarray(greeting.consumed)
        stage = 'request'
      }
      const request = parseRequest(buffer)
      if (request.status === 'more') return
      socket.removeListener('data', onData)
      clearTimeout(timer)
      if (request.status === 'error') {
        socket.end(replyBytes(request.reply))
        return
      }
      const extra = buffer.subarray(request.consumed)
      this.openChannel(runtime, socket, request.host, request.port, (ok, code) => {
        if (!ok) {
          socket.end(replyBytes(code))
          // Client không đóng phía nó → không giữ socket mãi.
          setTimeout(() => socket.destroy(), SOCKS_HANDSHAKE_TIMEOUT_MS).unref()
          return
        }
        socket.write(replyBytes(code))
        if (extra.length > 0) socket.unshift(extra)
      })
    }
    socket.on('data', onData)
  }

  // ---------- R: server nghe, đẩy ngược về máy này ----------

  private startRemote(runtime: Runtime): Promise<void> {
    const { spec } = runtime.status
    return new Promise((resolve, reject) => {
      this.client.forwardIn(spec.bindAddr, spec.bindPort, (error, port) => {
        if (error) {
          reject(
            new Error(t('The server refused to open the port: {error}', { error: error.message }))
          )
          return
        }
        const actual = port || spec.bindPort
        if (runtime.cancelled) {
          // Đã dừng trong lúc chờ server → huỷ cổng vừa mở, không gắn vào runtime đã gỡ.
          try {
            this.client.unforwardIn(spec.bindAddr, actual)
          } catch {
            // Kết nối đã đóng.
          }
          resolve()
          return
        }
        runtime.remote = { addr: spec.bindAddr, port: actual }
        runtime.status.actualPort = actual
        resolve()
      })
    })
  }

  private handleRemoteConnection(
    info: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void
  ): void {
    const runtime = [...this.forwards.values()].find(
      (r) =>
        r.status.state === 'active' &&
        r.remote &&
        r.remote.port === info.destPort &&
        (r.remote.addr === info.destIP ||
          ['', '0.0.0.0', '::', 'localhost'].includes(r.remote.addr))
    )
    const { destHost, destPort } = runtime?.status.spec ?? {}
    if (!runtime || !destHost || !destPort) {
      reject()
      return
    }
    const socket = netConnect(destPort, destHost)
    this.track(runtime, socket)
    socket.once('connect', () => {
      this.pipe(runtime, socket, accept())
    })
    socket.once('error', () => {
      reject()
    })
  }

  // ---------- Dùng chung ----------

  private track(runtime: Runtime, socket: Socket): void {
    runtime.sockets.add(socket)
    runtime.status.activeConnections++
    runtime.status.totalConnections++
    socket.on('error', () => undefined)
    socket.on('close', () => {
      runtime.sockets.delete(socket)
      runtime.status.activeConnections = Math.max(0, runtime.status.activeConnections - 1)
      this.notify()
    })
    this.notify()
  }

  private pipe(runtime: Runtime, socket: Socket, channel: Duplex): void {
    runtime.channels.add(channel)
    socket.on('data', (chunk: Buffer) => {
      runtime.status.bytesOut += chunk.length
      this.notify()
    })
    channel.on('data', (chunk: Buffer) => {
      runtime.status.bytesIn += chunk.length
      this.notify()
    })
    socket.pipe(channel).pipe(socket)
    const close = (): void => {
      runtime.channels.delete(channel)
      socket.destroy()
      channel.destroy()
    }
    socket.on('close', close)
    channel.on('close', close)
    channel.on('error', close)
  }

  private teardown(runtime: Runtime): void {
    runtime.server?.close()
    runtime.server = null
    for (const s of runtime.sockets) s.destroy()
    for (const c of runtime.channels) c.destroy()
    runtime.sockets.clear()
    runtime.channels.clear()
    if (runtime.remote) {
      const { addr, port } = runtime.remote
      runtime.remote = null
      try {
        this.client.unforwardIn(addr, port)
      } catch {
        // Kết nối đã đóng.
      }
    }
  }

  private notify(immediate = false): void {
    if (this.disposed) return
    if (immediate) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer)
      this.notifyTimer = null
      this.onChange(this.list())
      return
    }
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = null
      this.onChange(this.list())
    }, 500)
  }
}
