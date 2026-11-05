import type { ModuleDb } from '../../registry/main-types'
import { MAX_S3_TASK_HISTORY, S3FinishedTask, type S3TaskRecord } from '../shared/task-history'

export class S3TaskHistory {
  constructor(private readonly db: ModuleDb) {}

  list(): S3TaskRecord[] {
    const rows = this.db
      .prepare('SELECT record FROM s3_task_history ORDER BY finished_at DESC, id DESC LIMIT ?')
      .all(MAX_S3_TASK_HISTORY) as { record: string }[]
    return rows.flatMap(({ record }) => {
      try {
        const result = S3FinishedTask.safeParse(JSON.parse(record))
        return result.success ? [result.data] : []
      } catch {
        return []
      }
    })
  }

  save(record: S3TaskRecord): void {
    const task = S3FinishedTask.parse(record)
    this.db
      .prepare(
        `INSERT INTO s3_task_history (id, record, finished_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record, finished_at = excluded.finished_at`
      )
      .run(task.id, JSON.stringify(task), task.finishedAt)
    this.db
      .prepare(
        `DELETE FROM s3_task_history WHERE id IN
      (SELECT id FROM s3_task_history ORDER BY finished_at DESC, id DESC LIMIT -1 OFFSET ?)`
      )
      .run(MAX_S3_TASK_HISTORY)
  }

  remove(ids: readonly string[]): void {
    if (!ids.length) return
    this.db
      .prepare(`DELETE FROM s3_task_history WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids)
  }
}
