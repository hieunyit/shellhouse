import { createHash, createHmac, randomBytes } from 'node:crypto'
import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PromptRequest } from '@shared/stream-protocol'
import { openSshShell, type HopConfig, type SshShell } from '../../src/session-host/ssh/connect'
import type { StoredCredentials } from '../../src/session-host/ssh/auth'
import { SftpService } from '../../src/session-host/sftp/service'
import { pipelinedDownload, pipelinedUpload } from '../../src/session-host/sftp/pipelined'
import type { PromptReply } from '../../src/session-host/transport/types'
import { tempDir } from '../unit/helpers'

/**
 * Ma trận tương thích (KE-HOACH-MOI.md 8.2) với server SSH THẬT trong Docker, chạy qua đúng đường
 * code của Session Host: openSshShell (auth, host key, jump), SftpService + truyền song song,
 * forwardOut. `pnpm test:compat`.
 */

const RUN = join(__dirname, '.run')
const USER = 'tester'
const PASSWORD = 'compat-pw'

interface Server {
  name: string
  port: number
  /** Loại host key server đưa ra khi client không có ưu tiên nào. */
  hostKeyType: string
}

const SERVERS: Server[] = [
  { name: 'OpenSSH 7.4 (CentOS 7)', port: 22741, hostKeyType: 'ssh-ed25519' },
  { name: 'OpenSSH 8.2 (Ubuntu 20.04)', port: 22821, hostKeyType: 'ssh-ed25519' },
  { name: 'OpenSSH 9.6 (Ubuntu 24.04)', port: 22961, hostKeyType: 'ssh-ed25519' },
  { name: 'OpenSSH mới nhất (Alpine)', port: 22991, hostKeyType: 'ssh-ed25519' },
  { name: 'Dropbear', port: 22201, hostKeyType: 'ssh-ed25519' }
]

const open_: (() => void)[] = []
afterEach(() => {
  for (const close of open_.splice(0)) close()
})

function keyType(blob: Buffer): string {
  const len = blob.readUInt32BE(0)
  return blob.subarray(4, 4 + len).toString()
}

interface Session {
  shell: SshShell
  hostKeyTypes: string[]
  prompts: PromptRequest[]
  run(command: string): Promise<string>
}

