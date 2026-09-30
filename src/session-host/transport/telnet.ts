import { connect as netConnect, type Socket } from 'node:net'
import type { Transport, TransportCallbacks } from './types'

// Mã lệnh Telnet (RFC 854) và các tuỳ chọn cần dùng.
const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240
const OPT_ECHO = 1
const OPT_SGA = 3 // Suppress Go Ahead
const OPT_TTYPE = 24 // Terminal type (RFC 1091)
const OPT_NAWS = 31 // Window size (RFC 1073)
const TTYPE_SEND = 1
const TTYPE_IS = 0

/** Server làm (WILL) — chấp nhận: server tự echo và không dùng Go Ahead (chế độ ký tự). */
const ACCEPT_REMOTE = new Set([OPT_ECHO, OPT_SGA])
/** Client làm (DO) — chấp nhận: báo loại terminal và kích thước cửa sổ; SGA. */
const ACCEPT_LOCAL = new Set([OPT_SGA, OPT_TTYPE, OPT_NAWS])

/**
 * Bộ phân tích luồng Telnet: tách dữ liệu hiển thị khỏi lệnh IAC (có trạng thái — một lệnh có thể
 * bị cắt giữa hai lần nhận), trả lời thương lượng tuỳ chọn.
 */
export class TelnetParser {
  private state: 'data' | 'iac' | 'cmd' | 'sb' | 'sb-iac' = 'data'
  private cmd = 0
  private sb: number[] = []
  /** Tuỳ chọn phía client đang bật (để không trả lời lặp — tránh vòng WILL/DO vô hạn). */
  private readonly localOn = new Set<number>()
  private readonly remoteOn = new Set<number>()

  constructor(
    private readonly send: (bytes: Uint8Array) => void,
    private readonly terminalType: string,
    private readonly size: () => { cols: number; rows: number }
  ) {}

  /** Nhận byte từ mạng → trả về phần dữ liệu cho terminal. */
  push(chunk: Uint8Array): Uint8Array {
    const out: number[] = []
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac'
          else out.push(b)
          break
        case 'iac':
          if (b === IAC) {
            out.push(IAC) // IAC IAC = byte 255 thật
            this.state = 'data'
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.cmd = b
            this.state = 'cmd'
          } else if (b === SB) {
            this.sb = []
            this.state = 'sb'
          } else this.state = 'data' // NOP, GA, AYT… — bỏ qua
          break
        case 'cmd':
          this.negotiate(this.cmd, b)
          this.state = 'data'
          break
        case 'sb':
          if (b === IAC) this.state = 'sb-iac'
          else if (this.sb.length < 1024) this.sb.push(b)
          break
        case 'sb-iac':
          if (b === SE) {
            this.subnegotiation(this.sb)
            this.state = 'data'
          } else {
            if (b === IAC && this.sb.length < 1024) this.sb.push(IAC)
            this.state = 'sb'
          }
          break
      }
    }
    return Uint8Array.from(out)
  }

  /** Byte gõ từ bàn phím → luồng Telnet: nhân đôi IAC; Enter ("\r") thành CR NUL (NVT). */
  encode(text: string): Uint8Array {
    const bytes = Buffer.from(text, 'utf8')
    const out: number[] = []
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] ?? 0
      out.push(b)
      if (b === IAC) out.push(IAC)
      else if (b === 13 && bytes[i + 1] !== 10) out.push(0)
    }
    return Uint8Array.from(out)
  }

  /** Cửa sổ đổi kích thước → báo server (nếu đã thoả thuận NAWS). */
  resized(): void {
    if (this.localOn.has(OPT_NAWS)) this.sendSize()
  }

  private negotiate(cmd: number, opt: number): void {
    if (cmd === DO) {
      if (ACCEPT_LOCAL.has(opt)) {
        if (!this.localOn.has(opt)) {
          this.localOn.add(opt)
          this.send(Uint8Array.from([IAC, WILL, opt]))
        }
        if (opt === OPT_NAWS) this.sendSize()
      } else this.send(Uint8Array.from([IAC, WONT, opt]))
    } else if (cmd === DONT) {
      if (this.localOn.delete(opt)) this.send(Uint8Array.from([IAC, WONT, opt]))
    } else if (cmd === WILL) {
      if (ACCEPT_REMOTE.has(opt)) {
        if (!this.remoteOn.has(opt)) {
          this.remoteOn.add(opt)
          this.send(Uint8Array.from([IAC, DO, opt]))
        }
      } else this.send(Uint8Array.from([IAC, DONT, opt]))
    } else if (cmd === WONT) {
      if (this.remoteOn.delete(opt)) this.send(Uint8Array.from([IAC, DONT, opt]))
    }
  }

  private subnegotiation(data: number[]): void {
    if (data[0] === OPT_TTYPE && data[1] === TTYPE_SEND) {
      const name = [...Buffer.from(this.terminalType, 'ascii')]
      this.send(Uint8Array.from([IAC, SB, OPT_TTYPE, TTYPE_IS, ...name, IAC, SE]))
    }
  }

  private sendSize(): void {
    const { cols, rows } = this.size()
    const bytes = [cols >> 8, cols & 0xff, rows >> 8, rows & 0xff].flatMap((b) =>
      b === IAC ? [IAC, IAC] : [b]
    )
    this.send(Uint8Array.from([IAC, SB, OPT_NAWS, ...bytes, IAC, SE]))
  }
}

export interface TelnetOptions {
  host: string
  port: number
  cols: number
  rows: number
  timeoutMs?: number
}

/** Kết nối Telnet (thiết bị mạng: switch, router, console server). Không mã hoá. */
export class TelnetTransport implements Transport {
  private cols: number
  private rows: number
  private closed = false
  private readonly parser: TelnetParser

  private constructor(
    private readonly socket: Socket,
    options: TelnetOptions,
    callbacks: TransportCallbacks
  ) {
    this.cols = options.cols
    this.rows = options.rows
    this.parser = new TelnetParser(
      (bytes) => {
        if (!this.closed) socket.write(bytes)
      },
      'XTERM-256COLOR',
      () => ({ cols: this.cols, rows: this.rows })
    )
    socket.on('data', (chunk: Buffer) => {
      const data = this.parser.push(chunk)
      if (data.length > 0) callbacks.onData(data)
    })
    let error: string | undefined
    socket.on('error', (e) => {
      error = e.message
    })
    socket.on('close', () => {
      if (this.closed) return
      this.closed = true
      callbacks.onExit({ code: error ? null : 0, signal: null, ...(error ? { error } : {}) })
    })
  }

  static open(options: TelnetOptions, callbacks: TransportCallbacks): Promise<TelnetTransport> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: options.host, port: options.port, noDelay: true })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`Timed out connecting to ${options.host}:${options.port}`))
      }, options.timeoutMs ?? 15_000)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(new TelnetTransport(socket, options, callbacks))
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  write(data: string): void {
    if (!this.closed) this.socket.write(this.parser.encode(data))
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.parser.resized()
  }

  pause(): void {
    this.socket.pause()
  }

  resume(): void {
    this.socket.resume()
  }

  close(): void {
    if (this.closed) return
    this.socket.end()
    this.socket.destroy()
  }
}
