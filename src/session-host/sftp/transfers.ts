import { promises as fs } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TransferStatus } from '@shared/sftp'
import {
  openLocal,
  pipelinedDownload,
  pipelinedUpload,
  readExact,
  type PipelineControl
} from './pipelined'
import type { SftpService } from './service'

export const PART_SUFFIX = '.shellhouse-part'
/** Resume chỉ khi phần đuôi của file dở dang khớp với nguồn. */
const TAIL_CHECK_BYTES = 4096
/** Mặc định số file truyền cùng lúc (chỉnh trong Settings → Files). */
export const DEFAULT_SFTP_TRANSFERS = 4
const PROGRESS_INTERVAL_MS = 250

interface Job {
  status: TransferStatus
  overwrite: boolean
  cancelled: boolean
  /** Upload chỉ khi mtime trên server vẫn là giá trị này (giây) — không ghi đè thay đổi của người khác. */
  expectRemoteMtime: number | null
  mode: number | null
  /** Người chờ lượt truyền kết thúc (done / error / cancelled). */
  waiters: ((status: TransferStatus) => void)[]
}

export interface EnqueueOptions {
  expectRemoteMtime?: number
  /** Lượt truyền của tính năng sửa file (hiện "Saved" thay vì "Done"). */
  edit?: boolean
  /** Upload: đặt quyền này cho file mới TRƯỚC khi thay file cũ (không có lúc nào sai quyền). */
  mode?: number
}

export const REMOTE_CHANGED_MESSAGE =
  'The file was changed on the server after you opened it — not overwritten. Open it again to get the latest version.'

/** Mã lỗi SFTP (số, theo giao thức) và lỗi hệ thống tệp của Node. */
function errorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 2) return 'File not found'
  if (code === 'EACCES' || code === 3) return 'Permission denied'
  if (code === 'ENOSPC') return 'Disk is full'
  return error instanceof Error ? error.message : String(error)
}

async function readLocalRange(path: string, position: number, length: number): Promise<Buffer> {
  const file = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await file.read(buf, 0, length, position)
    return buf.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

async function localSize(path: string): Promise<number | null> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return null
  }
}

async function localExists(path: string): Promise<boolean> {
  return (await localSize(path)) !== null
}

/**
 * Hàng đợi upload/download qua SFTP.
 * - Ghi vào file `*.shellhouse-part`, xong mới đổi tên → không bao giờ để lại file đích dở dang.
 * - Resume: tiếp tục từ file part nếu 4 KB cuối khớp với nguồn; không khớp thì làm lại từ đầu.
 * - Kiểm tra kích thước cuối cùng trước khi đổi tên.
 */
