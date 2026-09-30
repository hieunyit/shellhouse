import type { FileHandle } from 'node:fs/promises'
import type { SFTPWrapper } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { CHUNK_BYTES, pipelinedUpload } from '../../src/session-host/sftp/pipelined'
import type { LossGuard } from '../../src/session-host/sftp/service'

const guard: LossGuard = { isLost: () => null, onLost: () => () => undefined }
type Cb = (err: Error | null) => void

/** Server SFTP giả trong bộ nhớ: xác nhận mỗi lệnh ghi gần như ngay lập tức. */
function fakeServer(): { sftp: SFTPWrapper; written: () => number; closed: () => boolean } {
  let bytes = 0
  let closed = false
  const sftp = {
    open: (_p: string, _f: string, cb: (err: Error | null, h: Buffer) => void) => {
      cb(null, Buffer.from('h'))
    },
    write: (_h: Buffer, _b: Buffer, _o: number, length: number, _pos: number, cb: Cb) => {
      setImmediate(() => {
        if (closed) {
          cb(new Error('write after close'))
          return
        }
        bytes += length
        cb(null)
      })
    },
    close: (_h: Buffer, cb: Cb) => {
      closed = true
      cb(null)
    }
  } as unknown as SFTPWrapper
  return { sftp, written: () => bytes, closed: () => closed }
}

describe('pipelinedUpload', () => {
  it('chờ mảnh cuối đọc xong từ đĩa rồi mới báo xong (không bỏ mất đuôi file)', async () => {
    const size = 3 * CHUNK_BYTES + 100
    // Đĩa chậm ở mảnh cuối: các lệnh ghi trước đã được xác nhận hết trong lúc mảnh cuối còn đọc.
    const local = {
      read: async (buf: Buffer, _o: number, length: number, position: number) => {
        if (position + length >= size) await new Promise((r) => setTimeout(r, 30))
        buf.fill(1, 0, length)
        return { bytesRead: length, buffer: buf }
      }
    } as unknown as FileHandle
    const server = fakeServer()
    await pipelinedUpload(server.sftp, guard, local, '/x', 0, size, {
      onProgress: () => undefined,
      isCancelled: () => false
    })
    expect(server.written()).toBe(size)
  })
})
