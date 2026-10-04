import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AccountInput, HostInput } from '@shared/hosts'
import { Secret } from '../../src/node-shared/secret'
import { HostService } from '../../src/main/hosts/service'
import { openDatabase } from '../../src/main/store/db'
import { migrate, schemaVersion } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'
import { DEFAULT_RDP } from '../../src/shared/rdp'
import { generateTestKey } from '../integration/ssh-test-server'
import { tempDir } from './helpers'

async function setup(path = ':memory:') {
  const db = openDatabase(path)
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  let clock = 1_000
  const service = new HostService(db, vault, () => ++clock)
  return { db, vault, service }
}

const host: HostInput = {
  groupId: null,
  label: 'Web',
  hostname: 'web.example.com',
  port: 22,
  username: '',
  auth: 'auto',
  keyId: null,
  keyFile: null,
  proxyJump: null,
  jumpHostIds: [],
  mode: 'builtin',
  tags: [],
  color: null
}

const account: AccountInput = {
  name: 'Deploy',
  username: 'deploy',
  keyId: null,
  domain: '',
  notes: ''
}

/** Tài khoản có đủ mật khẩu + key có passphrase. */
function fullAccount(service: HostService) {
  const pair = generateTestKey('key-pass')
  const key = service.importKey('deploy-key', pair.private)
  const id = service.saveAccount({
    ...account,
    password: 'ACCOUNT-PW-111',
    keyId: key.id,
    passphrase: 'key-pass',
    notes: 'prod fleet'
  })
  return { id, key, pair }
}

