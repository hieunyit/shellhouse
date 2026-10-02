import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openSshShell } from '../../src/session-host/ssh/connect'
import { tempDir } from '../unit/helpers'
import { startTestSshServer } from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** Kết nối với tuỳ chọn tmux; `withTmux` = đặt chương trình tmux giả vào PATH của server. */
async function open(withTmux: boolean) {
  const home = tempDir()
  const bin = join(home, 'bin')
  mkdirSync(bin)
  if (withTmux) {
    // tmux giả: in tham số rồi lặp lại những gì nhận được (như một shell).
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho "fake-tmux $*"\nexec /bin/cat\n')
    chmodSync(join(bin, 'tmux'), 0o755)
  }
  const server = await startTestSshServer([{ username: 'u', password: 'p' }], {
    execHome: home,
    // Chỉ thư mục giả + hệ thống tối thiểu: không lẫn tmux thật của máy chạy test.
    execPath: bin,
    execPathOnly: true
  })
  cleanups.push(() => server.close())
  let text = ''
  const statuses: string[] = []
  const shell = await openSshShell({
    destination: {
      target: { host: '127.0.0.1', port: server.port, username: 'u' },
      knownKeyTypes: [],
      credentials: { password: 'p' }
    },
    cols: 80,
    rows: 24,
    agent: null,
    keyFiles: [],
    tmux: 'shellhouse-2',
    callbacks: {
      onData: (d) => {
        text += Buffer.from(d).toString('utf8')
      },
      onExit: () => undefined
    },
    ctx: {
      status: (_phase, detail) => {
        statuses.push(detail)
      },
      log: () => undefined,
      prompt: () => Promise.resolve({ ok: false, answers: [] }),
      verifyHostKey: () => Promise.resolve(true)
    }
  })
  cleanups.push(() => {
    shell.close()
  })
  return { shell, server, output: () => text, statuses }
}

describe.skipIf(process.platform === 'win32')('tmux', () => {
  it('server có tmux → gắn vào phiên theo tên (tạo nếu chưa có), có PTY', async () => {
    const { shell, server, output, statuses } = await open(true)
    await expect.poll(output).toContain('fake-tmux new-session -A -s shellhouse-2')
    expect(statuses.at(-1)).toBe('Authenticated, attaching to tmux session shellhouse-2…')
    expect(server.events.ptyRequests.at(-1)).toMatchObject({ cols: 80, rows: 24 })
    shell.write('hello\n')
    await expect.poll(output).toContain('hello')
  })

  it('server không có tmux → shell thường, báo trên dòng trạng thái', async () => {
    const { output, statuses } = await open(false)
    await expect.poll(output).toContain('welcome to test server')
    expect(statuses.at(-1)).toContain('tmux is not installed on the server')
  })
})
