import type { SnippetInput, SnippetSummary } from '@shared/snippets'
import { uuidv7 } from '../node-shared/uuid'
import type { Db } from './store/db'

export class SnippetService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  list(): SnippetSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, body, tags, updated_at FROM snippets
         WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`
      )
      .all() as { id: string; name: string; body: string; tags: string; updated_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      body: r.body,
      tags: (() => {
        try {
          return JSON.parse(r.tags) as string[]
        } catch {
          return []
        }
      })(),
      updatedAt: r.updated_at
    }))
  }

  save(input: SnippetInput): string {
    const now = this.now()
    const tags = JSON.stringify([...new Set(input.tags)])
    if (input.id) {
      const result = this.db
        .prepare(
          'UPDATE snippets SET name = ?, body = ?, tags = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
        )
        .run(input.name, input.body, tags, now, input.id)
      if (result.changes === 0) throw new Error('Snippet not found')
      return input.id
    }
    const id = uuidv7(now)
    this.db
      .prepare('INSERT INTO snippets (id, name, body, tags, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.body, tags, now)
    return id
  }

  delete(id: string): void {
    const now = this.now()
    this.db
      .prepare('UPDATE snippets SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id)
  }
}
