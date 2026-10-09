import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  backupDatabase,
  dailyBackupIfDue,
  listBackups,
  restoreBackup,
  rotateBackups
} from '../../src/main/store/backup'
import { openDatabase, quickCheck } from '../../src/main/store/db'
import { CorruptDatabaseError, openStore, storePaths } from '../../src/main/store'
import {
  migrate,
  NewerSchemaError,
  schemaVersion,
  type Migration
} from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { tempDir } from './helpers'

const v1: Migration = { version: 1, name: 'a', sql: 'CREATE TABLE a (x INTEGER);' }
const v2: Migration = { version: 2, name: 'b', sql: 'CREATE TABLE b (y INTEGER);' }

describe('migrate', () => {
  it('chạy migration còn thiếu và cập nhật user_version', async () => {
    const db = openDatabase(':memory:')
    expect(await migrate(db, [v1])).toEqual({ from: 0, to: 1 })
    expect(await migrate(db, [v1, v2])).toEqual({ from: 1, to: 2 })
    expect(await migrate(db, [v1, v2])).toEqual({ from: 2, to: 2 })
    expect(schemaVersion(db)).toBe(2)
  })

  it('migration lỗi → rollback toàn bộ, version giữ nguyên', async () => {
    const db = openDatabase(':memory:')
    await migrate(db, [v1])
    const broken: Migration = { version: 2, name: 'x', sql: 'CREATE TABLE c (z); INVALID SQL;' }
    await expect(migrate(db, [v1, broken])).rejects.toThrow()
    expect(schemaVersion(db)).toBe(1)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toBeUndefined()
  })

  it('sao lưu trước khi migrate DB đã có dữ liệu, không sao lưu DB mới', async () => {
    const db = openDatabase(':memory:')
    const calls: number[] = []
    const backup = (v: number): Promise<void> => {
      calls.push(v)
      return Promise.resolve()
    }
    await migrate(db, [v1], { backup })
    await migrate(db, [v1, v2], { backup })
    expect(calls).toEqual([1])
  })

  it('DB mới hơn app (người dùng hạ phiên bản) → NewerSchemaError', async () => {
    const db = openDatabase(':memory:')
    await migrate(db, [v1, v2])
    await expect(migrate(db, [v1])).rejects.toBeInstanceOf(NewerSchemaError)
  })

  it('từ chối danh sách migration không liên tục', async () => {
    await expect(migrate(openDatabase(':memory:'), [v2])).rejects.toThrow(/not contiguous/)
  })

  it('schema thật: bật foreign key và ràng buộc hoạt động', async () => {
    const db = openDatabase(':memory:')
    await migrate(db, MIGRATIONS)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() =>
      db
        .prepare(
          "INSERT INTO hosts (id, label, hostname, identity_id, updated_at) VALUES ('h', 'l', 'x', 'missing', 0)"
        )
        .run()
    ).toThrow(/FOREIGN KEY/)
    expect(() =>
      db
        .prepare(
          "INSERT INTO hosts (id, label, hostname, port, updated_at) VALUES ('h', 'l', 'x', 70000, 0)"
        )
        .run()
    ).toThrow(/CHECK/)
  })
})

describe('backup', () => {
  it('sao lưu online, đọc lại được', async () => {
    const dir = tempDir()
    const db = openDatabase(join(dir, 'x.db'))
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('hi')")
    const path = await backupDatabase(db, join(dir, 'b'), 'manual')
    const copy = openDatabase(path)
    expect(copy.prepare('SELECT v FROM t').get()).toEqual({ v: 'hi' })
    copy.close()
    db.close()
  })

  it('xoay vòng: giữ N bản mới nhất mỗi loại', async () => {
    const dir = tempDir()
    const db = openDatabase(':memory:')
    const backups = join(dir, 'b')
    for (let i = 0; i < 4; i++) {
      const when = Date.UTC(2026, 0, i + 1)
      const p = await backupDatabase(db, backups, 'daily', when)
      utimesSync(p, new Date(when), new Date(when))
    }
    await backupDatabase(db, backups, 'pre-migrate-v1', Date.UTC(2025, 0, 1))
    rotateBackups(backups, 2)
    const left = listBackups(backups)
    expect(left.filter((b) => b.kind === 'daily')).toHaveLength(2)
    expect(left.filter((b) => b.kind === 'pre-migrate-v1')).toHaveLength(1)
  })

  it('sao lưu hằng ngày chỉ khi bản gần nhất quá 24 giờ', async () => {
    const dir = tempDir()
    const db = openDatabase(':memory:')
    const now = Date.now()
    expect(await dailyBackupIfDue(db, dir, 7, now)).not.toBeNull()
    expect(await dailyBackupIfDue(db, dir, 7, now + 60_000)).toBeNull()
  })
})

