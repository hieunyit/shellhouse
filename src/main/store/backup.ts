import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db'

const PREFIX = 'shellhouse-'
const DAY_MS = 24 * 60 * 60 * 1000

export interface BackupFile {
  path: string
  kind: string
  createdAt: number
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/** Sao lưu online bằng SQLite backup API (an toàn khi DB đang mở, kể cả WAL). */
export async function backupDatabase(
  db: Db,
  dir: string,
  kind: string,
  now = Date.now()
): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${PREFIX}${kind}_${stamp(now)}.db`)
  await db.backup(dest)
  return dest
}

export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
    .map((f) => {
      const path = join(dir, f)
      const kind = f.slice(PREFIX.length).split('_')[0] ?? ''
      return { path, kind, createdAt: statSync(path).mtimeMs }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Giữ `keep` bản mới nhất của mỗi loại. */
export function rotateBackups(dir: string, keep: number): void {
  const byKind = new Map<string, BackupFile[]>()
  for (const b of listBackups(dir)) byKind.set(b.kind, [...(byKind.get(b.kind) ?? []), b])
  for (const files of byKind.values()) {
    for (const old of files.slice(keep)) rmSync(old.path, { force: true })
  }
}

/** Sao lưu hằng ngày: chỉ tạo bản mới nếu bản `daily` gần nhất đã quá 24 giờ. */
export async function dailyBackupIfDue(
  db: Db,
  dir: string,
  keep = 7,
  now = Date.now()
): Promise<string | null> {
  const latest = listBackups(dir).find((b) => b.kind === 'daily')
  if (latest && now - latest.createdAt < DAY_MS) return null
  const path = await backupDatabase(db, dir, 'daily', now)
  rotateBackups(dir, keep)
  return path
}

/** Thay file DB bằng bản sao lưu. DB phải đang ĐÓNG. */
export function restoreBackup(backupPath: string, dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  if (existsSync(dbPath)) copyFileSync(dbPath, `${dbPath}.corrupt-${stamp(Date.now())}`)
  copyFileSync(backupPath, dbPath)
}