export class TransferQueue {
  private readonly jobs = new Map<string, Job>()
  private running = 0
  private notifyTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    private readonly sftp: SftpService,
    private readonly onChange: (list: TransferStatus[]) => void,
    private readonly maxParallel = DEFAULT_SFTP_TRANSFERS
  ) {}

  list(): TransferStatus[] {
    return [...this.jobs.values()].map((j) => ({ ...j.status }))
  }

  enqueue(
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    overwrite: boolean,
    options: EnqueueOptions = {}
  ): string {
    if (!isAbsolute(localPath)) throw new Error('Local path must be absolute')
    const id = randomUUID()
    this.jobs.set(id, {
      status: {
        id,
        direction,
        localPath,
        remotePath,
        size: 0,
        transferred: 0,
        resumedFrom: 0,
        state: 'queued',
        error: null,
        bytesPerSecond: 0,
        ...(options.edit ? { edit: true } : {})
      },
      overwrite,
      cancelled: false,
      expectRemoteMtime: options.expectRemoteMtime ?? null,
      mode: options.mode ?? null,
      waiters: []
    })
    this.notify(true)
    this.pump()
    return id
  }

  /** Chờ lượt truyền kết thúc; trả về trạng thái cuối. */
  settled(id: string): Promise<TransferStatus> {
    const job = this.jobs.get(id)
    if (!job) return Promise.reject(new Error('Unknown transfer'))
    const { state } = job.status
    if (state === 'done' || state === 'error' || state === 'cancelled')
      return Promise.resolve({ ...job.status })
    return new Promise((resolve) => job.waiters.push(resolve))
  }

  private settle(job: Job): void {
    const waiters = job.waiters.splice(0)
    for (const resolve of waiters) resolve({ ...job.status })
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job || (job.status.state !== 'running' && job.status.state !== 'queued')) return
    job.cancelled = true
    if (job.status.state === 'queued') {
      job.status.state = 'cancelled'
      this.settle(job)
      this.notify(true)
    }
  }

  /** Chạy lại (tiếp tục từ file part nếu có). */
  retry(id: string): void {
    const job = this.jobs.get(id)
    if (!job || (job.status.state !== 'error' && job.status.state !== 'cancelled')) return
    job.cancelled = false
    job.status = { ...job.status, state: 'queued', error: null, bytesPerSecond: 0 }
    this.notify(true)
    this.pump()
  }

  clearDone(): void {
    for (const [id, job] of this.jobs) if (job.status.state === 'done') this.jobs.delete(id)
    this.notify(true)
  }

  dispose(): void {
    this.disposed = true
    for (const job of this.jobs.values()) {
      job.cancelled = true
      if (job.status.state === 'queued') {
        job.status.state = 'cancelled'
        this.settle(job)
      }
    }
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
  }

  private pump(): void {
    if (this.disposed) return
    for (const job of this.jobs.values()) {
      if (this.running >= this.maxParallel) return
      if (job.status.state !== 'queued') continue
      this.running++
      job.status.state = 'running'
      this.notify(true)
      void this.run(job).finally(() => {
        this.running--
        this.pump()
      })
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      if (job.status.direction === 'download') await this.download(job)
      else await this.upload(job)
      job.status.state = 'done'
      job.status.bytesPerSecond = 0
    } catch (error) {
      job.status.state = job.cancelled ? 'cancelled' : 'error'
      job.status.error = job.cancelled ? null : errorText(error)
    } finally {
      this.settle(job)
      this.notify(true)
    }
  }

  private async download(job: Job): Promise<void> {
    const { remotePath, localPath } = job.status
    const remote = await this.sftp.stat(remotePath)
    if (remote.isDirectory()) throw new Error('Downloading folders is not supported yet')
    if (!job.overwrite && (await localExists(localPath)))
      throw new Error('The destination file already exists')
    const size = remote.size
    job.status.size = size
    const part = localPath + PART_SUFFIX
    const channel = await this.sftp.channel()

    let offset = (await localSize(part)) ?? 0
    if (offset > size) offset = 0
    if (offset > 0) {
      const start = Math.max(0, offset - TAIL_CHECK_BYTES)
      const [remoteTail, localTail] = await Promise.all([
        readExact(channel, this.sftp, remotePath, start, offset - start),
        readLocalRange(part, start, offset - start)
      ])
      if (!remoteTail.equals(localTail)) offset = 0
    }
    job.status.resumedFrom = offset
    job.status.transferred = offset

    const file = await openLocal(part, offset > 0 ? 'r+' : 'w')
    try {
      await pipelinedDownload(channel, this.sftp, remotePath, file, offset, size, this.control(job))
    } finally {
      await file.close()
    }
    const written = await localSize(part)
    if (written !== size) throw new Error(`Size mismatch after download (${written ?? 0}/${size})`)
    await fs.rename(part, localPath)
  }

  private async upload(job: Job): Promise<void> {
    const { remotePath, localPath } = job.status
    const local = await fs.stat(localPath)
    if (!local.isFile()) throw new Error('Only files can be uploaded')
    const existing = await this.sftp.statOrNull(remotePath)
    if (!job.overwrite && existing) throw new Error('The destination file already exists')
    if (job.expectRemoteMtime !== null && existing && existing.mtime !== job.expectRemoteMtime)
      throw new Error(REMOTE_CHANGED_MESSAGE)
    const size = local.size
    job.status.size = size
    const part = remotePath + PART_SUFFIX
    const channel = await this.sftp.channel()

    let offset = (await this.sftp.statOrNull(part))?.size ?? 0
    if (offset > size) offset = 0
    if (offset > 0) {
      const start = Math.max(0, offset - TAIL_CHECK_BYTES)
      const [remoteTail, localTail] = await Promise.all([
        readExact(channel, this.sftp, part, start, offset - start),
        readLocalRange(localPath, start, offset - start)
      ])
      if (!remoteTail.equals(localTail)) offset = 0
    }
    job.status.resumedFrom = offset
    job.status.transferred = offset

    const file = await openLocal(localPath, 'r')
    try {
      await pipelinedUpload(channel, this.sftp, file, part, offset, size, this.control(job))
    } finally {
      await file.close()
    }
    const written = (await this.sftp.stat(part)).size
    if (written !== size) throw new Error(`Size mismatch after upload (${written}/${size})`)
    if (job.mode !== null) await this.sftp.chmod(part, job.mode)
    await this.sftp.rename(part, remotePath, job.overwrite)
  }

  private control(job: Job): PipelineControl {
    let windowStart = Date.now()
    let windowBytes = 0
    return {
      isCancelled: () => job.cancelled || this.disposed,
      onProgress: (bytes) => {
        job.status.transferred += bytes
        windowBytes += bytes
        const now = Date.now()
        if (now - windowStart >= 1000) {
          job.status.bytesPerSecond = Math.round((windowBytes * 1000) / (now - windowStart))
          windowStart = now
          windowBytes = 0
        }
        this.notify()
      }
    }
  }

  private notify(immediate = false): void {
    if (this.disposed) return
    if (immediate) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer)
      this.notifyTimer = null
      this.onChange(this.list())
      return
    }
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = null
      this.onChange(this.list())
    }, PROGRESS_INTERVAL_MS)
  }
}
