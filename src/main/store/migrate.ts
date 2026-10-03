import type { Db } from './db'
import { t } from '@shared/i18n'

export interface Migration {
  version: number
  name: string
  sql: string
}

export class NewerSchemaError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly appVersion: number
  ) {
    super(
      t(
        'The data uses schema v{db}, newer than this version of the app supports (v{app}). Update the app or restore a backup.',
        { db: dbVersion, app: appVersion }
      )
    )
    this.name = 'NewerSchemaError'
  }
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}

export interface MigrateOptions {
  /** Gọi một lần trước khi chạy migration trên DB đã có dữ liệu (version > 0). */
  backup?: (currentVersion: number) => Promise<unknown>
}

/**
 * Chạy các migration còn thiếu. Mỗi migration + việc tăng `user_version` nằm trong
 * cùng một transaction: lỗi giữa chừng thì DB giữ nguyên trạng thái trước đó.
 */
export async function migrate(
  db: Db,
  migrations: readonly Migration[],
  options: MigrateOptions = {}
): Promise<{ from: number; to: number }> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  sorted.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations are not contiguous at v${m.version}`)
  })
  const latest = sorted.at(-1)?.version ?? 0
  const from = schemaVersion(db)
  if (from > latest) throw new NewerSchemaError(from, latest)

  const pending = sorted.filter((m) => m.version > from)
  if (pending.length === 0) return { from, to: from }

  if (from > 0 && options.backup) await options.backup(from)

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
  return { from, to: latest }
}
