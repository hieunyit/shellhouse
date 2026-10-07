import { describe, expect, it } from 'vitest'
import { MAX_S3_PINS } from '../../shared/ops'
import { Secret } from '../../../../node-shared/secret'
import { S3Accounts } from '../../main/accounts'
import { openDatabase } from '../../../../main/store/db'
import { migrate } from '../../../../main/store/migrate'
import { MIGRATIONS } from '../../../../main/store/migrations'
import { TEST_KDF } from '../../../../main/vault/crypto'
import { Vault } from '../../../../main/vault/vault'
import { createModuleDb } from '../../../registry/main-db'
import m0003 from '../../migrations/0003_network.sql?raw'

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  // Bảng từ migration lõi 0006 / 0007; migration riêng của module (v3+) chạy tay ở đây.
  db.exec(m0003)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  let clock = 1_000
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
  const accounts = new S3Accounts(createModuleDb('s3', db), secrets, () => ++clock)
  const id = accounts.save({
    name: 'AWS',
    endpoint: '',
    region: 'us-east-1',
    accessKeyId: 'AKIA',
    secretAccessKey: 'bi-mat',
    forcePathStyle: false
  })
  return { db, accounts, id }
}

describe('S3Accounts', () => {
  it('ghim / bỏ ghim bucket và thư mục; không trùng; giữ thứ tự thêm', async () => {
    const { accounts, id } = await setup()
    expect(accounts.list()[0]?.pins).toEqual([])
    accounts.setPin(id, { bucket: 'logs', prefix: '' }, true)
    accounts.setPin(id, { bucket: 'backups', prefix: 'db/2026/' }, true)
    accounts.setPin(id, { bucket: 'logs', prefix: '' }, true) // ghim lại: không trùng, xuống cuối
    expect(accounts.list()[0]?.pins).toEqual([
      { bucket: 'backups', prefix: 'db/2026/' },
      { bucket: 'logs', prefix: '' }
    ])
    accounts.setPin(id, { bucket: 'backups', prefix: 'db/2026/' }, false)
    expect(accounts.list()[0]?.pins).toEqual([{ bucket: 'logs', prefix: '' }])
    // Sửa tài khoản không làm mất mục ghim.
    accounts.save({
      id,
      name: 'AWS prod',
      endpoint: '',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      forcePathStyle: false
    })
    expect(accounts.list()[0]).toMatchObject({ name: 'AWS prod', pins: [{ bucket: 'logs' }] })
  })

  it('giới hạn số mục ghim; JSON hỏng trong DB → coi như không có', async () => {
    const { db, accounts, id } = await setup()
    for (let i = 0; i < MAX_S3_PINS; i++) accounts.setPin(id, { bucket: `b${i}`, prefix: '' }, true)
    expect(() => {
      accounts.setPin(id, { bucket: 'one-more', prefix: '' }, true)
    }).toThrow(/up to/)
    db.prepare("UPDATE s3_accounts SET pins = '{hong' WHERE id = ?").run(id)
    expect(accounts.list()[0]?.pins).toEqual([])
    expect(() => {
      accounts.setPin('khong-co', { bucket: 'x', prefix: '' }, true)
    }).toThrow(/no longer exists/)
  })
})
