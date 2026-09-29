import { describe, expect, it } from 'vitest'
import { layoutToItems, pruneItems, type GridNode, type WorkspaceTarget } from '@shared/workspaces'

const leaf = (...views: string[]): GridNode => ({ type: 'leaf', data: { views } })
const branch = (...children: GridNode[]): GridNode => ({ type: 'branch', data: children })
const describePanel = (id: string): { target: WorkspaceTarget; title: string } => ({
  target: { kind: 'host', hostId: id },
  title: id
})
const summary = (root: GridNode, o: 'HORIZONTAL' | 'VERTICAL' = 'HORIZONTAL') =>
  layoutToItems(root, o, describePanel).map(
    (i) => `${i.title}:${i.after === null ? '-' : String(i.after)}:${i.direction}`
  )

describe('layoutToItems', () => {
  it('một nhóm nhiều tab → các tab cùng nhóm', () => {
    expect(summary(leaf('a', 'b', 'c'))).toEqual(['a:-:within', 'b:0:within', 'c:0:within'])
  })

  it('cột bên trái có hai ô, bên phải một ô: C chia phải so với A TRƯỚC khi B chia dưới A', () => {
    // [ [A / B] | C ]
    expect(summary(branch(branch(leaf('a'), leaf('b')), leaf('c')))).toEqual([
      'a:-:within',
      'c:0:right',
      'b:0:below'
    ])
  })

  it('lưới 2×2 (hàng trên / hàng dưới) và tab phụ trong ô', () => {
    // root dọc: [ [A | B] / [C, C2 | D] ]
    const root = branch(branch(leaf('a'), leaf('b')), branch(leaf('c', 'c2'), leaf('d')))
    expect(summary(root, 'VERTICAL')).toEqual([
      'a:-:within',
      'c:0:below',
      'b:0:right',
      'd:1:right',
      'c2:1:within'
    ])
  })

  it('pruneItems: bỏ host đã xoá, đánh lại chỉ số neo', () => {
    const items = layoutToItems(
      branch(leaf('a'), leaf('gone'), leaf('c', 'c2')),
      'HORIZONTAL',
      describePanel
    )
    const pruned = pruneItems(items, (i) => i.title !== 'gone')
    expect(
      pruned.map((i) => `${i.title}:${i.after === null ? '-' : String(i.after)}:${i.direction}`)
    ).toEqual([
      'a:-:within',
      'c:0:right', // neo vào "gone" → neo tiếp vào chỗ "gone" đã neo (a)
      'c2:1:within'
    ])
  })

  it('panel không còn (host đã xoá) bị bỏ, mục sau vẫn mở được', () => {
    const items = layoutToItems(branch(leaf('gone'), leaf('b')), 'HORIZONTAL', (id) =>
      id === 'gone' ? null : describePanel(id)
    )
    expect(items).toEqual([
      { target: { kind: 'host', hostId: 'b' }, title: 'b', after: null, direction: 'within' }
    ])
  })
})
