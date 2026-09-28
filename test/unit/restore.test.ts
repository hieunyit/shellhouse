import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Secret } from '../../src/node-shared/secret'
import { backupDatabase } from '../../src/main/store/backup'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { inspectBackup } from '../../src/main/store/restore'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'
import { tempDir } from './helpers'

const pw = (s: string): Secret => Secret.fromString(s)

async function makeBackup(dir: string): Promise<string> {
  const db = openDatabase(join(dir, 'live.db'))
  await migrate(db, MIGRATIONS)
  await new Vault(db, TEST_KDF).create(pw('backup-password'))
  db.prepare(
    "INSERT INTO hosts (id, label, hostname, updated_at) VALUES ('h1', 'a', 'a.example', 0)"
  ).run()
  const path = await backupDatabase(db, dir, 'export')
  db.close()
  return path
}

describe('inspectBackup', () => {
  it('file hợp lệ + đúng password → ok, đếm host', async () => {
    const dir = tempDir()
    const path = await makeBackup(dir)
    expect(await inspectBackup(path, pw('backup-password'))).toEqual({
      ok: true,
      hosts: 1,
      schemaVersion: MIGRATIONS.length
    })
  })

  it('sai password của bản sao lưu', async () => {
    const path = await makeBackup(tempDir())
    expect(await inspectBackup(path, pw('khac-hoan-toan'))).toEqual({
      ok: false,
      reason: 'Wrong master password for this backup'
    })
  })

  it('file rác, file không tồn tại, SQLite không phải của app, schema mới hơn', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'junk.db'), 'không phải sqlite')
    expect((await inspectBackup(join(dir, 'junk.db'), pw('x'))).ok).toBe(false)
    expect((await inspectBackup(join(dir, 'missing.db'), pw('x'))).ok).toBe(false)

    const other = openDatabase(join(dir, 'other.db'))
    other.exec('CREATE TABLE t (x)')
    other.close()
    expect(await inspectBackup(join(dir, 'other.db'), pw('x'))).toMatchObject({
      ok: false,
      reason: 'Not a Shellhouse data file'
    })

    const path = await makeBackup(tempDir())
    const future = openDatabase(path)
    future.pragma('user_version = 99')
    future.close()
    expect(await inspectBackup(path, pw('backup-password'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('newer version') as string
    })
  })
})
