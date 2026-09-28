import type { Client, SFTPWrapper, Stats } from 'ssh2'
import type { SftpEntry, SftpListing } from '@shared/sftp'
import { joinRemote } from '@shared/sftp'

const MAX_RECURSIVE_DELETE = 10_000

/**
 * Tín hiệu "kết nối đã chết". ssh2 chỉ huỷ các yêu cầu SFTP đang chờ khi kênh nhận EOF bình thường;
 * khi cả kết nối SSH chết (RST, mạng đứt) callback của chúng KHÔNG BAO GIỜ được gọi → mọi thao tác
 * phải chạy đua với tín hiệu này để không treo mãi.
 */
export interface LossGuard {
  isLost(): Error | null
  onLost(listener: (error: Error) => void): () => void
}

type Cb<T> = (err: Error | null | undefined, value: T) => void

function typeOf(stats: Stats): SftpEntry['type'] {
  if (stats.isSymbolicLink()) return 'link'
  if (stats.isDirectory()) return 'dir'
  if (stats.isFile()) return 'file'
  return 'other'
}

/** Thao tác SFTP trên kết nối SSH của tab. Kênh SFTP mở lười và dùng lại. */
export class SftpService implements LossGuard {
  private sftp: Promise<SFTPWrapper> | null = null
  private lost: Error | null = null
  private readonly lossListeners = new Set<(error: Error) => void>()

  constructor(private readonly client: Client) {
    const die = (): void => {
      this.markLost(new Error('Connection lost'))
    }
    client.once('close', die)
    client.once('end', die)
  }

  isLost(): Error | null {
    return this.lost
  }

  onLost(listener: (error: Error) => void): () => void {
    if (this.lost) {
      listener(this.lost)
      return () => undefined
    }
    this.lossListeners.add(listener)
    return () => this.lossListeners.delete(listener)
  }

  private markLost(error: Error): void {
    if (this.lost) return
    this.lost = error
    this.sftp = null
    for (const l of [...this.lossListeners]) l(error)
    this.lossListeners.clear()
  }

  /** Chạy một thao tác callback của ssh2, nhưng từ chối ngay nếu kết nối chết trước khi có kết quả. */
  guarded<T>(fn: (cb: Cb<T>) => void): Promise<T> {
    if (this.lost) return Promise.reject(this.lost)
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const off = this.onLost((error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      fn((err, value) => {
        if (settled) return
        settled = true
        off()
        if (err) reject(err)
        else resolve(value)
      })
    })
  }

  channel(): Promise<SFTPWrapper> {
    if (this.lost) return Promise.reject(this.lost)
    this.sftp ??= this.guarded<SFTPWrapper>((cb) => {
      this.client.sftp((err, s) => {
        if (!err) {
          // Kênh SFTP đóng (server tắt sftp-server) → lần sau mở lại kênh mới.
          s.once('close', () => {
            this.sftp = null
          })
        }
        cb(err, s)
      })
    }).catch((error: unknown) => {
      this.sftp = null
      throw error
    })
    return this.sftp
  }

  async realpath(path: string): Promise<string> {
    const s = await this.channel()
    return this.guarded<string>((cb) => {
      s.realpath(path, cb)
    })
  }

  async stat(path: string): Promise<Stats> {
    const s = await this.channel()
    return this.guarded<Stats>((cb) => {
      s.stat(path, cb)
    })
  }

  async statOrNull(path: string): Promise<Stats | null> {
    try {
      return await this.stat(path)
    } catch {
      return null
    }
  }

  async list(path: string): Promise<SftpListing> {
    const s = await this.channel()
    const resolved = await this.realpath(path)
    const raw = await this.guarded<{ filename: string; attrs: Stats }[]>((cb) => {
      s.readdir(resolved, cb)
    })
    const entries = await Promise.all(
      raw
        .filter((e) => e.filename !== '.' && e.filename !== '..')
        .map(async (e): Promise<SftpEntry> => {
          const type = typeOf(e.attrs)
          let isDirLike = type === 'dir'
          if (type === 'link') {
            // Link: xem đích là thư mục hay file (link hỏng → coi là file).
            const target = await this.statOrNull(joinRemote(resolved, e.filename))
            isDirLike = target?.isDirectory() ?? false
          }
          return {
            name: e.filename,
            type,
            isDirLike,
            size: e.attrs.size,
            mtime: e.attrs.mtime * 1000,
            mode: e.attrs.mode & 0o7777
          }
        })
    )
    entries.sort((a, b) =>
      a.isDirLike === b.isDirLike ? a.name.localeCompare(b.name) : a.isDirLike ? -1 : 1
    )
    return { path: resolved, entries }
  }

  async mkdir(path: string): Promise<void> {
    const s = await this.channel()
    await this.guarded<undefined>((cb) => {
      s.mkdir(path, (err) => {
        cb(err, undefined)
      })
    })
  }

  /** Đổi tên; ưu tiên posix-rename của OpenSSH (ghi đè nguyên tử) nếu server hỗ trợ. */
  async rename(from: string, to: string, overwrite = false): Promise<void> {
    const s = await this.channel()
    if (overwrite) {
      try {
        await this.guarded<undefined>((cb) => {
          s.ext_openssh_rename(from, to, (err) => {
            cb(err, undefined)
          })
        })
        return
      } catch {
        // Server không có extension → xoá đích rồi đổi tên.
        await this.unlinkIfExists(to)
      }
    }
    await this.guarded<undefined>((cb) => {
      s.rename(from, to, (err) => {
        cb(err, undefined)
      })
    })
  }

  async chmod(path: string, mode: number): Promise<void> {
    const s = await this.channel()
    await this.guarded<undefined>((cb) => {
      s.chmod(path, mode, (err) => {
        cb(err, undefined)
      })
    })
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    const s = await this.channel()
    const stats = await this.guarded<Stats>((cb) => {
      s.lstat(path, cb)
    })
    if (!stats.isDirectory()) {
      await this.guarded<undefined>((cb) => {
        s.unlink(path, (err) => {
          cb(err, undefined)
        })
      })
      return
    }
    if (recursive) {
      let budget = MAX_RECURSIVE_DELETE
      const walk = async (dir: string): Promise<void> => {
        const entries = await this.guarded<{ filename: string; attrs: Stats }[]>((cb) => {
          s.readdir(dir, cb)
        })
        for (const e of entries) {
          if (e.filename === '.' || e.filename === '..') continue
          if (--budget < 0)
            throw new Error(
              `Folder is too large to delete recursively (> ${MAX_RECURSIVE_DELETE} entries)`
            )
          const child = joinRemote(dir, e.filename)
          // Không đi theo symlink: chỉ xoá chính link.
          if (e.attrs.isDirectory() && !e.attrs.isSymbolicLink()) {
            await walk(child)
          } else {
            await this.guarded<undefined>((cb) => {
              s.unlink(child, (err) => {
                cb(err, undefined)
              })
            })
          }
        }
        await this.guarded<undefined>((cb) => {
          s.rmdir(dir, (err) => {
            cb(err, undefined)
          })
        })
      }
      await walk(path)
      return
    }
    await this.guarded<undefined>((cb) => {
      s.rmdir(path, (err) => {
        cb(err, undefined)
      })
    })
  }

  async unlinkIfExists(path: string): Promise<void> {
    const s = await this.channel()
    await new Promise<void>((resolve) => {
      s.unlink(path, () => {
        resolve()
      })
    })
  }

  close(): void {
    void this.sftp?.then(
      (s) => {
        s.end()
      },
      () => undefined
    )
    this.sftp = null
  }
}