describe('Tài khoản dùng chung', () => {
  it('tạo tài khoản: secret mã hoá trong DB, renderer chỉ thấy cờ has*', async () => {
    const path = join(tempDir(), 'a.db')
    const { db, service } = await setup(path)
    const { id, key } = fullAccount(service)
    const [summary] = service.tree().accounts
    expect(summary).toEqual({
      id,
      name: 'Deploy',
      username: 'deploy',
      hasPassword: true,
      keyId: key.id,
      hasPassphrase: true,
      domain: '',
      notes: 'prod fleet',
      hostIds: [],
      updatedAt: expect.any(Number) as number
    })
    expect(JSON.stringify(service.tree())).not.toContain('ACCOUNT-PW-111')
    db.pragma('wal_checkpoint(TRUNCATE)')
    const raw = readFileSync(path)
    expect(raw.includes('ACCOUNT-PW-111')).toBe(false)
    expect(raw.includes('key-pass')).toBe(false)
  })

  it('tên tài khoản không trùng; key phải còn trong vault', async () => {
    const { service } = await setup()
    service.saveAccount(account)
    expect(() => service.saveAccount({ ...account, name: ' deploy ' })).toThrow(/already/)
    expect(() => service.saveAccount({ ...account, name: 'X', keyId: 'missing' })).toThrow(
      /no longer exists/
    )
  })

  it('host liên kết tới tài khoản (không chép); kết nối dùng key + passphrase rồi mật khẩu', async () => {
    const { db, service } = await setup()
    const { id: accountId, key, pair } = fullAccount(service)
    const hostId = service.saveHost({ ...host, accountId })
    const identities = db.prepare('SELECT COUNT(*) AS n FROM identities').get() as { n: number }
    expect(identities.n).toBe(1)
    const summary = service.tree().hosts[0]
    expect(summary).toMatchObject({
      accountId,
      username: 'deploy',
      auth: 'key',
      keyId: key.id,
      hasPassword: true
    })
    expect(service.tree().accounts[0]?.hostIds).toEqual([hostId])
    const resolved = service.resolveForConnect(hostId)
    expect(resolved.target.username).toBe('deploy')
    expect(resolved.credentials.password).toBe('ACCOUNT-PW-111')
    expect(resolved.credentials.privateKey).toEqual({
      data: pair.private,
      label: 'deploy-key',
      passphrase: 'key-pass'
    })
    expect(resolved.storedOnly).toBe(true)
  })

  it('sửa tài khoản áp cho mọi host; đổi key thì passphrase cũ bị bỏ; giữ mật khẩu khi không nhập', async () => {
    const { service } = await setup()
    const { id: accountId } = fullAccount(service)
    const a = service.saveHost({ ...host, accountId })
    const b = service.saveHost({ ...host, label: 'Api', hostname: 'api', accountId })
    const other = service.importKey('other', generateTestKey().private)
    service.saveAccount({ ...account, id: accountId, username: 'ops', keyId: other.id })
    for (const id of [a, b]) {
      const r = service.resolveForConnect(id)
      expect(r.target.username).toBe('ops')
      expect(r.credentials.password).toBe('ACCOUNT-PW-111')
      expect(r.credentials.privateKey?.label).toBe('other')
      expect(r.credentials.privateKey?.passphrase).toBeUndefined()
    }
    // Bỏ key + xoá mật khẩu → tài khoản chỉ còn username: host kết nối kiểu Automatic.
    service.saveAccount({ ...account, id: accountId, password: '' })
    expect(service.tree().hosts[0]?.auth).toBe('auto')
    const r = service.resolveForConnect(a)
    expect(r.credentials).toEqual({})
    expect(r.storedOnly).toBeUndefined()
  })

  it('username tài khoản phải hợp lệ cho mọi host đang dùng', async () => {
    const { service } = await setup()
    const accountId = service.saveAccount({ ...account, username: 'john@corp.com' })
    // UPN hợp lệ cho Windows, không hợp lệ cho SSH.
    expect(() => service.saveHost({ ...host, accountId })).toThrow(/not a valid SSH username/)
    const rdp = service.saveHost({
      ...host,
      protocol: 'rdp',
      port: 3389,
      rdp: DEFAULT_RDP,
      accountId
    })
    expect(service.tree().hosts.find((h) => h.id === rdp)?.accountId).toBe(accountId)
    expect(() => service.saveHost({ ...host, protocol: 'telnet', port: 23, accountId })).toThrow(
      /SSH and Remote Desktop/
    )
    // Đã có host RDP dùng: đổi sang username sai quy tắc Windows bị chặn.
    expect(() => service.saveAccount({ ...account, id: accountId, username: 'a:b' })).toThrow()
  })

  it('RDP: username / domain / mật khẩu lấy từ tài khoản', async () => {
    const { service } = await setup()
    const accountId = service.saveAccount({
      ...account,
      username: 'Administrator',
      domain: 'CORP',
      password: 'rdp-secret'
    })
    const id = service.saveHost({
      ...host,
      protocol: 'rdp',
      port: 3389,
      rdp: { ...DEFAULT_RDP, domain: 'OLD' },
      accountId
    })
    const r = service.resolveRdp(id, false)
    try {
      expect(r.username).toBe('Administrator')
      expect(r.settings.domain).toBe('CORP')
      expect(r.password?.revealString()).toBe('rdp-secret')
    } finally {
      r.password?.dispose()
    }
  })

  it('chuyển từ tài khoản sang thông tin riêng: chép secret, tài khoản không bị đụng', async () => {
    const { service } = await setup()
    const { id: accountId, key } = fullAccount(service)
    const id = service.saveHost({ ...host, accountId })
    // Renderer chép username / key, không nhập lại passphrase → lấy từ tài khoản.
    service.saveHost({ ...host, id, username: 'deploy', auth: 'key', keyId: key.id })
    const summary = service.tree().hosts[0]
    expect(summary?.accountId).toBeUndefined()
    expect(service.resolveForConnect(id).credentials.privateKey?.passphrase).toBe('key-pass')
    expect(service.tree().accounts[0]).toMatchObject({ hostIds: [], hasPassword: true })
    // Host mới chọn tài khoản rồi đổi ý sang Custom (secretsFrom): mật khẩu chép từ tài khoản.
    const fresh = service.saveHost({
      ...host,
      label: 'Fresh',
      username: 'deploy',
      auth: 'password',
      secretsFrom: accountId
    })
    expect(service.resolveForConnect(fresh).credentials.password).toBe('ACCOUNT-PW-111')
    expect(() =>
      service.saveHost({ ...host, label: 'X', auth: 'password', secretsFrom: 'nope' })
    ).toThrow(/no longer exists/)
  })

  it('host có identity riêng chuyển sang tài khoản: identity riêng bị bỏ (xoá secret)', async () => {
    const { db, service } = await setup()
    const id = service.saveHost({
      ...host,
      username: 'me',
      auth: 'password',
      password: 'own-pw'
    })
    const accountId = service.saveAccount({ ...account, password: 'shared' })
    service.saveHost({ ...host, id, accountId })
    const own = db
      .prepare('SELECT secret_enc, deleted_at FROM identities WHERE shared = 0')
      .get() as { secret_enc: Buffer | null; deleted_at: number | null }
    expect(own.secret_enc).toBeNull()
    expect(own.deleted_at).not.toBeNull()
    expect(service.resolveForConnect(id).credentials.password).toBe('shared')
  })

  it('xoá host / nhân bản host không đụng tới tài khoản', async () => {
    const { service } = await setup()
    const { id: accountId } = fullAccount(service)
    const id = service.saveHost({ ...host, accountId })
    const copy = service.duplicateHost(id)
    expect(service.tree().accounts[0]?.hostIds.sort()).toEqual([id, copy].sort())
    service.deleteHost(id)
    service.deleteHost(copy)
    expect(service.tree().accounts[0]).toMatchObject({ hasPassword: true, hostIds: [] })
  })

  it('mật khẩu lưu từ hộp hỏi mật khẩu đi vào tài khoản, key giữ nguyên', async () => {
    const { service } = await setup()
    const { id: accountId } = fullAccount(service)
    const id = service.saveHost({ ...host, accountId })
    service.setHostPassword(id, 'rotated')
    const r = service.resolveForConnect(id)
    expect(r.credentials.password).toBe('rotated')
    expect(r.credentials.privateKey?.passphrase).toBe('key-pass')
  })

  it('xoá tài khoản đang dùng: phải chọn cách xử lý', async () => {
    const { service } = await setup()
    const { id: accountId } = fullAccount(service)
    const a = service.saveHost({ ...host, accountId })
    expect(() => {
      service.deleteAccount(accountId)
    }).toThrow(/used by 1 host/)

    // Chép vào host: host vẫn kết nối y như cũ (cả key lẫn mật khẩu), tài khoản biến mất.
    service.deleteAccount(accountId, { mode: 'convert' })
    expect(service.tree().accounts).toEqual([])
    const summary = service.tree().hosts[0]
    expect(summary?.accountId).toBeUndefined()
    expect(summary).toMatchObject({ username: 'deploy', auth: 'key', hasPassword: true })
    const r = service.resolveForConnect(a)
    expect(r.credentials.password).toBe('ACCOUNT-PW-111')
    expect(r.credentials.privateKey?.passphrase).toBe('key-pass')
  })

  it('xoá tài khoản: chuyển host sang tài khoản khác', async () => {
    const { service } = await setup()
    const first = service.saveAccount({ ...account, password: 'one' })
    const second = service.saveAccount({ ...account, name: 'Ops', username: 'ops' })
    const id = service.saveHost({ ...host, accountId: first })
    expect(() => {
      service.deleteAccount(first, { mode: 'reassign', accountId: first })
    }).toThrow()
    service.deleteAccount(first, { mode: 'reassign', accountId: second })
    expect(service.tree().hosts[0]?.accountId).toBe(second)
    expect(service.tree().accounts.map((x) => x.name)).toEqual(['Ops'])
    expect(service.resolveForConnect(id).target.username).toBe('ops')
  })

  it('nhân bản tài khoản (kể cả secret); key đang được tài khoản dùng thì không xoá được', async () => {
    const { service } = await setup()
    const { id, key } = fullAccount(service)
    const copy = service.duplicateAccount(id)
    const copy2 = service.duplicateAccount(id)
    expect(service.tree().accounts.map((x) => x.name)).toEqual([
      'Deploy',
      'Deploy (copy 2)',
      'Deploy (copy)'
    ])
    const h = service.saveHost({ ...host, accountId: copy })
    expect(service.resolveForConnect(h).credentials.password).toBe('ACCOUNT-PW-111')
    service.deleteAccount(copy2)
    expect(() => {
      service.deleteKey(key.id)
    }).toThrow(/used by 2 accounts/)
  })
})

