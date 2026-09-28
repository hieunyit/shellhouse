import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateVerifiedKey } from '../../src/main/hosts/keygen'
import { deployPublicKey } from '../../src/session-host/ssh/deploy-key'
import { openSshShell } from '../../src/session-host/ssh/connect'
import { tempDir } from '../unit/helpers'
import { startTestSshServer } from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function connect(home: string) {
  const server = await startTestSshServer([{ username: 'u', password: 'p' }], { execHome: home })
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
  return shell.client
}

describe.skipIf(process.platform === 'win32')('deployPublicKey', () => {
  it('thêm key, quyền 700/600; chạy lần hai không thêm trùng', async () => {
    const home = tempDir()
    const client = await connect(home)
    const { publicKey } = generateVerifiedKey({ type: 'ed25519', comment: 'hieu@laptop' })
    expect(await deployPublicKey(client, publicKey)).toEqual({ status: 'added' })
    expect(await deployPublicKey(client, publicKey)).toEqual({ status: 'exists' })
    const file = join(home, '.ssh', 'authorized_keys')
    expect(readFileSync(file, 'utf8')).toBe(`${publicKey}\n`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700)
  })

  it('authorized_keys cũ không có xuống dòng cuối → không bị dính dòng', async () => {
    const home = tempDir()
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAAOLD old-key')
    const client = await connect(home)
    const { publicKey } = generateVerifiedKey({ type: 'ed25519', comment: 'new' })
    expect(await deployPublicKey(client, publicKey)).toEqual({ status: 'added' })
    expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8').split('\n')).toEqual([
      'ssh-ed25519 AAAAOLD old-key',
      publicKey,
      ''
    ])
  })

  it('nội dung key độc hại chỉ là dữ liệu, không bị thực thi', async () => {
    const home = tempDir()
    const client = await connect(home)
    const marker = join(home, 'pwned')
    const evil = `ssh-ed25519 AAAA $(touch ${marker}) \`touch ${marker}\`; touch ${marker}`
    await deployPublicKey(client, evil)
    expect(() => statSync(marker)).toThrow()
  })
})
