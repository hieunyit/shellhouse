import { describe, expect, it } from 'vitest'
import {
  buildGroupTree,
  countHostsRecursive,
  groupMoveProblem,
  MAX_GROUP_DEPTH,
  type GroupNode
} from '../../src/shared/group-tree'

const g = (id: string, parentId: string | null, name = id, sort = 0): GroupNode => ({
  id,
  parentId,
  name,
  sort
})

// Công ty
// ├── Prod
// │   ├── DB
// │   └── Web
// └── Staging
// Lab
const GROUPS = [
  g('lab', null, 'Lab'),
  g('co', null, 'Company'),
  g('web', 'prod', 'Web'),
  g('prod', 'co', 'Prod'),
  g('db', 'prod', 'DB'),
  g('stg', 'co', 'Staging')
]

describe('buildGroupTree', () => {
  const tree = buildGroupTree(GROUPS)

  it('sắp theo tên (tự nhiên), duyệt theo thứ tự hiển thị', () => {
    expect(tree.flatten().map((x) => `${'  '.repeat(x.depth - 1)}${x.group.name}`)).toEqual([
      'Company',
      '  Prod',
      '    DB',
      '    Web',
      '  Staging',
      'Lab'
    ])
    const numbered = buildGroupTree([g('a', null, 'node10'), g('b', null, 'node2')])
    expect(numbered.children(null).map((x) => x.name)).toEqual(['node2', 'node10'])
  })

  it('path / depth / descendants / height', () => {
    expect(tree.path('db')).toEqual(['Company', 'Prod', 'DB'])
    expect(tree.depth('db')).toBe(3)
    expect(tree.depth('co')).toBe(1)
    expect([...tree.descendants('co')].sort()).toEqual(['db', 'prod', 'stg', 'web'])
    expect(tree.height('co')).toBe(3)
    expect(tree.height('db')).toBe(1)
    expect(tree.path('missing')).toEqual([])
  })

  it('dữ liệu hỏng (cha không tồn tại, vòng lặp) không làm treo hay mất nhóm', () => {
    const broken = buildGroupTree([g('orphan', 'gone'), g('x', 'y'), g('y', 'x')])
    expect(broken.children(null).map((x) => x.id)).toEqual(['orphan'])
    expect(broken.path('x').length).toBeLessThanOrEqual(2)
    expect(broken.descendants('x').size).toBeLessThanOrEqual(2)
  })
})

describe('groupMoveProblem', () => {
  const tree = buildGroupTree(GROUPS)

  it('cho phép di chuyển hợp lệ', () => {
    expect(groupMoveProblem(tree, 'stg', 'prod')).toBeNull()
    expect(groupMoveProblem(tree, 'prod', null)).toBeNull()
    expect(groupMoveProblem(tree, null, 'db')).toBeNull() // nhóm mới
  })

  it('chặn vòng lặp: vào chính nó hoặc nhóm con cháu', () => {
    expect(groupMoveProblem(tree, 'co', 'co')).toMatch(/itself/)
    expect(groupMoveProblem(tree, 'co', 'db')).toMatch(/itself/)
  })

  it('chặn vượt quá độ sâu tối đa (tính cả cây con đem theo)', () => {
    const chain = Array.from({ length: MAX_GROUP_DEPTH }, (_, i) =>
      g(`c${i}`, i === 0 ? null : `c${i - 1}`)
    )
    const deep = buildGroupTree([...chain, ...GROUPS])
    const last = `c${MAX_GROUP_DEPTH - 1}`
    expect(groupMoveProblem(deep, null, last)).toMatch(/at most/)
    expect(groupMoveProblem(deep, null, `c${MAX_GROUP_DEPTH - 2}`)).toBeNull()
    // "Company" cao 3 cấp → chỉ vào được nhóm có độ sâu ≤ MAX - 3 (c{i} có độ sâu i + 1).
    expect(groupMoveProblem(deep, 'co', `c${MAX_GROUP_DEPTH - 4}`)).toBeNull()
    expect(groupMoveProblem(deep, 'co', `c${MAX_GROUP_DEPTH - 3}`)).toMatch(/at most/)
  })

  it('nhóm cha không còn tồn tại', () => {
    expect(groupMoveProblem(tree, 'stg', 'nope')).toMatch(/no longer exists/)
  })
})

it('countHostsRecursive: đếm cả nhóm con cháu', () => {
  const tree = buildGroupTree(GROUPS)
  const counts = countHostsRecursive(tree, [
    { groupId: 'db' },
    { groupId: 'db' },
    { groupId: 'web' },
    { groupId: 'stg' },
    { groupId: 'co' },
    { groupId: null }
  ])
  expect(counts.get('db')).toBe(2)
  expect(counts.get('prod')).toBe(3)
  expect(counts.get('co')).toBe(5)
  expect(counts.get('lab')).toBe(0)
})
