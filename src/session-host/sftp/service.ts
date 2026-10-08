import { t } from '@shared/i18n'
import type { Client, SFTPWrapper, Stats } from 'ssh2'
import type { SftpEntry, SftpListing, SftpPreview } from '@shared/sftp'
import { FILE_CHANGED, MAX_WRITE_BYTES, joinRemote } from '@shared/sftp'
import { randomBytes } from 'node:crypto'
import { createLimiter, mapLimit } from '../../node-shared/pool'

const MAX_RECURSIVE_DELETE = 10_000
const WRITE_CHUNK_BYTES = 32 * 1024
const WRITE_IN_FLIGHT = 16
const READ_CHUNK_BYTES = 64 * 1024
const READ_IN_FLIGHT = 16
/** Mã SSH_FX_OP_UNSUPPORTED của giao thức SFTP. */
const SFTP_OP_UNSUPPORTED = 8

/** Server không hỗ trợ (ssh2 ném ngay khi server không quảng bá extension, hoặc server trả mã 8). */
function isUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === SFTP_OP_UNSUPPORTED) return true
  return error instanceof Error && /does not support this extended request/i.test(error.message)
}
/** Lưu từ editor: quá số mục này trong thư mục mà chưa thấy file → không đếm hard link, ghi tại chỗ. */
const HARDLINK_SCAN_LIMIT = 2000
/** Mặc định số yêu cầu SFTP cùng lúc khi duyệt / xoá thư mục (chỉnh trong Settings → Files). */
export const DEFAULT_SFTP_PARALLEL = 8

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

  constructor(
    private readonly client: Client,
    /** Số yêu cầu cùng lúc khi duyệt / tạo / xoá cây thư mục. */
    readonly parallel = DEFAULT_SFTP_PARALLEL
  ) {
    const die = (): void => {
      this.markLost(new Error(t('Connection lost')))
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
      try {
        fn((err, value) => {
          if (settled) return
          settled = true
          off()
          if (err) reject(err)
          else resolve(value)
        })
      } catch (error) {
        // ssh2 ném đồng bộ (vd. ext_openssh_rename khi server không có extension) → vẫn gỡ
        // listener, không thì mỗi lần lưu / đổi tên rò thêm một listener "lost". (Đã gọi cb rồi
        // mới ném thì off / reject lặp lại là vô hại.)
        settled = true
        off()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
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

  /** Đọc phần đầu file (xem trước) — tối đa `maxBytes`, không tải về đĩa. */
  async preview(path: string, maxBytes: number): Promise<SftpPreview> {
    const s = await this.channel()
    const st = await this.stat(path)
    if (st.isDirectory()) throw new Error(t('This is a folder'))
    const want = Math.min(maxBytes, st.size)
    const handle = await this.guarded<Buffer>((cb) => {
      s.open(path, 'r', cb)
    })
    try {
      const buf = Buffer.alloc(want)
      // Đọc song song nhiều mảnh (mở file 8 MB trong editor: 128 lượt hỏi-đáp tuần tự = hàng chục
      // giây trên đường xa). Mảnh đọc ngắn thì đọc nốt; file ngắn đi (EOF sớm) → lấy phần liền mạch.
      const offsets: number[] = []
      for (let at = 0; at < want; at += READ_CHUNK_BYTES) offsets.push(at)
      const got = await mapLimit(offsets, READ_IN_FLIGHT, async (at) => {
        const end = Math.min(at + READ_CHUNK_BYTES, want)
        let pos = at
        while (pos < end) {
          const n = await this.guarded<number>((cb) => {
            s.read(handle, buf, pos, end - pos, pos, (err, bytes) => {
              cb(err, bytes)
            })
          })
          if (n <= 0) break
          pos += n
        }
        return pos - at
      })
      let read = 0
      for (const [i, n] of got.entries()) {
        read += n
        if (n < Math.min(READ_CHUNK_BYTES, want - (offsets[i] ?? 0))) break
      }
      return {
        path,
        size: st.size,
        mtime: st.mtime * 1000,
        data: buf.subarray(0, read).toString('base64'),
        truncated: st.size > read
      }
    } finally {
      s.close(handle, () => undefined)
    }
  }

  /**
   * Lưu nội dung từ editor trong app — xem op `write`. Ghi ra file tạm cùng thư mục rồi đổi tên đè
   * lên (posix-rename, nguyên tử): rớt mạng giữa chừng không bao giờ để lại file rỗng / dở dang.
   * Giữ quyền; ghi vào đích thật nếu là symlink. Chỉ thay file khi chắc là an toàn — còn lại ghi
   * tại chỗ như cũ: không phải file thường, owner không có quyền ghi (0444: server trả EACCES như
   * trước, không lặng lẽ thay file chỉ-đọc), không biết chắc số hard link là 1 (thư mục quá lớn,
   * longname không theo kiểu `ls -l`), owner khác mình, không tạo được file tạm.
   * Đánh đổi đã biết của việc thay inode: mất xattr / ACL / nhãn SELinux của file cũ, và bind
   * mount từng file (docker `-v ./app.conf:/etc/app.conf`) vẫn trỏ vào inode cũ. SFTP không có
   * cách đọc / chép xattr nên không giữ được — chấp nhận đổi lấy việc không bao giờ để lại file
   * dở dang khi rớt mạng.
   */
  async write(
    path: string,
    data: Buffer,
    expect?: { mtime: number; size: number }
  ): Promise<{ size: number; mtime: number }> {
    if (data.length > MAX_WRITE_BYTES)
      throw new Error(t('The file is too large to save from the editor'))
    const s = await this.channel()
    const st = await this.statOrNull(path)
    if (expect && st && (st.mtime * 1000 !== expect.mtime || st.size !== expect.size))
      throw new Error(FILE_CHANGED)
    const target = st ? await this.realpath(path).catch(() => path) : path
    const saved = await this.writeViaTemp(s, target, data, st)
    if (!saved) await this.writeInPlace(s, target, data)
    const after = await this.stat(target)
    return { size: after.size, mtime: after.mtime * 1000 }
  }

  /** false = không dùng được cách này (chưa đụng tới file đích) → ghi tại chỗ. */
  private async writeViaTemp(
    s: SFTPWrapper,
    target: string,
    data: Buffer,
    original: Stats | null
  ): Promise<boolean> {
    const slash = target.lastIndexOf('/')
    const dir = slash < 0 ? '' : target.slice(0, slash + 1)
    const name = target.slice(slash + 1)
    if (original) {
      if (!original.isFile() || (original.mode & 0o200) === 0) return false
      if ((await this.linkCount(s, dir, name)) !== 1) return false
    }
    const temp = `${dir}.${name}.shellhouse-save-${randomBytes(4).toString('hex')}`
    let handle: Buffer
    try {
      handle = await this.guarded<Buffer>((cb) => {
        s.open(temp, 'wx', original ? { mode: original.mode & 0o7777 } : {}, cb)
      })
    } catch (error) {
      if (this.lost) throw error
      return false
    }
    let ok = false
    try {
      if (original) {
        const own = await this.guarded<Stats>((cb) => {
          s.fstat(handle, cb)
        })
        if (own.uid !== original.uid || own.gid !== original.gid) {
          // Thử giữ owner/group (được nếu cùng owner, chỉ khác group mà mình là thành viên).
          const kept = await this.guarded<undefined>((cb) => {
            s.fchown(handle, original.uid, original.gid, (err) => {
              cb(err, undefined)
            })
          }).then(
            () => true,
            () => false
          )
          if (!kept) return false
        }
        // umask của server có thể đã bớt quyền lúc tạo → đặt lại đúng quyền gốc.
        await this.guarded<undefined>((cb) => {
          s.fchmod(handle, original.mode & 0o7777, (err) => {
            cb(err, undefined)
          })
        })
      }
      await this.writeAll(s, handle, data)
      ok = true
    } finally {
      await this.closeHandle(s, handle)
      if (!ok) await this.unlinkIfExists(temp).catch(() => undefined)
    }
    try {
      await this.rename(temp, target, true)
    } catch (error) {
      await this.unlinkIfExists(temp).catch(() => undefined)
      throw error
    }
    return true
  }

  /**
   * Số hard link — chỉ có trong `longname` của readdir (cột thứ hai kiểu `ls -l`). Đọc thư mục
   * từng mẻ và dừng khi thấy file hoặc quá HARDLINK_SCAN_LIMIT mục (thư mục log / cache khổng lồ
   * không bị đọc hết mỗi lần lưu). null = không biết (không thấy, quá nhiều, longname lạ, lỗi).
   */
  private async linkCount(s: SFTPWrapper, dir: string, name: string): Promise<number | null> {
    const handle = await this.guarded<Buffer>((cb) => {
      s.opendir(dir || '.', cb)
    }).catch(() => null)
    if (!handle) return null
    try {
      let seen = 0
      while (seen <= HARDLINK_SCAN_LIMIT) {
        const batch = await this.guarded<{ filename: string; longname: string }[]>((cb) => {
          s.readdir(handle, cb)
        }).catch(() => null)
        // null = EOF hoặc lỗi.
        if (!batch?.length) return null
        const entry = batch.find((e) => e.filename === name)
        if (entry) {
          const links = /^[-dlcbps][-rwxsStTl@+.]{9}\S*\s+(\d+)\s/.exec(entry.longname)?.[1]
          return links === undefined ? null : Number(links)
        }
        seen += batch.length
      }
      return null
    } finally {
      await this.closeHandle(s, handle)
    }
  }

  private async writeInPlace(s: SFTPWrapper, path: string, data: Buffer): Promise<void> {
    const handle = await this.guarded<Buffer>((cb) => {
      s.open(path, 'w', cb)
    })
    try {
      await this.writeAll(s, handle, data)
    } finally {
      await this.closeHandle(s, handle)
    }
  }

  /** Ghi cả buffer: nhiều yêu cầu song song (server ghi theo thứ tự nhận), không chờ từng mảnh. */
  private async writeAll(s: SFTPWrapper, handle: Buffer, data: Buffer): Promise<void> {
    const offsets: number[] = []
    for (let at = 0; at < data.length; at += WRITE_CHUNK_BYTES) offsets.push(at)
    await mapLimit(offsets, WRITE_IN_FLIGHT, (at) =>
      this.guarded<undefined>((cb) => {
        s.write(handle, data, at, Math.min(WRITE_CHUNK_BYTES, data.length - at), at, (err) => {
          cb(err, undefined)
        })
      })
    )
  }

  private closeHandle(s: SFTPWrapper, handle: Buffer): Promise<void> {
    return this.guarded<undefined>((cb) => {
      s.close(handle, (err) => {
        cb(err, undefined)
      })
    }).catch(() => undefined)
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
    const plain = (a: string, b: string): Promise<undefined> =>
      this.guarded<undefined>((cb) => {
        s.rename(a, b, (err) => {
          cb(err, undefined)
        })
      })
    if (!overwrite) {
      await plain(from, to)
      return
    }
    try {
      await this.guarded<undefined>((cb) => {
        s.ext_openssh_rename(from, to, (err) => {
          cb(err, undefined)
        })
      })
      return
    } catch (error) {
      // CHỈ khi server không có extension. Lỗi khác (không có quyền, đĩa đầy, mất mạng…) mà vẫn
      // xoá đích thì lần đổi tên sau hỏng nốt = mất luôn file gốc.
      if (!isUnsupported(error)) throw error
    }
    // Không có posix-rename: dời đích sang tên tạm, đổi tên, rồi mới xoá bản cũ — lỗi giữa chừng
    // thì trả bản cũ về chỗ.
    const backup = `${to}.shellhouse-old-${randomBytes(4).toString('hex')}`
    const moved = await plain(to, backup).then(
      () => true,
      () => false
    )
    try {
      await plain(from, to)
    } catch (error) {
      if (moved) await plain(backup, to).catch(() => undefined)
      throw error
    }
    if (moved) await this.unlinkIfExists(backup)
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
    const lstat = (p: string): Promise<Stats> =>
      this.guarded<Stats>((cb) => {
        s.lstat(p, cb)
      })
    const rmdir = (p: string): Promise<undefined> =>
      this.guarded<undefined>((cb) => {
        s.rmdir(p, (err) => {
          cb(err, undefined)
        })
      })
    /** Xoá file hoặc link. Link tới thư mục trên server Windows phải xoá bằng rmdir (chỉ xoá link). */
    const removeEntry = async (p: string, isLink: boolean): Promise<void> => {
      try {
        await this.guarded<undefined>((cb) => {
          s.unlink(p, (err) => {
            cb(err, undefined)
          })
        })
      } catch (error) {
        if (!isLink) throw error
        await rmdir(p).catch(() => {
          throw error
        })
      }
    }

    const stats = await lstat(path)
    if (!stats.isDirectory()) {
      await removeEntry(path, stats.isSymbolicLink())
      return
    }
    if (recursive) {
      let budget = MAX_RECURSIVE_DELETE
      // Mọi yêu cầu mạng đi qua bộ giới hạn: các thư mục con / file được xử lý song song, nhưng
      // không quá `parallel` yêu cầu cùng lúc. Thư mục chỉ rmdir sau khi mọi thứ bên trong xong.
      const limit = createLimiter(this.parallel)
      const walk = async (dir: string): Promise<void> => {
        const entries = await limit(() =>
          this.guarded<{ filename: string; attrs: Stats }[]>((cb) => {
            s.readdir(dir, cb)
          })
        )
        const children = entries.filter((e) => e.filename !== '.' && e.filename !== '..')
        budget -= children.length
        if (budget < 0)
          throw new Error(
            t('Folder is too large to delete recursively (more than {max} items)', {
              max: MAX_RECURSIVE_DELETE
            })
          )
        await Promise.all(
          children.map(async (e) => {
            const child = joinRemote(dir, e.filename)
            // KHÔNG đi theo symlink ra ngoài. Thuộc tính của readdir có thể là của đích (một số
            // server, ví dụ Windows OpenSSH, báo link tới thư mục như thư mục) → lstat lại.
            const own =
              e.attrs.isDirectory() || e.attrs.isSymbolicLink()
                ? await limit(() => lstat(child))
                : e.attrs
            if (own.isDirectory() && !own.isSymbolicLink()) await walk(child)
            else await limit(() => removeEntry(child, own.isSymbolicLink()))
          })
        )
        await limit(() => rmdir(dir))
      }
      await walk(path)
      return
    }
    await rmdir(path)
  }

  /** Mục trong thư mục (không có . và ..), thuộc tính thô của server. */
  async readdir(dir: string): Promise<{ filename: string; attrs: Stats }[]> {
    const s = await this.channel()
    const entries = await this.guarded<{ filename: string; attrs: Stats }[]>((cb) => {
      s.readdir(dir, cb)
    })
    return entries.filter((e) => e.filename !== '.' && e.filename !== '..')
  }

  /** Thuộc tính của chính đường dẫn (link không bị đi theo). */
  async lstat(path: string): Promise<Stats> {
    const s = await this.channel()
    return this.guarded<Stats>((cb) => {
      s.lstat(path, cb)
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
    // Kết nối đã chết thì `end()` không làm callback đang chờ được gọi — báo mất để chúng thất bại.
    const channel = this.sftp
    this.markLost(new Error(t('Connection closed')))
    void channel?.then(
      (s) => {
        s.end()
      },
      () => undefined
    )
    this.sftp = null
  }
}
