import { uuidv7 } from '../../../node-shared/uuid'
import type { ModuleDb, ModuleSecrets } from '../../registry/main-types'
import type { Runbook } from '../shared/runbook'

const TABLE = 'runbook_secrets'
const FIELD = 'value_enc'

/** Bí mật chưa gắn vào runbook đã lưu thì giữ chừng này rồi mới dọn (đang soạn dở). */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Giá trị bí mật của header HTTP (ADR-016): renderer gửi giá trị một lần, nhận lại id; chỉ Session
 * Host nhận lại giá trị (qua `resolveSession`). Không sửa tại chỗ — đổi giá trị là tạo id mới.
 */
export class RunbookSecrets {
  constructor(
    private readonly db: ModuleDb,
    private readonly secrets: ModuleSecrets,
    private readonly now: () => number = Date.now
  ) {}

  put(value: string): string {
    const id = uuidv7(this.now())
    this.db
      .prepare(`INSERT INTO ${TABLE} (id, value_enc, created_at) VALUES (?, ?, ?)`)
      .run(id, this.secrets.seal(TABLE, id, FIELD, value), this.now())
    return id
  }

  /** Giải mã các id được hỏi; id không còn thì bỏ qua (Session Host báo "nhập lại"). */
  resolve(ids: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {}
    const get = this.db.prepare(`SELECT value_enc FROM ${TABLE} WHERE id = ?`)
    for (const id of new Set(ids)) {
      const row = get.get(id) as { value_enc: Buffer } | undefined
      if (row) out[id] = this.secrets.open(TABLE, id, FIELD, row.value_enc)
    }
    return out
  }

  /** Xoá bí mật không runbook nào dùng (header đã đổi / xoá, runbook đã xoá) — trừ bí mật mới tạo. */
  prune(runbooks: readonly Runbook[]): number {
    const used = new Set(runbooks.flatMap((r) => secretIdsOf(r.steps)))
    const rows = this.db
      .prepare(`SELECT id FROM ${TABLE} WHERE created_at < ?`)
      .all(this.now() - ORPHAN_GRACE_MS) as { id: string }[]
    const del = this.db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`)
    let removed = 0
    for (const { id } of rows)
      if (!used.has(id)) {
        del.run(id)
        removed++
      }
    return removed
  }
}

/** Mọi `secretId` trong tham số của các bước (mọi loại bước, mọi độ sâu). */
export function secretIdsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(secretIdsOf)
  if (value !== null && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      k === 'secretId' && typeof v === 'string' ? [v] : secretIdsOf(v)
    )
  return []
}
