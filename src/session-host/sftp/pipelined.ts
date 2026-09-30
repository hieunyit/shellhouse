import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { SFTPWrapper } from 'ssh2'
import type { LossGuard } from './service'

/**
 * Truyền file qua SFTP bằng nhiều yêu cầu song song (như fastGet/fastPut của ssh2 — nhanh hơn
 * ~30 lần so với stream tuần tự), nhưng hỗ trợ bắt đầu từ một offset để resume.
 */

export const CHUNK_BYTES = 64 * 1024
export const MAX_IN_FLIGHT = 32

export interface PipelineControl {
  /** Gọi mỗi khi có thêm byte đã được ghi xong (tính cho tiến độ). */
  onProgress(bytes: number): void
  /** true = dừng càng sớm càng tốt. */
  isCancelled(): boolean
}

function sftpOpen(
  sftp: SFTPWrapper,
  guard: LossGuard,
  path: string,
  flags: 'r' | 'r+' | 'w'
): Promise<Buffer> {
  const lost = guard.isLost()
  if (lost) return Promise.reject(lost)
  return new Promise((resolve, reject) => {
    const off = guard.onLost(reject)
    sftp.open(path, flags, (err, handle) => {
      off()
      if (err) reject(err)
      else resolve(handle)
    })
  })
}

/** Đóng handle; không chờ nếu kết nối đã chết (callback sẽ không bao giờ đến). */
function sftpClose(sftp: SFTPWrapper, guard: LossGuard, handle: Buffer): Promise<void> {
  if (guard.isLost()) return Promise.resolve()
  return new Promise((resolve) => {
    const off = guard.onLost(() => {
      resolve()
    })
    sftp.close(handle, () => {
      off()
      resolve()
    })
  })
}

/** Đọc chính xác `length` byte tại `position` (gộp các lần đọc ngắn). */
export async function readExact(
  sftp: SFTPWrapper,
  guard: LossGuard,
  path: string,
  position: number,
  length: number
): Promise<Buffer> {
  const handle = await sftpOpen(sftp, guard, path, 'r')
  try {
    const out = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const n = await new Promise<number>((resolve, reject) => {
        const off = guard.onLost(reject)
        sftp.read(handle, out, got, length - got, position + got, (err, bytesRead) => {
          off()
          if (err) reject(err)
          else resolve(bytesRead)
        })
      })
      if (n === 0) break
      got += n
    }
    return out.subarray(0, got)
  } finally {
    await sftpClose(sftp, guard, handle)
  }
}

/**
 * Tải [offset, size) từ server vào `local`. Đọc song song nhưng GHI THEO THỨ TỰ, nên file đích
 * luôn là một đoạn đầu liền mạch — resume an toàn kể cả khi tiến trình bị tắt đột ngột.
 */
export async function pipelinedDownload(
  sftp: SFTPWrapper,
  guard: LossGuard,
  remotePath: string,
  local: FileHandle,
  offset: number,
  size: number,
  control: PipelineControl
): Promise<void> {
  const handle = await sftpOpen(sftp, guard, remotePath, 'r')
  let offLost = (): void => undefined
  try {
    await new Promise<void>((resolve, reject) => {
      offLost = guard.onLost((error) => {
        fail(error)
      })
      let nextRead = offset
      let nextWrite = offset
      let inFlight = 0
      let writing = false
      let done = false
      const ready = new Map<number, Buffer>()

      const fail = (error: unknown): void => {
        if (done) return
        done = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      const flush = (): void => {
        if (writing || done) return
        const data = ready.get(nextWrite)
        if (!data) {
          if (nextWrite >= size && inFlight === 0) {
            done = true
            resolve()
          }
          return
        }
        ready.delete(nextWrite)
        writing = true
        local.write(data, 0, data.length, nextWrite).then(() => {
          writing = false
          nextWrite += data.length
          control.onProgress(data.length)
          flush()
          schedule()
        }, fail)
      }

      const readAt = (position: number, length: number): void => {
        inFlight++
        const buf = Buffer.allocUnsafe(length)
        sftp.read(handle, buf, 0, length, position, (err, bytesRead) => {
          inFlight--
          if (done) return
          if (err) {
            fail(err)
            return
          }
          if (bytesRead === 0) {
            fail(new Error('The source file is shorter than expected (was it modified?)'))
            return
          }
          ready.set(position, buf.subarray(0, bytesRead))
          // Đọc ngắn: yêu cầu nốt phần còn thiếu.
          if (bytesRead < length) readAt(position + bytesRead, length - bytesRead)
          flush()
          schedule()
        })
      }

      const schedule = (): void => {
        if (done) return
        if (control.isCancelled()) {
          fail(new Error('Cancelled'))
          return
        }
        // Giới hạn cả số yêu cầu đang bay lẫn số mảnh đang chờ ghi (bộ nhớ ≤ ~4 MB).
        while (inFlight < MAX_IN_FLIGHT && ready.size < MAX_IN_FLIGHT && nextRead < size) {
          const length = Math.min(CHUNK_BYTES, size - nextRead)
          readAt(nextRead, length)
          nextRead += length
        }
        flush()
      }

      if (offset >= size) {
        done = true
        resolve()
        return
      }
      schedule()
    })
  } finally {
    offLost()
    await sftpClose(sftp, guard, handle)
  }
}

/** Tải [offset, size) của `local` lên server. OpenSSH xử lý yêu cầu ghi theo thứ tự nhận. */
export async function pipelinedUpload(
  sftp: SFTPWrapper,
  guard: LossGuard,
  local: FileHandle,
  remotePath: string,
  offset: number,
  size: number,
  control: PipelineControl
): Promise<void> {
  const handle = await sftpOpen(sftp, guard, remotePath, offset > 0 ? 'r+' : 'w')
  let offLost = (): void => undefined
  try {
    await new Promise<void>((resolve, reject) => {
      offLost = guard.onLost((error) => {
        fail(error)
      })
      let nextRead = offset
      let inFlight = 0
      let reading = false
      let done = false

      const fail = (error: unknown): void => {
        if (done) return
        done = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      const schedule = (): void => {
        if (done) return
        if (control.isCancelled()) {
          fail(new Error('Cancelled'))
          return
        }
        // Xong khi đã GHI hết: `nextRead` tăng ngay lúc bắt đầu đọc mảnh cuối — nếu không chờ
        // `reading`, một lệnh ghi trước đó được xác nhận đúng lúc mảnh cuối còn đang đọc sẽ kết
        // thúc sớm và bỏ mất mảnh cuối (file trên server bị thiếu đuôi).
        if (nextRead >= size && inFlight === 0 && !reading) {
          done = true
          resolve()
          return
        }
        if (reading || inFlight >= MAX_IN_FLIGHT || nextRead >= size) return
        const position = nextRead
        const length = Math.min(CHUNK_BYTES, size - position)
        nextRead += length
        reading = true
        const buf = Buffer.allocUnsafe(length)
        local.read(buf, 0, length, position).then(({ bytesRead }) => {
          reading = false
          if (done) return
          if (bytesRead !== length) {
            fail(new Error('The local file changed during the upload'))
            return
          }
          inFlight++
          sftp.write(handle, buf, 0, length, position, (err) => {
            inFlight--
            if (err) {
              fail(err)
              return
            }
            control.onProgress(length)
            schedule()
          })
          schedule()
        }, fail)
      }
      schedule()
    })
  } finally {
    offLost()
    await sftpClose(sftp, guard, handle)
  }
}

export async function openLocal(path: string, flags: 'r' | 'r+' | 'w'): Promise<FileHandle> {
  return fs.open(path, flags)
}
