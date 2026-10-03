import type BetterSqlite3 from 'better-sqlite3'
import type { Secret } from '../../node-shared/secret'
import { loadNative } from '../native'
import { Vault } from '../vault/vault'
import { MIGRATIONS } from './migrations'
import { t } from '@shared/i18n'

export type BackupCheck =
  { ok: true; hosts: number; schemaVersion: number } | { ok: false; reason: string }

/**
 * Kiểm tra một file sao lưu trước khi khôi phục: mở chỉ-đọc, không hỏng, schema không mới hơn app,
 * có vault, và master password đúng với vault TRONG file đó.
 */
export async function inspectBackup(path: string, password: Secret): Promise<BackupCheck> {
  const Database = loadNative('better-sqlite3') as typeof BetterSqlite3
  let db: BetterSqlite3.Database
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
  } catch {
    return { ok: false, reason: t('Could not open the file (not a Shellhouse data file?)') }
  }
  try {
    let quick: unknown
    try {
      quick = db.pragma('quick_check', { simple: true })
    } catch {
      return { ok: false, reason: t('Not a valid SQLite database') }
    }
    if (quick !== 'ok') return { ok: false, reason: t('The backup file is corrupted') }
    const version = db.pragma('user_version', { simple: true }) as number
    const latest = MIGRATIONS.length
    if (version === 0) return { ok: false, reason: t('Not a Shellhouse data file') }
    if (version > latest) {
      return {
        ok: false,
        reason: t('Created by a newer version of Shellhouse (schema v{version})', { version })
      }
    }
    const hasVault = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_meta'")
      .get()
    if (!hasVault || !db.prepare('SELECT 1 FROM vault_meta WHERE id = 1').get()) {
      return { ok: false, reason: t('The file does not contain a vault') }
    }
    const vault = new Vault(db)
    if (!(await vault.verifyPassword(password))) {
      return { ok: false, reason: t('Wrong master password for this backup') }
    }
    const hosts = (
      db.prepare('SELECT COUNT(*) AS n FROM hosts WHERE deleted_at IS NULL').get() as { n: number }
    ).n
    return { ok: true, hosts, schemaVersion: version }
  } finally {
    db.close()
  }
}
