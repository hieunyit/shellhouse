import { createHmac, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostFieldMatches, hostToken, KnownHosts } from '../../src/main/known-hosts'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { tempDir } from './helpers'

function fakeKey(type: string): Buffer {
  const t = Buffer.from(type)
  const body = randomBytes(32)
  const out = Buffer.alloc(8 + t.length + body.length)
  out.writeUInt32BE(t.length, 0)
  t.copy(out, 4)
  out.writeUInt32BE(body.length, 4 + t.length)
  body.copy(out, 8 + t.length)
  return out
}

function hashed(token: string): string {
  const salt = randomBytes(20)
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(token).digest('base64')}`
}

async function store(files: string[] = []) {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  return new KnownHosts(db, files)
}

describe('hostFieldMatches', () => {
  it('host thường, port khác 22, danh sách, wildcard, phủ định', () => {
    expect(hostToken('a.example', 22)).toBe('a.example')
    expect(hostToken('a.example', 2222)).toBe('[a.example]:2222')
    expect(hostFieldMatches('a.example,10.0.0.1', 'a.example', 22)).toBe(true)
    expect(hostFieldMatches('a.example', 'a.example', 2222)).toBe(false)
    expect(hostFieldMatches('[a.example]:2222', 'a.example', 2222)).toBe(true)
    expect(hostFieldMatches('*.example', 'b.example', 22)).toBe(true)
    expect(hostFieldMatches('*.example,!bad.example', 'bad.example', 22)).toBe(false)
    expect(hostFieldMatches('a?.example', 'ab.example', 22)).toBe(true)
    expect(hostFieldMatches('a.example', 'axexample', 22)).toBe(false) // '.' không phải wildcard
  })

  it('dòng hashed |1|salt|hash', () => {
    expect(hostFieldMatches(hashed('h.example'), 'h.example', 22)).toBe(true)
    expect(hostFieldMatches(hashed('[h.example]:2200'), 'h.example', 2200)).toBe(true)
    expect(hostFieldMatches(hashed('h.example'), 'other', 22)).toBe(false)
  })
})

describe('KnownHosts', () => {
  it('host mới → unknown; tin rồi → match (không phân biệt hoa thường)', async () => {
    const kh = await store()
    const key = fakeKey('ssh-ed25519')
    expect(kh.check('Srv.Example', 22, key)).toEqual({ status: 'unknown' })
    kh.trust('Srv.Example', 22, key)
    expect(kh.check('srv.example', 22, key)).toEqual({ status: 'match' })
    expect(kh.check('srv.example', 2222, key)).toEqual({ status: 'unknown' })
    expect(kh.knownKeyTypes('SRV.EXAMPLE', 22)).toEqual(['ssh-ed25519'])
  })

  it('key đổi (cùng loại hoặc khác loại) → changed kèm fingerprint cũ', async () => {
    const kh = await store()
    const old = fakeKey('ssh-ed25519')
    kh.trust('h', 22, old)
    const same = kh.check('h', 22, fakeKey('ssh-ed25519'))
    expect(same.status).toBe('changed')
    if (same.status === 'changed') expect(same.known[0]?.fingerprint).toMatch(/^SHA256:/)
    expect(kh.check('h', 22, fakeKey('ecdsa-sha2-nistp256')).status).toBe('changed')
  })

  it('chấp nhận key mới thay thế toàn bộ key cũ của host:port', async () => {
    const kh = await store()
    kh.trust('h', 22, fakeKey('ssh-ed25519'))
    const next = fakeKey('ssh-rsa')
    kh.trust('h', 22, next)
    expect(kh.check('h', 22, next)).toEqual({ status: 'match' })
    expect(kh.knownKeyTypes('h', 22)).toEqual(['ssh-rsa'])
  })

  it('đọc known_hosts của OpenSSH: khớp, đổi key, @revoked, @cert-authority bị bỏ qua', async () => {
    const dir = tempDir()
    const file = join(dir, 'known_hosts')
    const good = fakeKey('ssh-ed25519')
    const revoked = fakeKey('ssh-ed25519')
    const ca = fakeKey('ssh-ed25519')
    writeFileSync(
      file,
      [
        '# comment',
        `${hashed('a.example')} ssh-ed25519 ${good.toString('base64')}`,
        `@revoked * ssh-ed25519 ${revoked.toString('base64')}`,
        `@cert-authority *.example ssh-ed25519 ${ca.toString('base64')}`,
        'dòng hỏng'
      ].join('\n')
    )
    const kh = await store([file, join(dir, 'không-tồn-tại')])
    expect(kh.check('a.example', 22, good)).toEqual({ status: 'match' })
    expect(kh.check('a.example', 22, fakeKey('ssh-ed25519')).status).toBe('changed')
    expect(kh.check('z.example', 22, revoked)).toEqual({ status: 'revoked' })
    expect(kh.check('b.example', 22, ca)).toEqual({ status: 'unknown' })
  })

  it('đã xác nhận key mới trong app thì file OpenSSH cũ không còn báo đổi', async () => {
    const dir = tempDir()
    const file = join(dir, 'known_hosts')
    writeFileSync(file, `a.example ssh-ed25519 ${fakeKey('ssh-ed25519').toString('base64')}\n`)
    const kh = await store([file])
    const rotated = fakeKey('ssh-ed25519')
    expect(kh.check('a.example', 22, rotated).status).toBe('changed')
    kh.trust('a.example', 22, rotated)
    expect(kh.check('a.example', 22, rotated)).toEqual({ status: 'match' })
  })
})
