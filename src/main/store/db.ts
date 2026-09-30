import type BetterSqlite3 from 'better-sqlite3'
import { loadNative } from '../native'

export type Db = BetterSqlite3.Database

export function openDatabase(path: string): Db {
  const Database = loadNative('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(path)
  try {
    // Mặc định SQLite TẮT foreign key; phải bật trên mỗi connection.
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 5000')
  } catch (error) {
    // File hỏng: đóng ngay — Windows không cho khôi phục (ghi đè) file đang mở.
    db.close()
    throw error
  }
  return db
}

/** `PRAGMA quick_check` — phát hiện file hỏng mà không tốn thời gian như integrity_check. */
export function quickCheck(db: Db): boolean {
  try {
    return db.pragma('quick_check', { simple: true }) === 'ok'
  } catch {
    return false
  }
}
