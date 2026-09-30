import type { Db } from '../../main/store/db'
import type { ModuleDb, ModuleMigration } from './main-types'
import { tablePrefix } from './types'

/**
 * DB của module (ADR-014 mục 3.3): mỗi module chỉ đụng bảng có tiền tố `<id>_`. Kiểm bằng cách đọc
 * tên bảng sau các từ khoá SQL — đủ để bắt nhầm lẫn trong code chính thức (không phải sandbox cho
 * code lạ; việc đó cần ADR riêng).
 */

export class ModuleSqlError extends Error {
  constructor(moduleId: string, detail: string) {
    super(`Module ${moduleId}: ${detail}`)
    this.name = 'ModuleSqlError'
  }
}

const SQL_WORDS = new Set(['select', 'set', 'conflict', 'values', 'json_each'])

const FORBIDDEN = /\b(attach|detach|pragma|vacuum|reindex|sqlite_\w+|load_extension)\b/i

/** Bỏ chuỗi, comment để không đọc nhầm tên bảng trong dữ liệu. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

/** Tên bảng / index mà câu SQL nhắc tới. */
export function referencedTables(sql: string): string[] {
  const text = stripLiterals(sql)
  const names: string[] = []
  const ident = String.raw`(?:"([^"]+)"|\x60([^\x60]+)\x60|\[([^\]]+)\]|([A-Za-z_][\w$]*))`
  const patterns = [
    String.raw`\b(?:table|index|view|trigger)\s+(?:if\s+(?:not\s+)?exists\s+)?${ident}`,
    String.raw`\b(?:from|join|into|update|references)\s+${ident}`,
    String.raw`\bon\s+${ident}\s*\(`
  ]
  for (const p of patterns) {
    for (const m of text.matchAll(new RegExp(p, 'gi'))) {
      const name = m[1] ?? m[2] ?? m[3] ?? m[4]
      if (name) names.push(name)
    }
  }
  return names
}

export function checkModuleSql(moduleId: string, sql: string): void {
  const text = stripLiterals(sql)
  if (FORBIDDEN.test(text)) throw new ModuleSqlError(moduleId, 'this SQL statement is not allowed')
  const prefix = tablePrefix(moduleId)
  // Mọi tên đứng sau FROM / JOIN / INTO… phải là bảng của module (trừ từ khoá: "FROM (SELECT",
  // "ON CONFLICT(", "DO UPDATE SET").
  const foreign = referencedTables(sql).filter(
    (t) => !t.toLowerCase().startsWith(prefix) && !SQL_WORDS.has(t.toLowerCase())
  )
  if (foreign.length > 0)
    throw new ModuleSqlError(
      moduleId,
      `tables must start with "${prefix}" (found ${[...new Set(foreign)].join(', ')})`
    )
}

export function createModuleDb(moduleId: string, db: Db): ModuleDb {
  return {
    prepare: (sql) => {
      checkModuleSql(moduleId, sql)
      const statement = db.prepare(sql)
      return {
        run: (...params) => {
          const r = statement.run(...params)
          return { changes: r.changes }
        },
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params)
      }
    },
    transaction: (fn) => db.transaction(fn)()
  }
}

/** Version cao nhất đã chạy của module (0 = chưa có gì). */
export function moduleSchemaVersion(db: Db, moduleId: string): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM module_migrations WHERE module_id = ?')
    .get(moduleId) as { v: number | null }
  return row.v ?? 0
}

/**
 * Chạy migration còn thiếu của một module. Mỗi migration một transaction; SQL phải chỉ đụng bảng
 * có tiền tố của module. Version phải liên tục từ 1.
 */
export function migrateModule(
  db: Db,
  moduleId: string,
  migrations: readonly ModuleMigration[],
  now: () => number = Date.now
): { from: number; to: number } {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  sorted.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new ModuleSqlError(moduleId, `migrations are not contiguous at v${m.version}`)
    checkModuleSql(moduleId, m.sql)
  })
  const from = moduleSchemaVersion(db, moduleId)
  const latest = sorted.at(-1)?.version ?? 0
  if (from > latest)
    throw new ModuleSqlError(
      moduleId,
      `its data uses v${from}, newer than this version of the app supports (v${latest})`
    )
  for (const m of sorted.filter((x) => x.version > from)) {
    db.transaction(() => {
      db.exec(m.sql)
      db.prepare(
        'INSERT INTO module_migrations (module_id, version, name, applied_at) VALUES (?, ?, ?, ?)'
      ).run(moduleId, m.version, m.name, now())
    })()
  }
  return { from, to: Math.max(from, latest) }
}

/** "Remove data": xoá mọi bảng của module và lịch sử migration (bật lại = bắt đầu từ đầu). */
export function removeModuleData(db: Db, moduleId: string): string[] {
  const prefix = tablePrefix(moduleId)
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'")
      .all(`${prefix.replace(/_/g, '\\_')}%`) as { name: string }[]
  ).map((r) => r.name)
  db.transaction(() => {
    for (const t of tables) db.exec(`DROP TABLE "${t.replace(/"/g, '""')}"`)
    db.prepare('DELETE FROM module_migrations WHERE module_id = ?').run(moduleId)
  })()
  return tables
}
