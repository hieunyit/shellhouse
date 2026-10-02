import type { TransferStatus } from './sftp'

/**
 * F6 "Move" của trình quản lý file hai cột: copy (xếp hàng truyền) rồi chỉ xoá bản gốc khi mọi
 * file của nó đã truyền xong. Hàng đợi báo trạng thái qua sự kiện → hỏi lại tới khi yên.
 */

const TERMINAL: ReadonlySet<TransferStatus['state']> = new Set(['done', 'error', 'cancelled'])

/** Đường dẫn nằm trong (hoặc chính là) gốc. */
export function isUnder(path: string, root: string, sep: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Chờ các lượt truyền mới (không có trong `before`) của từng gốc xong hết. Trả về gốc chuyển được
 * (có ít nhất một file và tất cả đã xong) và gốc phải giữ lại (lỗi / huỷ / không có gì được copy).
 */
export async function settleTransfers(options: {
  read: () => readonly TransferStatus[]
  before: ReadonlySet<string>
  roots: readonly string[]
  side: 'local' | 'remote'
  sep: string
  /** Yên chừng này (ms) không có lượt mới thì coi như đã xếp hàng đủ. */
  quietMs?: number
  pollMs?: number
}): Promise<{ moved: string[]; kept: string[] }> {
  const { read, before, roots, side, sep, quietMs = 600, pollMs = 120 } = options
  const pathOf = (t: TransferStatus): string => (side === 'local' ? t.localPath : t.remotePath)
  let seen = 0
  let quietSince = Date.now()
  for (;;) {
    const fresh = read().filter((t) => !before.has(t.id) && !t.edit)
    if (fresh.length !== seen) {
      seen = fresh.length
      quietSince = Date.now()
    }
    const busy = fresh.some((t) => !TERMINAL.has(t.state))
    if (!busy && Date.now() - quietSince >= quietMs) {
      const moved: string[] = []
      const kept: string[] = []
      for (const root of roots) {
        const mine = fresh.filter((t) => isUnder(pathOf(t), root, sep))
        if (mine.length > 0 && mine.every((t) => t.state === 'done')) moved.push(root)
        else kept.push(root)
      }
      return { moved, kept }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
