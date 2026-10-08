import { describe, expect, it } from 'vitest'
import type { TransferStatus } from '../../src/shared/sftp'
import { isFinished, orphanize, splitLocal } from '../../src/renderer/src/terminal/orphan-transfers'

const base: TransferStatus = {
  id: 'a',
  direction: 'download',
  localPath: '/tmp/x/big.bin',
  remotePath: '/home/u/big.bin',
  size: 1000,
  transferred: 390,
  resumedFrom: 0,
  state: 'running',
  error: null,
  bytesPerSecond: 57_000_000
}

describe('lượt truyền của phiên đã đóng', () => {
  it('đang chạy / chờ → lỗi, tốc độ về 0; tải xuống dở được đánh dấu tiếp tục được', () => {
    const [run, queued, up] = orphanize(
      [
        base,
        { ...base, id: 'b', state: 'queued', transferred: 0 },
        { ...base, id: 'c', direction: 'upload' }
      ],
      'Connection lost'
    )
    expect(run).toMatchObject({
      state: 'error',
      error: 'Connection lost',
      bytesPerSecond: 0,
      resumable: true
    })
    expect(queued?.resumable).toBeUndefined()
    expect(up?.resumable).toBeUndefined()
    expect(up?.state).toBe('error')
  })

  it('lượt đã xong / lỗi / huỷ giữ nguyên (bản sao, không đổi gốc)', () => {
    const done = { ...base, state: 'done' as const }
    const out = orphanize([done], 'x')
    expect(out[0]).toEqual(done)
    expect(out[0]).not.toBe(done)
    expect(base.state).toBe('running')
  })

  it('tách đường dẫn máy này; lượt kết thúc nhận biết đúng', () => {
    expect(splitLocal('/tmp/x/big.bin')).toEqual({ dir: '/tmp/x', name: 'big.bin' })
    expect(splitLocal('/big.bin')).toEqual({ dir: '/', name: 'big.bin' })
    expect(splitLocal('C:\\Users\\a\\big.bin')).toEqual({ dir: 'C:\\Users\\a', name: 'big.bin' })
    expect(isFinished({ ...base, state: 'cancelled' })).toBe(true)
    expect(isFinished(base)).toBe(false)
  })
})
