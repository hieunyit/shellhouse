import { z } from 'zod'
import { t } from '@shared/i18n'
import { uuidv7 } from '../../../node-shared/uuid'
import type { ModuleDb } from '../../registry/main-types'
import { RunbookStep, type Runbook, type RunbookInput } from '../shared/runbook'

interface Row {
  id: string
  name: string
  description: string
  steps: string
  updated_at: number
}

const Steps = z.array(RunbookStep)

/** Số runbook tối đa (chặn dữ liệu phình vô hạn, không phải giới hạn thực tế của người dùng). */
const MAX_RUNBOOKS = 500

export class RunbookStore {
  constructor(
    private readonly db: ModuleDb,
    private readonly now: () => number = Date.now
  ) {}

  list(): Runbook[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, steps, updated_at FROM runbook_runbooks
         WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`
      )
      .all() as Row[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      steps: parseSteps(r.steps),
      updatedAt: r.updated_at
    }))
  }

  /** Thêm / sửa; trả id. Tên không trùng (không phân biệt hoa thường). */
  save(input: RunbookInput): string {
    const existing = this.list()
    if (!input.id && existing.length >= MAX_RUNBOOKS)
      throw new Error(t('Too many runbooks — delete some first'))
    const clash = existing.find(
      (r) => r.id !== input.id && r.name.toLowerCase() === input.name.toLowerCase()
    )
    if (clash) throw new Error(t('A runbook named “{name}” already exists', { name: clash.name }))
    const steps = JSON.stringify(input.steps)
    const now = this.now()
    if (input.id) {
      const r = this.db
        .prepare(
          `UPDATE runbook_runbooks SET name = ?, description = ?, steps = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`
        )
        .run(input.name, input.description, steps, now, input.id)
      if (r.changes === 0) throw new Error(t('The runbook no longer exists'))
      return input.id
    }
    const id = uuidv7(now)
    this.db
      .prepare(
        `INSERT INTO runbook_runbooks (id, name, description, steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.description, steps, now, now)
    return id
  }

  remove(id: string): void {
    this.db
      .prepare('UPDATE runbook_runbooks SET deleted_at = ?, steps = ? WHERE id = ?')
      .run(this.now(), '[]', id)
  }
}

/** Bước hỏng định dạng (sửa tay DB / phiên bản cũ) → bỏ cả danh sách thay vì làm sập module. */
function parseSteps(json: string): Runbook['steps'] {
  try {
    const parsed = Steps.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}