describe('Migration 0011 (accounts)', () => {
  it('nâng cấp DB có sẵn host (dữ liệu cũ) — host vẫn như cũ, identity cũ là riêng', async () => {
    const db = openDatabase(':memory:')
    await migrate(db, MIGRATIONS.slice(0, 10))
    const vault = new Vault(db, TEST_KDF)
    await vault.create(Secret.fromString('master-password'))
    const pair = generateTestKey('pp')
    const keySealed = vault.encryptString(
      { table: 'keys', id: 'k1', field: 'private_key_enc' },
      pair.private
    )
    db.prepare(
      `INSERT INTO keys (id, name, type, public_key, private_key_enc, encrypted, created_at, updated_at)
       VALUES ('k1', 'old-key', 'ed25519', ?, ?, 1, 1, 1)`
    ).run(pair.public.split(' ').slice(0, 2).join(' '), keySealed)
    const seal = (id: string, value: string) =>
      vault.encryptString({ table: 'identities', id, field: 'secret_enc' }, value)
    db.prepare(
      `INSERT INTO identities (id, name, username, auth_type, secret_enc, key_id, updated_at)
       VALUES ('i1', 'pw', 'alice', 'password', ?, NULL, 1),
              ('i2', 'key', 'bob', 'key', ?, 'k1', 1)`
    ).run(seal('i1', 'old-pw'), seal('i2', 'pp'))
    db.prepare(
      `INSERT INTO hosts (id, label, hostname, port, identity_id, updated_at)
       VALUES ('h1', 'A', 'a.example', 22, 'i1', 1), ('h2', 'B', 'b.example', 22, 'i2', 1)`
    ).run()

    await migrate(db, MIGRATIONS)
    expect(schemaVersion(db)).toBe(11)
    const service = new HostService(db, vault)
    const tree = service.tree()
    expect(tree.accounts).toEqual([])
    expect(tree.hosts.map((h) => [h.label, h.auth, h.hasPassword, h.accountId])).toEqual([
      ['A', 'password', true, undefined],
      ['B', 'key', false, undefined]
    ])
    expect(service.resolveForConnect('h1').credentials).toEqual({ password: 'old-pw' })
    expect(service.resolveForConnect('h2').credentials.privateKey).toMatchObject({
      label: 'old-key',
      passphrase: 'pp'
    })
    // Sửa host cũ vẫn theo cách lưu cũ (giữ mật khẩu khi không nhập lại).
    service.saveHost({ ...host, id: 'h1', label: 'A', username: 'alice', auth: 'password' })
    expect(service.resolveForConnect('h1').credentials.password).toBe('old-pw')
  })
})
