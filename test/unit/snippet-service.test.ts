import { describe, expect, it } from 'vitest'
import { SnippetService } from '../../src/main/snippets'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'

async function service(): Promise<SnippetService> {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  let t = 0
  return new SnippetService(db, () => ++t)
}

describe('SnippetService', () => {
  it('thêm, sửa, xoá mềm, sắp theo tên', async () => {
    const s = await service()
    const b = s.save({ name: 'b-logs', body: 'tail -f {{file}}', tags: ['log', 'log'] })
    s.save({ name: 'a-disk', body: 'df -h', tags: [] })
    expect(s.list().map((x) => x.name)).toEqual(['a-disk', 'b-logs'])
    expect(s.list()[1]?.tags).toEqual(['log'])
    s.save({ id: b, name: 'b-logs', body: 'tail -n 50 {{file}}', tags: [] })
    expect(s.list()[1]?.body).toBe('tail -n 50 {{file}}')
    s.delete(b)
    expect(s.list().map((x) => x.name)).toEqual(['a-disk'])
    expect(() => s.save({ id: b, name: 'x', body: 'y', tags: [] })).toThrow(/not found/)
  })
})
