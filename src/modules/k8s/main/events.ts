import type { ModuleDb } from '../../registry/main-types'
import { EVENT_RETENTION_MS, type QueryEvents, type RecordedEvent } from '../shared/timeline'

/** Mỗi cluster giữ tối đa chừng này event (cluster rất ồn — bỏ bản cũ nhất). */
const MAX_PER_CLUSTER = 200_000
/** Dọn bản hết hạn / vượt mức chừng này một lần. */
const PRUNE_EVERY_MS = 10 * 60_000
/** Lô cuối nhận được trong chừng này → cluster đang được ghi. */
const RECORDING_FRESH_MS = 10 * 60_000
/** Tối đa số event trả cho một lần xem Timeline. */
const MAX_QUERY = 5_000

interface Row {
  uid: string
  namespace: string
  kind: string
  name: string
  reason: string
  type: string
  message: string
  count: number
  first_ts: number
  last_ts: number
}

/**
 * Event của cluster đang theo dõi (Session Host gửi theo lô) — giữ 7 ngày cho tab Timeline. Cùng
 * uid: cập nhật số lần / thời điểm cuối / thông báo.
 */
export class EventStore {
  private readonly lastBatch = new Map<string, number>()
  private lastPrune = 0

  constructor(
    private readonly db: ModuleDb,
    private readonly now: () => number = Date.now
  ) {
    this.prune()
  }

  record(cluster: string, events: readonly RecordedEvent[]): void {
    const now = this.now()
    this.lastBatch.set(cluster, now)
    if (events.length) {
      const upsert = this.db.prepare(
        `INSERT INTO k8s_events (cluster, uid, namespace, kind, name, reason, type, message, count, first_ts, last_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cluster, uid) DO UPDATE SET
           count = MAX(count, excluded.count),
           message = excluded.message,
           reason = excluded.reason,
           type = excluded.type,
           first_ts = MIN(first_ts, excluded.first_ts),
           last_ts = MAX(last_ts, excluded.last_ts)`
      )
      const oldest = now - EVENT_RETENTION_MS
      this.db.transaction(() => {
        for (const e of events) {
          if (e.last < oldest) continue
          upsert.run(
            cluster,
            e.uid,
            e.namespace,
            e.kind,
            e.name,
            e.reason,
            e.type,
            e.message,
            e.count,
            e.first,
            e.last
          )
        }
      })
    }
    if (now - this.lastPrune > PRUNE_EVERY_MS) this.prune()
  }

  /** Cluster có đang được ghi không (lô / nhịp báo gần đây). */
  recording(cluster: string): boolean {
    const at = this.lastBatch.get(cluster)
    return at !== undefined && this.now() - at < RECORDING_FRESH_MS
  }

  query(q: QueryEvents): { events: RecordedEvent[]; recording: boolean } {
    const since = Math.max(q.since, this.now() - EVENT_RETENTION_MS)
    const clauses: string[] = []
    const params: unknown[] = [q.cluster, since]
    const names = [...new Set(q.names)]
    if (names.length) {
      clauses.push(`(namespace = ? AND name IN (${names.map(() => '?').join(',')}))`)
      params.push(q.namespace, ...names)
    }
    for (const p of q.prefixes) {
      clauses.push(`(namespace = ? AND name LIKE ? ESCAPE '\\')`)
      params.push(q.namespace, `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    const nodes = [...new Set(q.nodes)]
    if (nodes.length) {
      clauses.push(`(kind = 'Node' AND name IN (${nodes.map(() => '?').join(',')}))`)
      params.push(...nodes)
    }
    const rows = clauses.length
      ? (this.db
          .prepare(
            `SELECT uid, namespace, kind, name, reason, type, message, count, first_ts, last_ts
             FROM k8s_events WHERE cluster = ? AND last_ts >= ? AND (${clauses.join(' OR ')})
             ORDER BY last_ts DESC LIMIT ${String(MAX_QUERY)}`
          )
          .all(...params) as Row[])
      : []
    return {
      events: rows.map((r) => ({
        uid: r.uid,
        namespace: r.namespace,
        kind: r.kind,
        name: r.name,
        reason: r.reason,
        type: r.type,
        message: r.message,
        count: r.count,
        first: r.first_ts,
        last: r.last_ts
      })),
      recording: this.recording(q.cluster)
    }
  }

  /** Xoá event của một context (người dùng xoá context). */
  forget(cluster: string): void {
    this.db.prepare('DELETE FROM k8s_events WHERE cluster = ?').run(cluster)
    this.lastBatch.delete(cluster)
  }

  /** Bỏ event quá 7 ngày; cluster vượt mức → bỏ bản cũ nhất. */
  prune(): void {
    const now = this.now()
    this.lastPrune = now
    this.db.prepare('DELETE FROM k8s_events WHERE last_ts < ?').run(now - EVENT_RETENTION_MS)
    const big = this.db
      .prepare('SELECT cluster, COUNT(*) AS n FROM k8s_events GROUP BY cluster HAVING n > ?')
      .all(MAX_PER_CLUSTER) as { cluster: string; n: number }[]
    for (const b of big)
      this.db
        .prepare(
          `DELETE FROM k8s_events WHERE cluster = ? AND uid IN (
             SELECT uid FROM k8s_events WHERE cluster = ? ORDER BY last_ts ASC LIMIT ?)`
        )
        .run(b.cluster, b.cluster, b.n - MAX_PER_CLUSTER)
  }
}
