import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Secret } from '../../src/node-shared/secret'
import { DecryptError, open, seal, TEST_KDF } from '../../src/main/vault/crypto'
import {
  InvalidDeviceKeyError,
  parseKdfParams,
  Vault,
  VaultLockedDuringUnlockError,
  VaultLockedError,
  WrongPasswordError
} from '../../src/main/vault/vault'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { tempDir } from './helpers'

const pw = (s: string): Secret => Secret.fromString(s)

/** Một secret lưu trong bảng theo quy ước (`<x>_enc`, AD = bảng|id|cột); trả hàm đọc lại. */
function storeSecret(
  db: ReturnType<typeof openDatabase>,
  vault: Vault,
  id: string,
  value: string | null
): () => string | null {
  db.exec('CREATE TABLE IF NOT EXISTS t_secrets (id TEXT PRIMARY KEY, value_enc BLOB)')
  const ref = { table: 't_secrets', id, field: 'value_enc' }
  db.prepare('INSERT INTO t_secrets (id, value_enc) VALUES (?, ?)').run(
    id,
    value === null ? null : vault.encryptString(ref, value)
  )
  return () => {
    const row = db.prepare('SELECT value_enc FROM t_secrets WHERE id = ?').get(id) as {
      value_enc: Buffer | null
    }
    return row.value_enc ? vault.decrypt(ref, row.value_enc).revealString() : null
  }
}

async function freshVault(path = ':memory:') {
  const db = openDatabase(path)
  await migrate(db, MIGRATIONS)
  return { db, vault: new Vault(db, TEST_KDF) }
}

describe('crypto', () => {
  it('seal/open round-trip, sai AD hoặc bị sửa thì từ chối', () => {
    const key = Buffer.alloc(32, 7)
    const sealed = seal(key, Buffer.from('dữ liệu'), 'a|1|f|v1')
    expect(open(key, sealed, 'a|1|f|v1').toString()).toBe('dữ liệu')
    expect(() => open(key, sealed, 'a|2|f|v1')).toThrow(DecryptError)
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1
    expect(() => open(key, tampered, 'a|1|f|v1')).toThrow(DecryptError)
    expect(() => open(key, Buffer.alloc(5), 'x')).toThrow(DecryptError)
  })

  it('mỗi lần seal dùng nonce khác nhau', () => {
    const key = Buffer.alloc(32, 1)
    const a = seal(key, Buffer.from('x'), 'ad')
    const b = seal(key, Buffer.from('x'), 'ad')
    expect(a.equals(b)).toBe(false)
  })
})

