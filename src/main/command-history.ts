import type { Db } from './store/db'

/** Mỗi đích giữ tối đa chừng này lệnh (cũ nhất bị xoá). */
export const MAX_COMMANDS_PER_TARGET = 2000
export const MAX_COMMAND_LENGTH = 1000

/**
 * Lịch sử lệnh theo đích kết nối — nguồn cho gợi ý lệnh khi gõ. Chỉ lệnh người dùng đã gõ và
 * hiện trên màn hình (mật khẩu không hiện nên không bao giờ vào đây).
 */
export class CommandHistory {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /** Lệnh gần đây nhất trước (dùng lại nhiều lần cũng chỉ một dòng). */
  list(target: string, limit = 1000): string[] {
    const rows = this.db
      .prepare('SELECT command FROM command_history WHERE target = ? ORDER BY used_at DESC LIMIT ?')
      .all(target, limit) as { command: string }[]
    return rows.map((r) => r.command)
  }

  record(target: string, command: string): void {
    const text = command.trim()
    if (!text || text.length > MAX_COMMAND_LENGTH || /[\r\n\0]/.test(text)) return
    this.db
      .prepare(
        `INSERT INTO command_history (target, command, count, used_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (target, command) DO UPDATE SET count = count + 1, used_at = excluded.used_at`
      )
      .run(target, text, this.now())
    this.db
      .prepare(
        `DELETE FROM command_history WHERE target = ? AND command NOT IN (
           SELECT command FROM command_history WHERE target = ? ORDER BY used_at DESC LIMIT ?
         )`
      )
      .run(target, target, MAX_COMMANDS_PER_TARGET)
  }

  /** Xoá lịch sử của một đích, hoặc tất cả (target = null). */
  clear(target: string | null): void {
    if (target === null) this.db.prepare('DELETE FROM command_history').run()
    else this.db.prepare('DELETE FROM command_history WHERE target = ?').run(target)
  }
}