async function connect(opts: {
  host?: string
  port: number
  credentials?: StoredCredentials
  answer?: (req: PromptRequest) => PromptReply
  jumps?: HopConfig[]
  legacy?: boolean
}): Promise<Session> {
  let text = ''
  const hostKeyTypes: string[] = []
  const prompts: PromptRequest[] = []
  const shell = await openSshShell({
    destination: {
      target: { host: opts.host ?? '127.0.0.1', port: opts.port, username: USER },
      knownKeyTypes: [],
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      ...(opts.legacy ? { legacyAlgorithms: true } : {})
    },
    ...(opts.jumps ? { jumps: opts.jumps } : {}),
    cols: 120,
    rows: 30,
    agent: null,
    keyFiles: [],
    callbacks: {
      onData: (d) => {
        text += Buffer.from(d).toString('utf8')
      },
      onExit: () => undefined
    },
    ctx: {
      status: () => undefined,
      log: () => undefined,
      prompt: (req) => {
        prompts.push(req)
        return Promise.resolve(opts.answer?.(req) ?? { ok: false, answers: [] })
      },
      verifyHostKey: (_h, _p, key) => {
        hostKeyTypes.push(keyType(key))
        return Promise.resolve(true)
      }
    }
  })
  open_.push(() => {
    shell.close()
  })
  let seq = 0
  return {
    shell,
    hostKeyTypes,
    prompts,
    // Chạy lệnh trong shell tương tác, lấy output giữa hai dấu mốc.
    run: async (command) => {
      const mark = `__M${++seq}__`
      const start = text.length
      shell.write(`echo ${mark}B; ${command}; echo ${mark}E\r`)
      const deadline = Date.now() + 15_000
      for (;;) {
        const chunk = text.slice(start)
        const b = chunk.lastIndexOf(`${mark}B\r\n`)
        const e = chunk.lastIndexOf(`${mark}E`)
        if (b !== -1 && e > b) return chunk.slice(b + mark.length + 3, e).trim()
        if (Date.now() > deadline)
          throw new Error(`Hết giờ chờ "${command}": ${JSON.stringify(chunk)}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    }
  }
}

const passwordCreds: StoredCredentials = { password: PASSWORD }
async function keyCreds(type: 'ed25519' | 'rsa'): Promise<StoredCredentials> {
  return { privateKey: { data: await readFile(join(RUN, `id_${type}`), 'utf8'), label: type } }
}

/** RFC 6238 TOTP (SHA-1, 6 số, bước 30 giây) từ bí mật base32. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? [])
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const h = createHmac('sha1', key).update(counter).digest()
  const o = (h[h.length - 1] ?? 0) & 0xf
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

describe.each(SERVERS)('$name', (server) => {
  it('mật khẩu: vào shell, chạy lệnh; host key hiện đại', async () => {
    const s = await connect({ port: server.port, credentials: passwordCreds })
    expect(await s.run('echo xin-chao-$((40+2))')).toBe('xin-chao-42')
    expect(await s.run('whoami')).toBe(USER)
    expect(s.hostKeyTypes).toEqual([server.hostKeyType])
  })

  it.each(['ed25519', 'rsa'] as const)('public key %s', async (type) => {
    const s = await connect({ port: server.port, credentials: await keyCreds(type) })
    expect(await s.run('whoami')).toBe(USER)
    expect(s.prompts).toEqual([]) // không hỏi mật khẩu
  })

  it('SFTP: truyền song song 1 MB lên rồi xuống, đúng sha256; liệt kê thư mục', async () => {
    const s = await connect({ port: server.port, credentials: passwordCreds })
    const sftp = new SftpService(s.shell.client)
    const home = await sftp.realpath('.')
    const local = tempDir()
    const payload = randomBytes(1024 * 1024 + 12_345)
    await writeFile(join(local, 'up.bin'), payload)
    const control = { onProgress: () => undefined, isCancelled: () => false }
    const channel = await sftp.channel()
    const src = await open(join(local, 'up.bin'), 'r')
    try {
      await pipelinedUpload(channel, sftp, src, `${home}/compat.bin`, 0, payload.length, control)
    } finally {
      await src.close()
    }
    const dst = await open(join(local, 'down.bin'), 'w')
    try {
      await pipelinedDownload(channel, sftp, `${home}/compat.bin`, dst, 0, payload.length, control)
    } finally {
      await dst.close()
    }
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
    expect(sha(await readFile(join(local, 'down.bin')))).toBe(sha(payload))
    const listing = await sftp.list(home)
    expect(listing.entries.map((e) => e.name)).toContain('compat.bin')
    await sftp.remove(`${home}/compat.bin`, false)
  })

  it('port forward (direct-tcpip): tới cổng 22 bên trong server', async () => {
    const s = await connect({ port: server.port, credentials: passwordCreds })
    const banner = await new Promise<string>((resolve, reject) => {
      s.shell.client.forwardOut('127.0.0.1', 0, '127.0.0.1', 22, (error, stream) => {
        if (error) {
          reject(error)
          return
        }
        stream.once('data', (d: Buffer) => {
          resolve(d.toString())
          stream.end()
        })
      })
    })
    expect(banner).toMatch(/^SSH-2\.0-/)
  })
})

describe('Thiết bị đời cũ (chỉ ssh-rsa, DH group1/14-sha1, CBC, hmac-sha1)', () => {
  it('mặc định từ chối (thuật toán yếu không được bật ngầm)', async () => {
    await expect(connect({ port: 22101, credentials: passwordCreds })).rejects.toThrow()
  })

  it('bật "legacy algorithms" cho host → kết nối, chạy lệnh, SFTP', async () => {
    const s = await connect({ port: 22101, credentials: passwordCreds, legacy: true })
    expect(await s.run('whoami')).toBe(USER)
    expect(s.hostKeyTypes).toEqual(['ssh-rsa'])
    const sftp = new SftpService(s.shell.client)
    expect((await sftp.list(await sftp.realpath('.'))).path).toMatch(/tester/)
  })
})

describe('2FA: mật khẩu + TOTP qua keyboard-interactive (PAM google-authenticator)', () => {
  it('trả lời từng câu hỏi của server; sai mã thì bị từ chối', async () => {
    const answer =
      (code: string) =>
      (req: PromptRequest): PromptReply => {
        if (req.kind !== 'keyboard-interactive') return { ok: false, answers: [] }
        return {
          ok: true,
          answers: req.fields.map((f) => (/verification|code/i.test(f.prompt) ? code : PASSWORD))
        }
      }
    const s = await connect({ port: 22301, answer: answer(totp('JBSWY3DPEHPK3PXP')) })
    expect(await s.run('whoami')).toBe(USER)
    const asked = s.prompts
      .flatMap((p) => (p.kind === 'keyboard-interactive' ? p.fields.map((f) => f.prompt) : []))
      .join(' | ')
    expect(asked).toMatch(/password/i)
    expect(asked).toMatch(/verification code/i)

    await expect(connect({ port: 22301, answer: answer('000000') })).rejects.toThrow()
  })
})

describe('Bastion 2 tầng (ProxyJump): máy ngoài → bastion1 → bastion2 → target', () => {
  it('đi qua hai jump host (mạng nội bộ), vào được target chỉ nhìn thấy từ bên trong', async () => {
    const hop = (host: string, port: number): HopConfig => ({
      target: { host, port, username: USER },
      knownKeyTypes: [],
      credentials: passwordCreds
    })
    const s = await connect({
      host: 'target',
      port: 22,
      credentials: passwordCreds,
      jumps: [hop('127.0.0.1', 22401), hop('bastion2', 22)]
    })
    expect(await s.run('grep -c Alpine /etc/os-release')).not.toBe('0')
    expect(s.hostKeyTypes).toHaveLength(3) // mỗi chặng đều được kiểm host key
  })
})