describe('Vault', () => {
  it('vòng đời: uninitialized → unlocked → locked → unlocked', async () => {
    const { vault } = await freshVault()
    const states: string[] = []
    vault.onChange((s) => states.push(s))
    expect(vault.state()).toBe('uninitialized')
    await vault.create(pw('correct horse'))
    expect(vault.state()).toBe('unlocked')
    vault.lock()
    expect(vault.state()).toBe('locked')
    await vault.unlock(pw('correct horse'))
    expect(vault.state()).toBe('unlocked')
    expect(states).toEqual(['unlocked', 'locked', 'unlocked'])
  })

  it('từ chối password ngắn và tạo vault lần hai', async () => {
    const { vault } = await freshVault()
    await expect(vault.create(pw('short'))).rejects.toThrow(/at least/)
    await vault.create(pw('correct horse'))
    await expect(vault.create(pw('another one'))).rejects.toThrow(/already exists/)
  })

  it('sai password → WrongPasswordError, vẫn khoá', async () => {
    const { vault } = await freshVault()
    await vault.create(pw('correct horse'))
    vault.lock()
    await expect(vault.unlock(pw('wrong horse'))).rejects.toBeInstanceOf(WrongPasswordError)
    expect(vault.state()).toBe('locked')
  })

  it('không cho hai lần unlock chạy song song', async () => {
    const { vault } = await freshVault()
    await vault.create(pw('correct horse'))
    vault.lock()
    const first = vault.unlock(pw('correct horse'))
    await expect(vault.unlock(pw('correct horse'))).rejects.toThrow(/busy/)
    await first
  })

  it('mã hoá trường gắn với vị trí: tráo ciphertext giữa dòng/trường bị chặn', async () => {
    const { vault } = await freshVault()
    await vault.create(pw('correct horse'))
    const refA = { table: 'identities', id: 'a', field: 'secret_enc' }
    const refB = { table: 'identities', id: 'b', field: 'secret_enc' }
    const sealed = vault.encryptString(refA, 'p@ss')
    expect(vault.decrypt(refA, sealed).revealString()).toBe('p@ss')
    expect(() => vault.decrypt(refB, sealed)).toThrow(DecryptError)
    expect(() => vault.decrypt({ ...refA, field: 'other' }, sealed)).toThrow(DecryptError)
    expect(() => vault.encryptString({ ...refA, id: 'x|y' }, 'z')).toThrow(/Invalid/)
  })

  it('khoá rồi thì không mã hoá/giải mã được', async () => {
    const { vault } = await freshVault()
    await vault.create(pw('correct horse'))
    const ref = { table: 't', id: '1', field: 'f' }
    const sealed = vault.encryptString(ref, 'x')
    vault.lock()
    expect(() => vault.decrypt(ref, sealed)).toThrow(VaultLockedError)
    expect(() => vault.encryptString(ref, 'x')).toThrow(VaultLockedError)
  })

  it('đổi master password: dữ liệu trong CSDL vẫn đọc được, password cũ hết hiệu lực', async () => {
    const { db, vault } = await freshVault()
    await vault.create(pw('old password'))
    const read = storeSecret(db, vault, '1', 'giữ nguyên')
    await expect(
      vault.changePassword(pw('not current'), pw('new password'))
    ).rejects.toBeInstanceOf(WrongPasswordError)
    expect(await vault.changePassword(pw('old password'), pw('new password'))).toEqual({
      rotated: true
    })
    expect(read()).toBe('giữ nguyên')
    vault.lock()
    await expect(vault.unlock(pw('old password'))).rejects.toBeInstanceOf(WrongPasswordError)
    await vault.unlock(pw('new password'))
    expect(read()).toBe('giữ nguyên')
  })

  it('đổi master password xoay DEK: DEK cũ (bản sao lưu cũ + password cũ) không mở được secret hiện tại', async () => {
    const { db, vault } = await freshVault()
    await vault.create(pw('old password'))
    storeSecret(db, vault, '1', 'bí mật')
    storeSecret(db, vault, '2', null)
    const oldDek = vault.exportKey()
    await vault.changePassword(pw('old password'), pw('new password'))
    const row = db.prepare("SELECT value_enc FROM t_secrets WHERE id = '1'").get() as {
      value_enc: Buffer
    }
    expect(() => open(oldDek, row.value_enc, 't_secrets|1|value_enc|v1')).toThrow(DecryptError)
    expect(vault.exportKey().equals(oldDek)).toBe(false)
  })

  it('có secret không theo quy ước / hỏng → không xoay (không mất dữ liệu), password vẫn đổi', async () => {
    const { db, vault } = await freshVault()
    await vault.create(pw('old password'))
    const read = storeSecret(db, vault, '1', 'giữ nguyên')
    db.prepare("INSERT INTO t_secrets (id, value_enc) VALUES ('bad', ?)").run(Buffer.alloc(64, 1))
    const oldDek = vault.exportKey()
    const keys: Buffer[] = []
    expect(
      await vault.changePassword(pw('old password'), pw('new password'), (k) => keys.push(k))
    ).toEqual({ rotated: false })
    expect(keys).toEqual([])
    expect(vault.exportKey().equals(oldDek)).toBe(true)
    vault.lock()
    await vault.unlock(pw('new password'))
    expect(read()).toBe('giữ nguyên')
  })

  it('mở lại từ file: unlock được, secret không nằm plaintext trong file', async () => {
    const path = join(tempDir(), 'v.db')
    const first = await freshVault(path)
    await first.vault.create(pw('correct horse'))
    const ref = { table: 't', id: '1', field: 'f' }
    const sealed = first.vault.encryptString(ref, 'PLAINTEXT-MARKER-123')
    first.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('blob', sealed.toString('base64'))
    first.db.pragma('wal_checkpoint(TRUNCATE)')
    first.db.close()

    const onDisk = readFileSync(path)
    expect(onDisk.includes('PLAINTEXT-MARKER-123')).toBe(false)
    expect(onDisk.includes('correct horse')).toBe(false)

    const second = await freshVault(path)
    expect(second.vault.state()).toBe('locked')
    await second.vault.unlock(pw('correct horse'))
    const row = second.db.prepare('SELECT value FROM settings WHERE key = ?').get('blob') as {
      value: string
    }
    expect(second.vault.decrypt(ref, Buffer.from(row.value, 'base64')).revealString()).toBe(
      'PLAINTEXT-MARKER-123'
    )
    second.db.close()
  })
})

