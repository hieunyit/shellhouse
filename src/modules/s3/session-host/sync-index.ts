import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { _Object } from '@aws-sdk/client-s3'
import { t } from '@shared/i18n'
import { formatNumber } from '@shared/i18n/format'
import type { SyncItem, SyncObject } from '../shared/sync'

export const MAX_SYNC_OBJECTS = 100_000_000
export const SYNC_PAGE_SIZE = 1000
type Side = 'source' | 'dest'
type Row = SyncObject & {
  rel: string
  present: number | null
  destSize: number
  destEtag: string | null
}

/** Private, disposable on-disk index. Every read/write is bounded to one listing page. */
export class SyncIndex {
  readonly directory = mkdtempSync(join(tmpdir(), 'shellhouse-s3-sync-'))
  private readonly db: DatabaseSync
  readonly counts = { source: 0, dest: 0 }

  constructor() {
    let opened: DatabaseSync | undefined
    try {
      this.db = opened = new DatabaseSync(join(this.directory, 'index.sqlite'))
      this.db.exec(`
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        PRAGMA cache_size = -8192;
        PRAGMA temp_store = FILE;
        CREATE TABLE source (rel TEXT PRIMARY KEY, size REAL NOT NULL, etag TEXT) WITHOUT ROWID;
        CREATE TABLE dest (rel TEXT PRIMARY KEY, size REAL NOT NULL, etag TEXT) WITHOUT ROWID;
        CREATE TABLE plan (rel TEXT PRIMARY KEY, action TEXT NOT NULL, size REAL NOT NULL) WITHOUT ROWID;
      `)
    } catch (error) {
      opened?.close()
      rmSync(this.directory, { recursive: true, force: true })
      throw error
    }
  }

  add(side: Side, prefix: string, objects: readonly _Object[]): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO ${side} VALUES (?, ?, ?)`)
    let count = this.counts[side]
    this.db.exec('BEGIN')
    try {
      for (const object of objects) {
        if (!object.Key) continue
        const result = insert.run(
          object.Key.slice(prefix.length),
          object.Size ?? 0,
          object.ETag ?? null
        )
        count += Number(result.changes)
        if (count > MAX_SYNC_OBJECTS)
          throw new Error(
            t('More than {n} objects on one side — sync a smaller folder', {
              n: formatNumber(MAX_SYNC_OBJECTS)
            })
          )
      }
      this.db.exec('COMMIT')
      this.counts[side] = count
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Keyset pagination also handles an empty relative key (the prefix marker itself). */
  objects(side: Side, after: string | null): Row[] {
    const other = side === 'source' ? 'dest' : 'source'
    return this.db
      .prepare(
        `
      SELECT a.rel, a.size, a.etag, b.size AS destSize, b.etag AS destEtag,
        CASE WHEN b.rel IS NULL THEN NULL ELSE 1 END AS present
      FROM ${side} a LEFT JOIN ${other} b ON b.rel = a.rel
      ${after === null ? '' : 'WHERE a.rel > ?'} ORDER BY a.rel LIMIT ?
    `
      )
      .all(...(after === null ? [] : [after]), SYNC_PAGE_SIZE) as unknown as Row[]
  }

  addPlan(items: readonly SyncItem[]): void {
    const insert = this.db.prepare('INSERT INTO plan VALUES (?, ?, ?)')
    this.db.exec('BEGIN')
    try {
      for (const item of items) insert.run(item.rel, item.action, item.size)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  plan(after: string | null): SyncItem[] {
    return this.db
      .prepare(
        `SELECT * FROM plan ${after === null ? '' : 'WHERE rel > ?'}
      ORDER BY rel LIMIT ?`
      )
      .all(...(after === null ? [] : [after]), SYNC_PAGE_SIZE) as unknown as SyncItem[]
  }

  close(): void {
    try {
      this.db.close()
    } finally {
      rmSync(this.directory, { recursive: true, force: true })
    }
  }
}
