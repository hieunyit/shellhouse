import { describe, expect, it } from 'vitest'
import { MAX_S3_PINS } from '@shared/s3'
import { Secret } from '../../src/node-shared/secret'
import { S3Accounts } from '../../src/main/s3-accounts'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  let clock = 1_000
  const accounts = new S3Accounts(db, vault, () => ++clock)
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