describe('openStore', () => {
  it('tạo DB mới, migrate, tạo bản sao lưu hằng ngày', async () => {
    const paths = storePaths(tempDir())
    const db = await openStore(paths)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(quickCheck(db)).toBe(true)
    expect(listBackups(paths.backups).map((b) => b.kind)).toEqual(['daily'])
    db.close()
  })

  it('file hỏng → CorruptDatabaseError kèm bản sao lưu; khôi phục được', async () => {
    const paths = storePaths(tempDir())
    const db = await openStore(paths)
    db.exec("INSERT INTO settings (key, value) VALUES ('k', 'v')")
    await backupDatabase(db, paths.backups, 'manual')
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()

    // Ghi rác đè lên các trang dữ liệu.
    const bytes = readFileSync(paths.db)
    bytes.fill(0xab, 4096, bytes.length)
    writeFileSync(paths.db, bytes)

    const error = await openStore(paths).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CorruptDatabaseError)
    const manual = (error as CorruptDatabaseError).backups.find((b) => b.kind === 'manual')
    expect(manual).toBeDefined()

    restoreBackup(manual?.path ?? '', paths.db)
    const restored = await openStore(paths)
    expect(restored.prepare("SELECT value FROM settings WHERE key = 'k'").get()).toEqual({
      value: 'v'
    })
    restored.close()
  })

  it('khôi phục lỗi giữa chừng (file sao lưu không đọc được) không đụng DB hiện tại', async () => {
    const paths = storePaths(tempDir())
    const db = await openStore(paths)
    db.exec("INSERT INTO settings (key, value) VALUES ('k', 'giữ')")
    db.close()
    const before = readFileSync(paths.db)
    expect(() => {
      restoreBackup(join(tempDir(), 'không-có.db'), paths.db)
    }).toThrow()
    expect(readFileSync(paths.db).equals(before)).toBe(true)
    expect(readdirSync(dirname(paths.db)).some((f) => f.includes('.restore-'))).toBe(false)
  })

  it('không cất được DB cũ → dừng trước khi xoá WAL (giao dịch chưa checkpoint không mất)', () => {
    const dir = tempDir()
    const backup = join(dir, 'backup.db')
    writeFileSync(backup, 'backup')
    // DB "không chép được" (thư mục) — giả lập lỗi đĩa ở bước cất bản cũ.
    const dbPath = join(dir, 'shellhouse.db')
    mkdirSync(dbPath)
    writeFileSync(`${dbPath}-wal`, 'giao dịch chưa checkpoint')
    expect(() => {
      restoreBackup(backup, dbPath)
    }).toThrow()
    expect(readFileSync(`${dbPath}-wal`, 'utf8')).toBe('giao dịch chưa checkpoint')
  })

  it('bản DB cũ được cất kèm WAL', () => {
    const dir = tempDir()
    const backup = join(dir, 'backup.db')
    writeFileSync(backup, 'backup')
    const dbPath = join(dir, 'shellhouse.db')
    writeFileSync(dbPath, 'cũ')
    writeFileSync(`${dbPath}-wal`, 'wal cũ')
    restoreBackup(backup, dbPath)
    expect(readFileSync(dbPath, 'utf8')).toBe('backup')
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    const files = readdirSync(dir)
    const kept = files.find((f) => f.includes('.corrupt-') && !f.endsWith('-wal'))
    expect(kept).toBeDefined()
    expect(readFileSync(join(dir, `${kept ?? ''}-wal`), 'utf8')).toBe('wal cũ')
  })
})
