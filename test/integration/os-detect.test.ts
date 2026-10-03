import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { osFromRelease, parseOsRelease } from '@shared/host-os'
import { openSshShell } from '../../src/session-host/ssh/connect'
import { detectServerOs } from '../../src/session-host/ssh/os-detect'
import { tempDir } from '../unit/helpers'
import { startTestSshServer } from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function connect(options: { exec: boolean }) {
  const server = await startTestSshServer(
    [{ username: 'u', password: 'p' }],
    options.exec ? { execHome: tempDir() } : {}
  )
  cleanups.push(() => server.close())
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
  return shell
}

function localRelease(): ReturnType<typeof osFromRelease> {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return osFromRelease(parseOsRelease(readFileSync(file, 'utf8')))
    } catch {
      // Thử file kế.
    }
  }
  return null
}

// Server thử chạy lệnh bằng /bin/sh của máy chạy test → kết quả = hệ điều hành của chính máy này.
describe.skipIf(process.platform === 'win32')('Dò hệ điều hành server (kênh exec riêng)', () => {
  it('nhận ra đúng hệ điều hành của máy chạy server thử', async () => {
    const shell = await connect({ exec: true })
    const os = await detectServerOs(shell.client)
    if (process.platform === 'darwin') expect(os?.id).toBe('macos')
    else expect(os).toEqual(localRelease() ?? expect.objectContaining({ id: 'linux' }))
  })

  it('server không cho exec → null, không treo, shell vẫn dùng được', async () => {
    const shell = await connect({ exec: false })
    const started = Date.now()
    expect(await detectServerOs(shell.client, 3000)).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
