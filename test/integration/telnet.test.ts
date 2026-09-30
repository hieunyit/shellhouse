import { afterEach, describe, expect, it } from 'vitest'
import { TelnetTransport } from '../../src/session-host/transport/telnet'
import type { TransportExit } from '../../src/session-host/transport/types'
import { friendlyOpenError } from '../../src/session-host/transport/serial'
import { startTelnetTestServer, type TelnetTestServer } from './telnet-test-server'

let server: TelnetTestServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Hết giờ chờ: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('Telnet', () => {
  it('thương lượng NAWS / TTYPE, đăng nhập, chạy lệnh, đổi cỡ cửa sổ, thoát', async () => {
    server = await startTelnetTestServer()
    let text = ''
    let exit: TransportExit | null = null
    const t = await TelnetTransport.open(
      { host: '127.0.0.1', port: server.port, cols: 132, rows: 43 },
      {
        onData: (d) => {
          text += Buffer.from(d).toString()
        },
        onExit: (e) => {
          exit = e
        }
      }
    )
    await until(() => text.includes('Username: '), 'dấu nhắc Username')
    expect(text).not.toContain('\xff') // lệnh IAC không lọt ra terminal
    await until(() => server?.windowSize() !== null, 'NAWS')
    expect(server.windowSize()).toEqual({ cols: 132, rows: 43 })
    expect(server.terminalType()).toBe('XTERM-256COLOR')

    t.write('admin\r')
    await until(() => text.includes('Password: '), 'dấu nhắc Password')
    t.write('secret\r')
    await until(() => text.includes('router#'), 'dấu nhắc router#')
    t.write('show version\r')
    await until(() => text.includes('% output of show version'), 'kết quả lệnh')

    t.resize(100, 30)
    await until(() => server?.windowSize()?.cols === 100, 'NAWS sau khi đổi cỡ')

    t.write('exit\r')
    await until(() => exit !== null, 'kết thúc')
    expect(exit).toMatchObject({ code: 0 })
  })

  it('không kết nối được → lỗi rõ ràng', async () => {
    await expect(
      TelnetTransport.open(
        { host: '127.0.0.1', port: 1, cols: 80, rows: 24 },
        { onData: () => undefined, onExit: () => undefined }
      )
    ).rejects.toThrow(/ECONNREFUSED|connect/)
  })
})

describe('Serial: thông báo lỗi mở cổng', () => {
  it('dễ hiểu cho các lỗi thường gặp', () => {
    expect(friendlyOpenError('COM9', 'File not found')).toMatch(/was not found/)
    expect(friendlyOpenError('/dev/ttyUSB0', 'Error: Permission denied')).toMatch(
      /permission denied/
    )
    expect(friendlyOpenError('COM3', 'Access denied')).toMatch(/in use by another program/)
  })
})
