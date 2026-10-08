import { describe, expect, it } from 'vitest'
import type { TransferStatus } from '../../src/shared/sftp'
import {
  collapseBatches,
  sectionOf,
  summarize
} from '../../src/renderer/src/shell/transfer-batches'

const src = { id: 'sftp:1' }
let n = 0
const x = (over: Partial<TransferStatus> = {}): TransferStatus => ({
  id: `t${String(++n)}`,
  direction: 'upload',
  localPath: '/a/f',
  remotePath: '/b/f',
  size: 100,
  transferred: 100,
  resumedFrom: 0,
  state: 'done',
  error: null,
  bytesPerSecond: 0,
  ...over
})
const batch = { id: 'b1', label: 'tree' }

describe('gộp lượt truyền của một lần tải thư mục', () => {
  it('cùng nguồn + batch (≥ 2 lượt) → một mục; lượt lẻ và batch khác nguồn giữ riêng', () => {
    const items = [
      ...Array.from({ length: 300 }, () => ({ src, x: x({ batch }) })),
      { src, x: x() },
      { src: { id: 'sftp:2' }, x: x({ batch }) },
      { src, x: x({ batch: { id: 'solo', label: 'one' } }) }
    ]
    const entries = collapseBatches(items)
    expect(entries).toHaveLength(4)
    const first = entries[0]
    expect(first?.kind).toBe('batch')
    if (first?.kind === 'batch') {
      expect(first.members).toHaveLength(300)
      expect(first.label).toBe('tree')
      expect(first.summary.done).toBe(300)
    }
    expect(entries.filter((e) => e.kind === 'one')).toHaveLength(3)
  })

  it('tổng hợp: đếm trạng thái, tiến độ theo số file, tốc độ cộng dồn', () => {
    const s = summarize([
      x({ state: 'done' }),
      x({ state: 'running', transferred: 50, bytesPerSecond: 1000 }),
      x({ state: 'running', transferred: 0, bytesPerSecond: 500 }),
      x({ state: 'queued', size: 0, transferred: 0 }),
      x({ state: 'error', transferred: 100 })
    ])
    expect(s).toMatchObject({ count: 5, done: 1, running: 2, queued: 1, failed: 1 })
    expect(s.bytesPerSecond).toBe(1500)
    expect(s.ratio).toBeCloseTo((1 + 0.5 + 0 + 0 + 1) / 5)
  })

  it('nhóm hiển thị: lỗi > đang chạy > chờ > xong', () => {
    const sec = (...states: TransferStatus['state'][]) =>
      sectionOf(summarize(states.map((state) => x({ state }))))
    expect(sec('done', 'running', 'error')).toBe('failed')
    expect(sec('done', 'cancelled')).toBe('failed')
    expect(sec('done', 'running', 'queued')).toBe('active')
    expect(sec('done', 'queued')).toBe('queued')
    expect(sec('done', 'done')).toBe('done')
  })
})

describe('transferCounts', () => {
  it('lần tải thư mục (batch) chỉ tính một hàng', async () => {
    const { transferCounts } = await import('../../src/renderer/src/shell/transfers-filter')
    const mk = (id: string, state: string, batch?: string): never =>
      ({ id, state, ...(batch ? { batch: { id: batch, label: 'tree' } } : {}) }) as never
    const counts = transferCounts({
      a: {
        id: 'a',
        label: 'a',
        transfers: [
          mk('1', 'done', 'b'),
          mk('2', 'done', 'b'),
          mk('3', 'error', 'b'),
          mk('4', 'done')
        ]
      }
    } as never)
    expect(counts.all).toBe(2)
    expect(counts.done).toBe(2)
    expect(counts.failed).toBe(1)
  })
})
