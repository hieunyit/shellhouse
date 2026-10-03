import { promises as fs } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { t } from '@shared/i18n'
import { PART_META_SUFFIX, PART_SUFFIX, type TransferStatus } from '@shared/sftp'
import {
  openLocal,
  pipelinedDownload,
  pipelinedUpload,
  readExact,
  type PipelineControl
} from './pipelined'
import type { SFTPWrapper } from 'ssh2'
import type { SftpService } from './service'

/**
 * PART_META_SUFFIX: file ghi kèm file part — kích thước + mtime của NGUỒN lúc bắt đầu. Chỉ so phần
 * đuôi thì không đủ — nguồn đổi nội dung mà giữ nguyên độ dài (editor lưu lại) vẫn khớp đuôi → ghép
 * sai âm thầm.
 */
export { PART_META_SUFFIX, PART_SUFFIX }
/** Thêm một lớp kiểm tra: phần đuôi của file dở dang cũng phải khớp với nguồn. */
const TAIL_CHECK_BYTES = 4096
/**
 * File nhỏ hơn thế này không resume (làm lại từ đầu nhanh hơn) → không tốn thêm lượt hỏi-đáp
 * cho file part / file meta — tải nhiều file nhỏ (cả thư mục) nhanh hơn hẳn.
 */
export const RESUME_MIN_BYTES = 256 * 1024
const MAX_META_BYTES = 512
/** Mặc định số file truyền cùng lúc (chỉnh trong Settings → Files). */
export const DEFAULT_SFTP_TRANSFERS = 4
const PROGRESS_INTERVAL_MS = 250
const STATE_INTERVAL_MS = 30
const MAX_NOTIFY_INTERVAL_MS = 1000

interface Job {
  status: TransferStatus
  overwrite: boolean
  cancelled: boolean
  /** Upload chỉ khi mtime trên server vẫn là giá trị này (giây) — không ghi đè thay đổi của người khác. */
  expectRemoteMtime: number | null
  mode: number | null
  noResume: boolean
  /**
   * File part của lần chạy gần nhất: 'temp' = file nhỏ / lượt sửa (không resume — lỗi / huỷ thì xoá
   * ngay), 'resumable' = giữ lại để tiếp tục, 'none' = chưa tạo (lỗi trước khi mở part).
   */
  part: 'none' | 'temp' | 'resumable'
  /** Người chờ lượt truyền kết thúc (done / error / cancelled). */
  waiters: ((status: TransferStatus) => void)[]
}

export interface EnqueueOptions {
  expectRemoteMtime?: number
  /** Lượt truyền của tính năng sửa file (hiện "Saved" thay vì "Done"). */
  edit?: boolean
  /** Upload: đặt quyền này cho file mới TRƯỚC khi thay file cũ (không có lúc nào sai quyền). */
  mode?: number
  /** Luôn làm lại từ đầu, bỏ file part cũ (tải về để sửa; lượt `edit` luôn như vậy). */
  noResume?: boolean
}

/**
 * Nội dung file meta của file part. `remote` (chỉ với tải về): đường dẫn nguồn trên server — để khung
 * Local nhận ra file tải dở bị bỏ lại và tiếp tục được (xem parts.ts).
 */
export function partMetaText(size: number, mtime: number, remote?: string): string {
  return JSON.stringify(
    remote === undefined ? { v: 1, size, mtime } : { v: 1, size, mtime, remote }
  )
}

function metaMatches(text: string | null, size: number, mtime: number): boolean {
  if (text === null) return false
  try {
    const meta = JSON.parse(text) as { v?: unknown; size?: unknown; mtime?: unknown }
    return meta.v === 1 && meta.size === size && meta.mtime === mtime
  } catch {
    return false
  }
}

/**
 * Quyền cho file vừa tải về. File part luôn tạo 0600 (không ai khác đọc được trong lúc tải); xong
 * thì theo quyền gốc nhưng không bao giờ cho group/others ghi: id_rsa / .env (0600) vẫn là 0600,
 * script 0755 vẫn chạy được.
 */
export function downloadedMode(remoteMode: number): number {
  return (remoteMode & 0o755) | 0o600
}

/** Bản tiếng Anh (test so sánh); lúc ném lỗi thì dịch theo ngôn ngữ giao diện. */
export const REMOTE_CHANGED_MESSAGE =
  'The file was changed on the server after you opened it — not overwritten. Open it again to get the latest version.'

