import { describe, expect, it } from 'vitest'
import type { HostInput } from '@shared/hosts'
import { Secret } from '../../src/node-shared/secret'
import { HostService } from '../../src/main/hosts/service'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'
import { generateTestKey } from '../integration/ssh-test-server'

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  let clock = 1_000
  return { db, service: new HostService(db, vault, () => ++clock) }
}

const base: HostInput = {
  groupId: null,
  label: 'Web',
  hostname: 'web.example.com',
  port: 22,
  username: 'deploy',
  auth: 'auto',
  keyId: null,
  keyFile: null,
  proxyJump: null,
  jumpHostIds: [],
  mode: 'builtin',
  tags: [],
  color: null
}

describe('HostService.setHostPassword (lưu mật khẩu từ hộp hỏi)', () => {
  it('host Automatic → Password, mật khẩu được mã hoá và dùng khi kết nối', async () => {
    const { db, service } = await setup()
    const id = service.saveHost(base)
    service.setHostPassword(id, 'PW-SAVED-123')
    const host = service.tree().hosts[0]
    expect(host).toMatchObject({ auth: 'password', hasPassword: true, username: 'deploy' })
    expect(service.resolveForConnect(id).credentials.password).toBe('PW-SAVED-123')
    // Không lưu dạng rõ trong DB.
    const raw = db.prepare('SELECT secret_enc FROM identities').get() as { secret_enc: Buffer }
    expect(raw.secret_enc.toString('latin1')).not.toContain('PW-SAVED-123')
  })

  it('ghi đè mật khẩu cũ của host Password', async () => {
    const { service } = await setup()
    const id = service.saveHost({ ...base, auth: 'password', password: 'old' })
    service.setHostPassword(id, 'new-one')
    expect(service.resolveForConnect(id).credentials.password).toBe('new-one')
  })

  it('không đụng host dùng SSH key; host không tồn tại → lỗi', async () => {
    const { service } = await setup()
    const key = service.importKey('laptop', generateTestKey().private)
    const keyHost = service.saveHost({ ...base, auth: 'key', keyId: key.id })
    expect(() => {
      service.setHostPassword(keyHost, 'x')
    }).toThrow(/SSH key/)
    expect(service.tree().hosts.find((h) => h.id === keyHost)?.auth).toBe('key')
    expect(() => {
      service.setHostPassword('missing', 'x')
    }).toThrow('Host not found')
    const id = service.saveHost(base)
    expect(() => {
      service.setHostPassword(id, '')
    }).toThrow()
  })
})
