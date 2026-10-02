import { describe, expect, it } from 'vitest'
import type { TransferStatus } from '@shared/sftp'
import { isUnder, settleTransfers } from '../../src/shared/sftp-move'

const t = (id: string, localPath: string, state: TransferStatus['state']): TransferStatus => ({
  id,
  direction: 'upload',
  localPath,
  remotePath: `/srv/${id}`,
  size: 1,
  transferred: 1,
  resumedFrom: 0,
  state,
  error: null,
  bytesPerSecond: 0
})

describe('F6 move: chỉ xoá bản gốc khi copy xong', () => {
  it('isUnder theo dấu phân cách', () => {
    expect(isUnder('/a/b/c', '/a/b', '/')).toBe(true)
    expect(isUnder('/a/bc', '/a/b', '/')).toBe(false)
    expect(isUnder('C:\\x\\y', 'C:\\x', '\\')).toBe(true)
  })

  it('gốc có file lỗi / không có gì được copy → giữ lại; xong hết → chuyển', async () => {
    let list: TransferStatus[] = [t('old', '/home/u/old.txt', 'done')]
    const done = settleTransfers({
      read: () => list,
      before: new Set(['old']),
      roots: ['/home/u/a.txt', '/home/u/dir', '/home/u/skipped.txt'],
      side: 'local',
      sep: '/',
      quietMs: 50,
      pollMs: 10
    })
    list = [
      ...list,
      t('1', '/home/u/a.txt', 'running'),
      t('2', '/home/u/dir/x', 'done'),
      t('3', '/home/u/dir/y', 'queued')
    ]
    await new Promise((r) => setTimeout(r, 30))
    list = list.map((x) =>
      x.id === '1' ? { ...x, state: 'done' } : x.id === '3' ? { ...x, state: 'error' } : x
    )
    expect(await done).toEqual({
      moved: ['/home/u/a.txt'],
      kept: ['/home/u/dir', '/home/u/skipped.txt']
    })
  })
})
