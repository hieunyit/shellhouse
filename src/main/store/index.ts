import { join } from 'node:path'
import {
  dailyBackupIfDue,
  backupDatabase,
  listBackups,
  rotateBackups,
  type BackupFile
} from './backup'
import { openDatabase, quickCheck, type Db } from './db'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'

export type { Db } from './db'

export class CorruptDatabaseError extends Error {
  constructor(
    readonly dbPath: string,
    readonly backups: BackupFile[]
  ) {
    super(`The data file is corrupted: ${dbPath}`)
    this.name = 'CorruptDatabaseError'
  }
}

export interface StorePaths {
  db: string
  backups: string
}

export function storePaths(userDataDir: string): StorePaths {
  return { db: join(userDataDir, 'shellhouse.db'), backups: join(userDataDir, 'backups') }
}

/** Mở DB: kiểm tra hỏng → migrate (có sao lưu trước) → sao lưu hằng ngày. */
/** Lỗi SQLite cho biết file hỏng / không phải DB (khác lỗi quyền, đĩa đầy…). */
function isCorruptionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB'
}

export async function openStore(paths: StorePaths): Promise<Db> {
  let db: Db
  try {
    // File hỏng có thể lỗi ngay lúc mở (đọc schema khi bật WAL / foreign keys) — trước cả
    // quick_check. Vẫn phải thành luồng "khôi phục từ bản sao lưu", không được làm app crash.
    db = openDatabase(paths.db)
  } catch (error) {
    if (isCorruptionError(error))
      throw new CorruptDatabaseError(paths.db, listBackups(paths.backups))
    throw error
  }
  if (!quickCheck(db)) {
    db.close()
    throw new CorruptDatabaseError(paths.db, listBackups(paths.backups))
  }
  try {
    await migrate(db, MIGRATIONS, {
      backup: async (version) => {
        await backupDatabase(db, paths.backups, `pre-migrate-v${version}`)
        rotateBackups(paths.backups, 7)
      }
    })
    await dailyBackupIfDue(db, paths.backups)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}
