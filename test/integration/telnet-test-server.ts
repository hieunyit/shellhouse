import { createServer, type AddressInfo, type Socket } from 'node:net'

const IAC = 255
const DO = 253
const WILL = 251
const SB = 250
const SE = 240

export interface TelnetTestServer {
  port: number
  /** Byte client gửi (đã bỏ lệnh IAC) theo từng kết nối. */
  received: () => string
  /** Kích thước cửa sổ client báo qua NAWS gần nhất. */
  windowSize: () => { cols: number; rows: number } | null
  terminalType: () => string | null
  close(): Promise<void>
}

/**
 * Server Telnet giả như console thiết bị mạng: xin NAWS + TTYPE, tự echo (WILL ECHO), hỏi
 * "Username:" rồi "Password:", sau đó là dấu nhắc "router#" và echo lệnh.
 */
export async function startTelnetTestServer(): Promise<TelnetTestServer> {
  let received = ''
  let size: { cols: number; rows: number } | null = null
  let ttype: string | null = null
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.write(
      Buffer.from([IAC, WILL, 1, IAC, WILL, 3, IAC, DO, 31, IAC, DO, 24, IAC, SB, 24, 1, IAC, SE])
    )
    socket.write('\r\nUser Access Verification\r\n\r\nUsername: ')
    let stage: 'user' | 'pass' | 'shell' = 'user'
    let line = ''
    let state: 'data' | 'iac' | 'cmd' | 'sb' = 'data'
    let sb: number[] = []
    socket.on('data', (chunk: Buffer) => {
      for (const b of chunk) {
        if (state === 'iac') {
          state = b === SB ? 'sb' : b >= 251 ? 'cmd' : 'data'
          sb = []
          continue
        }
        if (state === 'cmd') {
          state = 'data'
          continue
        }
        if (state === 'sb') {
          if (b === SE && sb.at(-1) === IAC) {
            sb.pop()
            if (sb[0] === 31)
              size = {
                cols: (sb[1] ?? 0) * 256 + (sb[2] ?? 0),
                rows: (sb[3] ?? 0) * 256 + (sb[4] ?? 0)
              }
            if (sb[0] === 24) ttype = Buffer.from(sb.slice(2)).toString('ascii')
            state = 'data'
          } else sb.push(b)
          continue
        }
        if (b === IAC) {
          state = 'iac'
          continue
        }
        if (b === 0) continue // CR NUL
        received += String.fromCharCode(b)
        if (b === 13) {
          socket.write('\r\n')
          if (stage === 'user') {
            stage = 'pass'
            socket.write('Password: ')
          } else if (stage === 'pass') {
            stage = 'shell'
            socket.write('router#')
          } else {
            if (line === 'exit') {
              socket.end()
              return
            }
            socket.write(`% output of ${line}\r\nrouter#`)
          }
          line = ''
        } else {
          line += String.fromCharCode(b)
          if (stage !== 'pass') socket.write(Buffer.from([b])) // server tự echo (trừ mật khẩu)
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    received: () => received,
    windowSize: () => size,
    terminalType: () => ttype,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  }
}
