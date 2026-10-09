import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Secret } from '../../../../node-shared/secret'
import { openDatabase } from '../../../../main/store/db'
import { migrate } from '../../../../main/store/migrate'
import { MIGRATIONS } from '../../../../main/store/migrations'
import { TEST_KDF } from '../../../../main/vault/crypto'
import { Vault } from '../../../../main/vault/vault'
import { createModuleDb } from '../../../registry/main-db'
import { DockerTcpEndpoints } from '../../main/tcp-endpoints'
import m0004 from '../../migrations/0004_tcp.sql?raw'

const F = join(__dirname, '../fixtures')
const pem = (name: string): string => readFileSync(join(F, name), 'utf8')

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  db.exec(m0004)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  const secrets = {
    seal: (table: string, id: string, field: string, value: string) =>
      vault.encryptString({ table, id, field }, value),
    open: (table: string, id: string, field: string, sealed: Buffer) => {
      const secret = vault.decrypt({ table, id, field }, sealed)
      try {
        return secret.revealString()
      } finally {
        secret.dispose()
      }
    }
  }
  let clock = 1_000
  const endpoints = new DockerTcpEndpoints(createModuleDb('docker', db), secrets, () => ++clock)
  return { db, endpoints }
}

const FULL = {
  name: 'legacy-server',
  host: 'docker.internal',
  port: 2376,
  ca: pem('ca.pem'),
  cert: pem('client.pem'),
  key: pem('client-key.pem')
}

describe('DockerTcpEndpoints — engine TCP + TLS, chứng chỉ trong vault', () => {
  it('lưu: danh sách chỉ có thông tin công khai; blob trong DB không chứa PEM rõ', async () => {
    const { db, endpoints } = await setup()
    const id = endpoints.save(FULL)
    const [row] = endpoints.list()
    expect(row).toMatchObject({
      id,
      name: 'legacy-server',
      host: 'docker.internal',
      port: 2376,
      hasCa: true,
      hasCert: true,
      hasKey: true,
      certSubject: 'shellhouse-client'
    })
    expect(JSON.stringify(row)).not.toContain('BEGIN')
    const raw = db.prepare('SELECT ca_enc, cert_enc, key_enc FROM docker_tcp').get() as Record<
      string,
      Buffer
    >
    for (const blob of Object.values(raw)) {
      expect(blob.toString('latin1')).not.toContain('BEGIN')
      expect(blob.toString('latin1')).not.toContain('PRIVATE')
    }
  })

  it('resolve trả PEM đã giải mã cho Session Host', async () => {
    const { endpoints } = await setup()
    const id = endpoints.save(FULL)
    expect(endpoints.resolve(id)).toEqual({
      id,
      host: 'docker.internal',
      port: 2376,
      ca: FULL.ca,
      cert: FULL.cert,
      key: FULL.key
    })
  })

  it('chứng chỉ sai không được lưu (khoá lạ, passphrase) và không để lại bản ghi', async () => {
    const { endpoints } = await setup()
    expect(() => endpoints.save({ ...FULL, key: pem('other-key.pem') })).toThrow(/do not belong/)
    expect(() => endpoints.save({ ...FULL, key: pem('encrypted-key.pem') })).toThrow(/passphrase/)
    expect(endpoints.list()).toEqual([])
  })

  it('sửa: chỉ đổi tên / địa chỉ thì giữ chứng chỉ; null xoá CA; thay khoá lệch thì báo và giữ bản cũ', async () => {
    const { endpoints } = await setup()
    const id = endpoints.save(FULL)
    endpoints.save({ id, name: 'renamed', host: 'other.host', port: 2377 })
    expect(endpoints.resolve(id)).toMatchObject({ host: 'other.host', port: 2377, key: FULL.key })
    expect(endpoints.list()[0]?.name).toBe('renamed')

    expect(() =>
      endpoints.save({
        id,
        name: 'renamed',
        host: 'other.host',
        port: 2377,
        key: pem('other-key.pem')
      })
    ).toThrow(/do not belong/)
    expect(endpoints.resolve(id).key).toBe(FULL.key)

    endpoints.save({ id, name: 'renamed', host: 'other.host', port: 2377, ca: null })
    expect(endpoints.resolve(id).ca).toBeUndefined()
    expect(endpoints.list()[0]?.hasCa).toBe(false)

    // Gỡ chứng chỉ client: phải gỡ cả khoá.
    expect(() =>
      endpoints.save({ id, name: 'renamed', host: 'other.host', port: 2377, cert: null })
    ).toThrow(/both/)
    endpoints.save({ id, name: 'renamed', host: 'other.host', port: 2377, cert: null, key: null })
    expect(endpoints.list()[0]).toMatchObject({ hasCert: false, hasKey: false, certExpires: null })
  })

  it('xoá: biến khỏi danh sách, không resolve được, blob bị xoá', async () => {
    const { db, endpoints } = await setup()
    const id = endpoints.save(FULL)
    endpoints.delete(id)
    expect(endpoints.list()).toEqual([])
    expect(() => endpoints.resolve(id)).toThrow(/no longer exists/)
    const raw = db.prepare('SELECT ca_enc, cert_enc, key_enc FROM docker_tcp').get() as Record<
      string,
      Buffer | null
    >
    expect(Object.values(raw)).toEqual([null, null, null])
  })

  it('sửa một engine không còn → lỗi rõ', async () => {
    const { endpoints } = await setup()
    expect(() => endpoints.save({ ...FULL, id: 'missing' })).toThrow(/no longer exists/)
  })
})
