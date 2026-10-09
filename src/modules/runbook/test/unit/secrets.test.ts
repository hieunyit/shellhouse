import { describe, expect, it } from 'vitest'
import { Secret } from '../../../../node-shared/secret'
import { TEST_KDF } from '../../../../main/vault/crypto'
import { Vault } from '../../../../main/vault/vault'
import { openDatabase } from '../../../../main/store/db'
import { migrate } from '../../../../main/store/migrate'
import { MIGRATIONS } from '../../../../main/store/migrations'
import { createModuleDb } from '../../../registry/main-db'
import m0001 from '../../migrations/0001_runbooks.sql?raw'
import m0002 from '../../migrations/0002_secrets.sql?raw'
import { RunbookSecrets, secretIdsOf } from '../../main/secrets'
import { RunbookStore } from '../../main/store'
import type { RunbookStep } from '../../shared/runbook'

const DAY = 24 * 60 * 60 * 1000

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  db.exec(m0001)
  db.exec(m0002)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  const sealer = {
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
  const clock = { now: 1_000_000 }
  const mdb = createModuleDb('runbook', db)
  return {
    db,
    clock,
    secrets: new RunbookSecrets(mdb, sealer, () => clock.now),
    store: new RunbookStore(mdb, () => clock.now)
  }
}

const httpStep = (secretId: string): RunbookStep => ({
  id: 's1',
  name: '',
  type: 'http',
  params: {
    url: 'https://x/health',
    expectStatus: [200],
    contains: '',
    headers: [{ name: 'Authorization', value: '', secret: true, secretId }]
  },
  timeoutSec: 10,
  continueOnFail: false
})

describe('RunbookSecrets', () => {
  it('lưu mã hoá (không có bản rõ trong DB), giải mã đúng id được hỏi', async () => {
    const { db, secrets } = await setup()
    const id = secrets.put('Bearer s3cr3t-value')
    const raw = db.prepare('SELECT value_enc FROM runbook_secrets WHERE id = ?').get(id) as {
      value_enc: Buffer
    }
    expect(raw.value_enc.toString('latin1')).not.toContain('s3cr3t')
    expect(secrets.resolve([id, 'missing', id])).toEqual({ [id]: 'Bearer s3cr3t-value' })
  })

  it('dọn bí mật không runbook nào dùng — trừ bí mật mới tạo (đang soạn dở)', async () => {
    const { clock, secrets, store } = await setup()
    const used = secrets.put('a')
    const orphan = secrets.put('b')
    store.save({ name: 'R', description: '', steps: [httpStep(used)] })
    // Còn mới: chưa dọn.
    expect(secrets.prune(store.list())).toBe(0)
    clock.now += 2 * DAY
    const fresh = secrets.put('c')
    expect(secrets.prune(store.list())).toBe(1)
    expect(Object.keys(secrets.resolve([used, orphan, fresh])).sort()).toEqual([used, fresh].sort())
    // Runbook bị xoá → bí mật của nó cũng được dọn.
    const id = store.list()[0]?.id ?? ''
    store.remove(id)
    expect(secrets.prune(store.list())).toBe(1)
  })

  it('secretIdsOf tìm mọi secretId trong tham số bước', () => {
    expect(secretIdsOf([httpStep('x'), { params: { a: [{ secretId: 'y' }] } }])).toEqual(['x', 'y'])
  })
})
