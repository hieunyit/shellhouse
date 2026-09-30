import { unwatchFile, watch, watchFile, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { hashFile } from '../sftp/edit'
import type { S3Service } from './service'

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
  bucket: string
  key: string
  localPath: string
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
  /** sha256 của nội dung đã khớp với S3 (sau lần tải về / tải lên gần nhất). */
  syncedHash: string
  /** ETag trên S3 sau lần đồng bộ gần nhất — để phát hiện người khác sửa. */
  etag: string | null
  /** Giữ Content-Type gốc khi tải lên đè (không thì thành binary/octet-stream). */
  contentType: string
  uploading: boolean
  /** Có thay đổi mới trong lúc đang tải lên → tải lên lần nữa khi xong. */
  again: boolean
}

/**
 * "Sửa object S3 bằng editor trên máy" (giống sửa file SFTP): tải về thư mục tạm, theo dõi file,
 * mỗi lần lưu (nội dung thật sự đổi) thì tải lên đè — trừ khi object đã bị sửa từ lúc mở (ETag
 * khác), khi đó báo lỗi trong Transfers, không ghi đè.
 */
export class S3Edits {
  private readonly edits = new Map<string, Edit>()
  private disposed = false

  constructor(private readonly s3: S3Service) {}

  async open(bucket: string, key: string, localPath: string): Promise<void> {
    this.stop(localPath)
    const info = await this.s3.downloadAndWait(bucket, key, localPath)
    const hash = await hashFile(localPath)
    if (this.disposed || hash === null) return

    // Theo dõi thư mục (không phải file): editor lưu kiểu "ghi file tạm rồi đổi tên" làm watcher
    // trên chính file mất dấu sau lần lưu đầu. watchFile là lưới an toàn khi fs.watch lỡ sự kiện.
    const name = basename(localPath)
    const watcher = watch(dirname(localPath), (_event, changed) => {
      if (changed === null || changed === name) this.schedule(localPath)
    })
    watcher.on('error', () => {
      this.stop(localPath)
    })
    watchFile(localPath, { interval: POLL_MS }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size)
        this.schedule(localPath)
    })
    this.edits.set(localPath, {
      bucket,
      key,
      localPath,
      watcher,
      timer: null,
      syncedHash: hash,
      etag: info.etag,
      contentType: info.contentType,
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
    if (hash === null || hash === edit.syncedHash || this.edits.get(edit.localPath) !== edit) return
    edit.uploading = true
    try {
      edit.etag = await this.s3.uploadIfUnchanged(
        edit.bucket,
        edit.key,
        edit.localPath,
        edit.etag,
        edit.contentType
      )
      edit.syncedHash = hash
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
