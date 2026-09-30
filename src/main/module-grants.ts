import type { Db } from './store/db'

/**
 * Cho / không cho module chạy một chương trình trên máy (ADR-014 mục 3.6). Nhớ theo (module, đường
 * dẫn); file chương trình đổi (hash khác) → hỏi lại.
 */
export class ModuleProgramGrants {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /** null = chưa quyết định (hoặc chương trình đã bị thay). */
  decision(module: string, path: string, sha256: string): boolean | null {
    const row = this.db
      .prepare('SELECT sha256, allowed FROM module_program_grants WHERE module_id = ? AND path = ?')
      .get(module, path) as { sha256: string; allowed: number } | undefined
    if (!row || row.sha256 !== sha256) return null
    return row.allowed === 1
  }

  remember(module: string, path: string, sha256: string, allowed: boolean): void {
    this.db
      .prepare(
        `INSERT INTO module_program_grants (module_id, path, sha256, allowed, decided_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(module_id, path) DO UPDATE SET sha256 = excluded.sha256,
           allowed = excluded.allowed, decided_at = excluded.decided_at`
      )
      .run(module, path, sha256, allowed ? 1 : 0, this.now())
  }

  /** Quên mọi lựa chọn của module ("Remove data"). */
  forget(module: string): void {
    this.db.prepare('DELETE FROM module_program_grants WHERE module_id = ?').run(module)
  }
}