describe('Vault: nhớ trên máy (khoá từ keychain)', () => {
  it('mở bằng DEK đã xuất; DEK sai hoặc sai độ dài bị từ chối', async () => {
    const { vault } = await freshVault()
    await vault.create(pw('correct horse'))
    const ref = { table: 't', id: '1', field: 'f' }
    const sealed = vault.encryptString(ref, 'bí mật')
    const exported = vault.exportKey()
    vault.lock()
    expect(() => {
      vault.unlockWithKey(Buffer.alloc(32, 7))
    }).toThrow(InvalidDeviceKeyError)
    expect(() => {
      vault.unlockWithKey(Buffer.alloc(5))
    }).toThrow(InvalidDeviceKeyError)
    expect(vault.state()).toBe('locked')
    vault.unlockWithKey(exported)
    expect(vault.state()).toBe('unlocked')
    expect(vault.decrypt(ref, sealed).revealString()).toBe('bí mật')
  })

  it('đổi master password: khoá đã lưu trên máy cũ hết hiệu lực, DEK mới (onNewKey) mở được', async () => {
    const { vault } = await freshVault()
    await vault.create(pw('old password'))
    const exported = vault.exportKey()
    const fresh: Buffer[] = []
    await vault.changePassword(pw('old password'), pw('new password'), (k) => {
      fresh.push(Buffer.from(k))
    })
    vault.lock()
    expect(() => {
      vault.unlockWithKey(exported)
    }).toThrow(InvalidDeviceKeyError)
    expect(fresh).toHaveLength(1)
    vault.unlockWithKey(fresh[0] ?? Buffer.alloc(0))
    expect(vault.state()).toBe('unlocked')
  })

  it('verifyPassword không đổi trạng thái', async () => {
    const { vault } = await freshVault()
    await vault.create(pw('correct horse'))
    expect(await vault.verifyPassword(pw('correct horse'))).toBe(true)
    expect(await vault.verifyPassword(pw('sai rồi nhé'))).toBe(false)
    expect(vault.state()).toBe('unlocked')
  })

  it('vault cũ chưa có dek_check: bổ sung khi mở bằng password', async () => {
    const { db, vault } = await freshVault()
    await vault.create(pw('correct horse'))
    const exported = vault.exportKey()
    db.prepare('UPDATE vault_meta SET dek_check = NULL').run()
    vault.lock()
    expect(() => {
      vault.unlockWithKey(Buffer.from(exported))
    }).toThrow(InvalidDeviceKeyError)
    await vault.unlock(pw('correct horse'))
    vault.lock()
    vault.unlockWithKey(exported)
    expect(vault.state()).toBe('unlocked')
  })
})

describe('vault: khoá / mở chồng lên nhau', () => {
  it('lock() trong lúc Argon2 của unlock đang chạy → vault vẫn khoá', async () => {
    const { vault } = await freshVault()
    await vault.create(pw('correct horse'))
    vault.lock()
    const pending = vault.unlock(pw('correct horse'))
    vault.lock() // ví dụ máy ngủ đúng lúc đang mở khoá
    await expect(pending).rejects.toBeInstanceOf(VaultLockedDuringUnlockError)
    expect(vault.state()).toBe('locked')
    await vault.unlock(pw('correct horse'))
    expect(vault.state()).toBe('unlocked')
  })

  it('đổi master password khi đang khoá không mở vault', async () => {
    const { vault } = await freshVault()
    await vault.create(pw('old password'))
    vault.lock()
    await vault.changePassword(pw('old password'), pw('new password'))
    expect(vault.state()).toBe('locked')
    await vault.unlock(pw('new password'))
    expect(vault.state()).toBe('unlocked')
  })

  it('tham số KDF ngoài giới hạn (file sao lưu lạ) bị từ chối', () => {
    expect(parseKdfParams('{"ops":3,"mem":67108864}')).toEqual({ ops: 3, mem: 67108864 })
    for (const raw of [
      '{"ops":3,"mem":1e15}',
      '{"ops":1000000,"mem":67108864}',
      '{"ops":0,"mem":67108864}',
      '{"ops":3.5,"mem":67108864}',
      '{"ops":3}'
    ])
      expect(() => parseKdfParams(raw)).toThrow(/kdf_params/)
  })
})
