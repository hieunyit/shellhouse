import { describe, expect, it } from 'vitest'
import { CommandHistory, MAX_COMMANDS_PER_TARGET } from '../../src/main/command-history'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  let t = 1000
  return new CommandHistory(db, () => ++t)
}

describe('CommandHistory', () => {
  it('mới nhất trước; gõ lại lệnh cũ thì lên đầu, không trùng; tách theo host', async () => {
    const h = await setup()
    h.record('web', 'ls -la')
    h.record('web', 'systemctl status nginx')
    h.record('db', 'psql')
    h.record('web', 'ls -la')
    expect(h.list('web')).toEqual(['ls -la', 'systemctl status nginx'])
    expect(h.list('db')).toEqual(['psql'])
  })

  it('bỏ lệnh rỗng, nhiều dòng, quá dài', async () => {
    const h = await setup()
    h.record('web', '   ')
    h.record('web', 'echo a\necho b')
    h.record('web', 'x'.repeat(1001))
    expect(h.list('web')).toEqual([])
  })

  it('giới hạn số lệnh mỗi host (bỏ lệnh cũ nhất)', async () => {
    const h = await setup()
    for (let i = 0; i < MAX_COMMANDS_PER_TARGET + 5; i++) h.record('web', `cmd-${i}`)
    const list = h.list('web', MAX_COMMANDS_PER_TARGET + 10)
    expect(list).toHaveLength(MAX_COMMANDS_PER_TARGET)
    expect(list[0]).toBe(`cmd-${MAX_COMMANDS_PER_TARGET + 4}`)
    expect(list).not.toContain('cmd-0')
  })

  it('xoá một host hoặc tất cả', async () => {
    const h = await setup()
    h.record('web', 'a')
    h.record('db', 'b')
    h.clear('web')
    expect(h.list('web')).toEqual([])
    expect(h.list('db')).toEqual(['b'])
    h.clear(null)
    expect(h.list('db')).toEqual([])
  })
})
