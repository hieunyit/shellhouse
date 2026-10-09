import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../../../main/store/db'
import { migrate } from '../../../../main/store/migrate'
import { MIGRATIONS } from '../../../../main/store/migrations'
import { createModuleDb } from '../../../registry/main-db'
import m0001 from '../../migrations/0001_runbooks.sql?raw'
import { RunbookStore } from '../../main/store'
import type { RunbookInput, RunbookStep } from '../../shared/runbook'

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  db.exec(m0001)
  let clock = 1_000
  return { db, store: new RunbookStore(createModuleDb('runbook', db), () => ++clock) }
}

const http: RunbookStep = {
  id: 's1',
  name: 'Health',
  type: 'http',
  params: { url: 'https://x/health', expectStatus: [200], contains: '' },
  timeoutSec: 10,
  continueOnFail: false
}
const input = (over: Partial<RunbookInput> = {}): RunbookInput => ({
  name: 'After deploy',
  description: 'Run after every release',
  steps: [http],
  ...over
})

describe('RunbookStore', () => {
  it('lưu rồi đọc lại đủ bước, theo tên không phân biệt hoa thường', async () => {
    const { store } = await setup()
    const id = store.save(input())
    store.save(input({ name: 'before maintenance', steps: [] }))
    const list = store.list()
    expect(list.map((r) => r.name)).toEqual(['After deploy', 'before maintenance'])
    expect(list[0]).toMatchObject({ id, description: 'Run after every release', steps: [http] })
  })

  it('sửa giữ id; tên trùng (khác hoa thường) bị từ chối; sửa chính nó vẫn được', async () => {
    const { store } = await setup()
    const id = store.save(input())
    store.save(input({ id, description: 'changed' }))
    expect(store.list()[0]?.description).toBe('changed')
    store.save(input({ name: 'Other' }))
    expect(() => store.save(input({ name: 'after DEPLOY' }))).toThrow(/already exists/)
    expect(() => store.save(input({ id: 'missing', name: 'Zed' }))).toThrow(/no longer exists/)
  })

  it('xoá: biến khỏi danh sách và bỏ bước; có thể dùng lại tên', async () => {
    const { db, store } = await setup()
    const id = store.save(input())
    store.remove(id)
    expect(store.list()).toEqual([])
    const row = db.prepare('SELECT steps FROM runbook_runbooks WHERE id = ?').get(id) as {
      steps: string
    }
    expect(row.steps).toBe('[]')
    expect(() => store.save(input())).not.toThrow()
  })

  it('bước hỏng định dạng trong DB không làm sập danh sách', async () => {
    const { db, store } = await setup()
    const id = store.save(input())
    db.prepare('UPDATE runbook_runbooks SET steps = ? WHERE id = ?').run('{not json', id)
    expect(store.list()[0]).toMatchObject({ id, steps: [] })
  })
})