/** Mã lỗi SFTP (số, theo giao thức) và lỗi hệ thống tệp của Node. */
function errorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 2) return t('File not found')
  if (code === 'EACCES' || code === 3) return t('Permission denied')
  if (code === 'ENOSPC') return t('Disk is full')
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
 * - Resume: tiếp tục từ file part nếu nguồn vẫn đúng kích thước + mtime lúc bắt đầu (file meta) và
 *   4 KB cuối khớp; không thì làm lại từ đầu. File nhỏ và lượt sửa file không resume.
 * - Kiểm tra kích thước cuối cùng trước khi đổi tên.
 */
export class TransferQueue {
  private readonly jobs = new Map<string, Job>()
  private running = 0
  private notifyTimer: NodeJS.Timeout | null = null
  private notifyDue = 0
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
    if (!isAbsolute(localPath)) throw new Error(t('Local path must be absolute'))
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
      noResume: options.noResume === true || options.edit === true,
      part: 'none',
      waiters: []
    })
    this.notify(true)
    this.pump()
    return id
  }

  /** Chờ lượt truyền kết thúc; trả về trạng thái cuối. */
  settled(id: string): Promise<TransferStatus> {
    const job = this.jobs.get(id)
    if (!job) return Promise.reject(new Error(t('Unknown transfer')))
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
    delete job.status.resumable
    this.notify(true)
    this.pump()
  }

  /** Bỏ một lượt lỗi / đã huỷ: xoá khỏi danh sách và xoá luôn file part (+ meta). */
  discard(id: string): void {
    const job = this.jobs.get(id)
    if (!job || (job.status.state !== 'error' && job.status.state !== 'cancelled')) return
    this.jobs.delete(id)
    if (!this.busyPath(job.status)) this.discardPart(job.status)
    this.notify(true)
  }

  /**
   * Xoá khỏi danh sách mọi lượt đã kết thúc (xong, lỗi, huỷ). Lượt dở dang thì bỏ luôn file part —
   * trừ khi `keepParts` (người dùng chọn giữ để lần sau tải lại cùng file thì tiếp tục).
   */
  clearDone(keepParts = false): void {
    const finished = new Set(['done', 'error', 'cancelled'])
    for (const [id, job] of this.jobs) {
      if (!finished.has(job.status.state)) continue
      this.jobs.delete(id)
      if (job.status.state === 'done' || this.busyPath(job.status)) continue
      if (!keepParts || job.status.resumable !== true) this.discardPart(job.status)
    }
    this.notify(true)
  }

  /** Đường dẫn file part đang có lượt (chưa kết thúc) ghi vào — không được xoá. */
  isBusyLocal(localPath: string): boolean {
    return this.busyPath({ direction: 'download', localPath, remotePath: '' })
  }

  /** Có lượt khác (chưa kết thúc) dùng cùng file part không — khi đó không được xoá part. */
  private busyPath(
    status: Pick<TransferStatus, 'direction' | 'localPath' | 'remotePath'>
  ): boolean {
    for (const other of this.jobs.values()) {
      // Chính lượt đang hỏi (vd. đang dọn sau khi huỷ, trạng thái vẫn 'running') không tính.
      if (other.status === status) continue
      const { state } = other.status
      if (state !== 'queued' && state !== 'running') continue
      if (other.status.direction !== status.direction) continue
      if (status.direction === 'download' && other.status.localPath === status.localPath)
        return true
      if (status.direction === 'upload' && other.status.remotePath === status.remotePath)
        return true
    }
    return false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    let changed = false
    for (const job of this.jobs.values()) {
      job.cancelled = true
      if (job.status.state === 'queued') {
        job.status.state = 'cancelled'
        this.settle(job)
        changed = true
      }
    }
    // Lần báo đang chờ (gom ~30 ms) không được mất: gửi ngay trạng thái cuối.
    const pending = this.notifyTimer !== null
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = null
    if (pending || changed) this.onChange(this.list())
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
    job.part = 'none'
    try {
      if (job.status.direction === 'download') await this.download(job)
      else await this.upload(job)
      job.status.state = 'done'
      job.status.bytesPerSecond = 0
    } catch (error) {
      job.status.bytesPerSecond = 0
      // Dọn / giữ file part TRƯỚC khi đổi trạng thái: ai thấy 'cancelled' / 'error' (renderer, test)
      // thì file part đã ở trạng thái cuối — không còn khoảng hở thấy rác vừa bị xoá.
      await this.afterFailure(job)
      job.status.state = job.cancelled ? 'cancelled' : 'error'
      job.status.error = job.cancelled ? null : errorText(error)
    } finally {
      this.settle(job)
      this.notify(true)
    }
  }

  /**
   * Lượt lỗi / bị huỷ: chỉ giữ file part khi tiếp tục được (file lớn, đã có dữ liệu) — còn lại xoá
   * ngay, không để rác `*.shellhouse-part` trong thư mục của người dùng.
   */
  private async afterFailure(job: Job): Promise<void> {
    const keep = job.part === 'resumable' && job.status.transferred > 0
    if (keep) {
      job.status.resumable = true
      return
    }
    if (job.part === 'none' || this.busyPath(job.status)) return
    const { localPath, remotePath } = job.status
    if (job.status.direction === 'download') {
      await fs.rm(localPath + PART_SUFFIX, { force: true }).catch(() => undefined)
      await fs.rm(localPath + PART_META_SUFFIX, { force: true }).catch(() => undefined)
    } else if (!this.sftp.isLost()) {
      await this.sftp.unlinkIfExists(remotePath + PART_SUFFIX).catch(() => undefined)
      await this.sftp.unlinkIfExists(remotePath + PART_META_SUFFIX).catch(() => undefined)
    }
  }

  private async download(job: Job): Promise<void> {
    const { remotePath, localPath } = job.status
    const remote = await this.sftp.stat(remotePath)
    if (remote.isDirectory()) throw new Error(t('Downloading folders is not supported yet'))
    if (!job.overwrite && (await localExists(localPath)))
      throw new Error(t('The destination file already exists'))
    const size = remote.size
    job.status.size = size
    const part = localPath + PART_SUFFIX
    const metaPath = localPath + PART_META_SUFFIX
    const resumable = !job.noResume && size >= RESUME_MIN_BYTES
    const channel = await this.sftp.channel()

    let offset = 0
    if (resumable) {
      const [partSize, meta] = await Promise.all([
        localSize(part),
        fs.readFile(metaPath, 'utf8').catch(() => null)
      ])
      offset = partSize ?? 0
      if (offset > size || !metaMatches(meta, size, remote.mtime)) offset = 0
      if (offset > 0) {
        const start = Math.max(0, offset - TAIL_CHECK_BYTES)
        const [remoteTail, localTail] = await Promise.all([
          readExact(channel, this.sftp, remotePath, start, offset - start),
          readLocalRange(part, start, offset - start)
        ])
        if (!remoteTail.equals(localTail)) offset = 0
      }
    }
    job.status.resumedFrom = offset
    job.status.transferred = offset

    // Part luôn tạo 0600: file bí mật (id_rsa, .env) không bao giờ có lúc người khác đọc được
    // (xoá part cũ trước — 'w' giữ nguyên quyền của file đã có).
    if (offset === 0) await fs.rm(part, { force: true })
    const file = await openLocal(part, offset > 0 ? 'r+' : 'w', 0o600)
    job.part = resumable ? 'resumable' : 'temp'
    try {
      // Meta ghi SAU khi part đã bị cắt về 0: không bao giờ có meta mới đi kèm nội dung part cũ.
      if (offset === 0) {
        if (resumable)
          await fs.writeFile(metaPath, partMetaText(size, remote.mtime, remotePath), {
            mode: 0o600
          })
        else await fs.rm(metaPath, { force: true })
      }
      await pipelinedDownload(channel, this.sftp, remotePath, file, offset, size, this.control(job))
    } finally {
      await file.close()
    }
    const written = await localSize(part)
    if (written !== size)
      throw new Error(
        t('Size mismatch after download ({written}/{size})', { written: written ?? 0, size })
      )
    if (process.platform !== 'win32')
      await fs.chmod(part, downloadedMode(remote.mode)).catch(() => undefined)
    await fs.rename(part, localPath)
    if (resumable) await fs.rm(metaPath, { force: true })
  }

  private async upload(job: Job): Promise<void> {
    const { remotePath, localPath } = job.status
    const local = await fs.stat(localPath)
    if (!local.isFile()) throw new Error(t('Only files can be uploaded'))
    const existing = await this.sftp.statOrNull(remotePath)
    if (!job.overwrite && existing) throw new Error(t('The destination file already exists'))
    if (job.expectRemoteMtime !== null && existing && existing.mtime !== job.expectRemoteMtime)
      throw new Error(
        t(
          'The file was changed on the server after you opened it — not overwritten. Open it again to get the latest version.'
        )
      )
    const size = local.size
    job.status.size = size
    const part = remotePath + PART_SUFFIX
    const metaPath = remotePath + PART_META_SUFFIX
    const resumable = !job.noResume && size >= RESUME_MIN_BYTES
    const sourceMtime = Math.floor(local.mtimeMs)
    const channel = await this.sftp.channel()

    let offset = 0
    if (resumable) {
      const [partStat, meta] = await Promise.all([
        this.sftp.statOrNull(part),
        readExact(channel, this.sftp, metaPath, 0, MAX_META_BYTES).then(
          (buf) => buf.toString('utf8'),
          () => null
        )
      ])
      offset = partStat?.size ?? 0
      if (offset > size || !metaMatches(meta, size, sourceMtime)) offset = 0
      if (offset > 0) {
        const start = Math.max(0, offset - TAIL_CHECK_BYTES)
        const [remoteTail, localTail] = await Promise.all([
          readExact(channel, this.sftp, part, start, offset - start),
          readLocalRange(localPath, start, offset - start)
        ])
        if (!remoteTail.equals(localTail)) offset = 0
      }
      if (offset === 0) {
        // Bỏ part cũ TRƯỚC khi ghi meta mới (xem download); part mới do lượt tải bên dưới tạo.
        await this.sftp.unlinkIfExists(part)
        await this.writeSmall(channel, metaPath, partMetaText(size, sourceMtime))
      }
    } else {
      // Lượt trước (file lớn hơn / resume được) có thể để lại meta — không thì nằm mồ côi mãi.
      // Không chờ: yêu cầu xếp hàng cùng kênh, file nhỏ không tốn thêm một lượt hỏi-đáp.
      void this.sftp.unlinkIfExists(metaPath).catch(() => undefined)
    }
    job.status.resumedFrom = offset
    job.status.transferred = offset

    const file = await openLocal(localPath, 'r')
    job.part = resumable ? 'resumable' : 'temp'
    try {
      await pipelinedUpload(channel, this.sftp, file, part, offset, size, this.control(job))
    } finally {
      await file.close()
    }
    const written = (await this.sftp.stat(part)).size
    if (written !== size)
      throw new Error(t('Size mismatch after upload ({written}/{size})', { written, size }))
    if (job.mode !== null) await this.sftp.chmod(part, job.mode)
    await this.sftp.rename(part, remotePath, job.overwrite)
    if (resumable) await this.sftp.unlinkIfExists(metaPath)
  }

  /** Ghi một file nhỏ trên server (file meta). */
  private async writeSmall(channel: SFTPWrapper, path: string, text: string): Promise<void> {
    const data = Buffer.from(text, 'utf8')
    const handle = await this.sftp.guarded<Buffer>((cb) => {
      channel.open(path, 'w', cb)
    })
    try {
      await this.sftp.guarded<undefined>((cb) => {
        channel.write(handle, data, 0, data.length, 0, (err) => {
          cb(err, undefined)
        })
      })
    } finally {
      await this.sftp
        .guarded<undefined>((cb) => {
          channel.close(handle, (err) => {
            cb(err, undefined)
          })
        })
        .catch(() => undefined)
    }
  }

  /** Bỏ file part (+ meta) của lượt truyền bị huỷ / lỗi mà người dùng đã xoá khỏi danh sách. */
  private discardPart(status: TransferStatus): void {
    if (status.direction === 'download') {
      void fs.rm(status.localPath + PART_SUFFIX, { force: true }).catch(() => undefined)
      void fs.rm(status.localPath + PART_META_SUFFIX, { force: true }).catch(() => undefined)
    } else if (!this.sftp.isLost()) {
      void this.sftp.unlinkIfExists(status.remotePath + PART_SUFFIX).catch(() => undefined)
      void this.sftp.unlinkIfExists(status.remotePath + PART_META_SUFFIX).catch(() => undefined)
    }
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

  /**
   * Báo danh sách cho renderer — luôn gom lại: mỗi lần báo gửi CẢ danh sách, nên tải thư mục 10 000
   * file mà báo ngay từng lần enqueue / xong file là O(n²) bản sao + postMessage (UI đứng hình).
   * Đổi trạng thái: báo sau ~30 ms; tiến độ: ~250 ms; danh sách dài thì giãn ra tương ứng.
   */
  private notify(stateChanged = false): void {
    if (this.disposed) return
    const scaled = Math.min(MAX_NOTIFY_INTERVAL_MS, Math.floor(this.jobs.size / 10))
    const delay = Math.max(stateChanged ? STATE_INTERVAL_MS : PROGRESS_INTERVAL_MS, scaled)
    const due = Date.now() + delay
    if (this.notifyTimer && this.notifyDue <= due) return
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyDue = due
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.onChange(this.list())
    }, delay)
  }
}
