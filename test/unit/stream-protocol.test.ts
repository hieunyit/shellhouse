import { describe, expect, it } from 'vitest'
import {
  ClientMessage,
  isServerMessage,
  SshSessionSpec,
  STREAM_LIMITS
} from '@shared/stream-protocol'

describe('ClientMessage', () => {
  it('chấp nhận tin hợp lệ', () => {
    for (const m of [
      { t: 'input', d: 'ls\r' },
      { t: 'resize', cols: 120, rows: 40 },
      { t: 'ack', n: 65536 }
    ]) {
      expect(ClientMessage.safeParse(m).success).toBe(true)
    }
  })

  it.each([
    { t: 'resize', cols: 0, rows: 10 },
    { t: 'resize', cols: STREAM_LIMITS.maxCols + 1, rows: 10 },
    { t: 'resize', cols: 1.5, rows: 10 },
    { t: 'ack', n: -1 },
    { t: 'input', d: 42 },
    { t: 'exec', cmd: 'rm -rf /' },
    null,
    'input'
  ])('từ chối %j', (m) => {
    expect(ClientMessage.safeParse(m).success).toBe(false)
  })
})

describe('isServerMessage', () => {
  it('nhận diện đúng', () => {
    expect(isServerMessage({ t: 'data', d: new Uint8Array(1) })).toBe(true)
    expect(isServerMessage({ t: 'exit', code: 0, signal: null, reason: 'normal' })).toBe(true)
    expect(isServerMessage({ t: 'error', message: 'x' })).toBe(true)
  })

  it('từ chối sai kiểu', () => {
    expect(isServerMessage({ t: 'data', d: 'text' })).toBe(false)
    expect(isServerMessage({ t: 'exit', code: '0', signal: null, reason: 'normal' })).toBe(false)
    expect(isServerMessage({ t: 'exit', code: 0, signal: null, reason: 'x' })).toBe(false)
    expect(isServerMessage({ t: 'other' })).toBe(false)
    expect(isServerMessage(null)).toBe(false)
  })
})

describe('SshSessionSpec', () => {
  const base = { kind: 'ssh', cols: 80, rows: 24 } as const
  const ok = (host: string, username = 'root', port = 22): boolean =>
    SshSessionSpec.safeParse({ ...base, target: { host, port, username } }).success

  it('chấp nhận hostname, IPv4, IPv6', () => {
    for (const h of ['srv.example', '10.0.0.1', '::1', 'fe80::1%eth0', 'my-host'])
      expect(ok(h)).toBe(true)
  })

  it('chặn chèn tham số và ký tự lạ', () => {
    for (const h of ['-oProxyCommand=x', '-p', 'a b', 'x;rm', 'a\nb', '']) expect(ok(h)).toBe(false)
    for (const u of ['-l', 'a b', 'a@b', 'a/b']) expect(ok('h', u)).toBe(false)
    expect(ok('h', 'root', 0)).toBe(false)
    expect(ok('h', 'root', 65536)).toBe(false)
  })
})

describe('tiện ích SFTP', () => {
  it('formatMode, joinRemote, parentRemote, baseName', async () => {
    const { formatMode, joinRemote, parentRemote, baseName } = await import('@shared/sftp')
    expect(formatMode(0o755)).toBe('rwxr-xr-x')
    expect(formatMode(0o640)).toBe('rw-r-----')
    expect(joinRemote('/home/u', 'a.txt')).toBe('/home/u/a.txt')
    expect(joinRemote('/', 'etc')).toBe('/etc')
    expect(parentRemote('/home/u/')).toBe('/home')
    expect(parentRemote('/home')).toBe('/')
    expect(parentRemote('/')).toBe('/')
    expect(baseName('C:\\Users\\u\\file.txt')).toBe('file.txt')
    expect(baseName('/tmp/x/y.bin')).toBe('y.bin')
  })
})
