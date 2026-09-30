import { createHash } from 'node:crypto'
import { unwatchFile, watch, watchFile, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { SftpService } from './service'
import type { TransferQueue } from './transfers'

/** Editor thường ghi file nhiều bước (ghi tạm → đổi tên); chờ yên rồi mới tải lên. */
const SETTLE_MS = 400
const POLL_MS = 1000
/**
 * Kiểm tra lại một lần sau khi bắt đầu theo dõi: fs.watch trên macOS (FSEvents) cần một lúc mới nhận
 * sự kiện, còn watchFile lấy mốc so sánh bất đồng bộ — lưu ngay sau khi mở có thể lọt cả hai. So hash
 * nên không đổi thì không làm gì.
 */
const INITIAL_CHECK_MS = 1500

interface Edit {
  remotePath: string
  localPath: string
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
  /** sha256 của nội dung đã khớp với server (sau lần tải về / tải lên gần nhất). */
  syncedHash: string
  /** mtime trên server (giây) sau lần đồng bộ gần nhất — để phát hiện người khác sửa. */
  remoteMtime: number
  /** Quyền gốc: tải lên = file mới (ghi part rồi đổi tên) → phải giữ, không thì script 755 thành 644. */
  mode: number
  uploading: boolean
  /** Có thay đổi mới trong lúc đang tải lên → tải lên lần nữa khi xong. */
  again: boolean
}

export async function hashFile(path: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  } catch {
    return null
  }
}

/**
 * "Sửa file trên server bằng editor trên máy" (như MobaXterm): tải về thư mục tạm, theo dõi file,
 * mỗi lần lưu (nội dung thật sự đổi) thì tải lên đè bản trên server — trừ khi bản trên server đã
 * bị sửa từ lúc mở (khi đó báo lỗi, không ghi đè).
 */
export class RemoteEdits {
  private readonly edits = new Map<string, Edit>()
  private disposed = false

  constructor(
    private readonly sftp: SftpService,
    private readonly transfers: TransferQueue
  ) {}

  async open(remotePath: string, localPath: string): Promise<void> {
    // Mở lại cùng file: bỏ theo dõi cũ, tải bản mới nhất.
    this.stop(localPath)
    const id = this.transfers.enqueue('download', localPath, remotePath, true)
    const result = await this.transfers.settled(id)
    if (result.state !== 'done') throw new Error(result.error ?? 'Download was cancelled')
    const [stats, hash] = await Promise.all([this.sftp.stat(remotePath), hashFile(localPath)])
    if (this.disposed || hash === null) return

    // Theo dõi thư mục (không phải file): editor lưu kiểu "ghi file tạm rồi đổi tên" làm watcher
    // trên chính file mất dấu sau lần lưu đầu.
    const name = basename(localPath)
    const watcher = watch(dirname(localPath), (_event, changed) => {
      if (changed === null || changed === name) this.schedule(localPath)
    })
    watcher.on('error', () => {
      this.stop(localPath)
    })
    // Lưới an toàn: fs.watch có thể lỡ sự kiện (macOS/FSEvents cần một lúc mới bắt đầu nhận; ổ
    // mạng). Hỏi mtime/size mỗi giây — trùng với fs.watch cũng không sao vì so hash trước khi tải.
    watchFile(localPath, { interval: POLL_MS }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size)
        this.schedule(localPath)
    })
    this.edits.set(localPath, {
      remotePath,
      localPath,
      watcher,
      timer: null,
      syncedHash: hash,
      remoteMtime: stats.mtime,
      mode: stats.mode & 0o7777,
      uploading: false,
      again: false
    })
    const added = this.edits.get(localPath)
    if (added) {
      added.timer = setTimeout(() => {
        added.timer = null
        void this.sync(added)
      }, INITIAL_CHECK_MS)
    }
  }

  stop(localPath: string): void {
    const edit = this.edits.get(localPath)
    if (!edit) return
    edit.watcher.close()
    unwatchFile(localPath)
    if (edit.timer) clearTimeout(edit.timer)
    this.edits.delete(localPath)
  }

  dispose(): void {
    this.disposed = true
    for (const localPath of [...this.edits.keys()]) this.stop(localPath)
  }

  private schedule(localPath: string): void {
    const edit = this.edits.get(localPath)
    if (!edit) return
    if (edit.timer) clearTimeout(edit.timer)
    edit.timer = setTimeout(() => {
      edit.timer = null
      void this.sync(edit)
    }, SETTLE_MS)
  }

  private async sync(edit: Edit): Promise<void> {
    if (edit.uploading) {
      edit.again = true
      return
    }
    const hash = await hashFile(edit.localPath)
    // Chỉ "chạm" file (đổi mtime) hoặc file đang ghi dở/đã xoá → không làm gì.
    if (hash === null || hash === edit.syncedHash || this.edits.get(edit.localPath) !== edit) return
    edit.uploading = true
    try {
      const id = this.transfers.enqueue('upload', edit.localPath, edit.remotePath, true, {
        expectRemoteMtime: edit.remoteMtime,
        edit: true,
        mode: edit.mode
      })
      const result = await this.transfers.settled(id)
      if (result.state === 'done') {
        edit.syncedHash = hash
        edit.remoteMtime = (await this.sftp.stat(edit.remotePath)).mtime
      }
    } catch {
      // Lỗi đã hiện trong danh sách transfers.
    } finally {
      edit.uploading = false
      if (edit.again) {
        edit.again = false
        void this.sync(edit)
      }
    }
  }
}
