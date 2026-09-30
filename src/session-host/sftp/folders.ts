import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { replaceUnsafeFileChars } from '@shared/file-names'
import { baseName, FOLDER_EXISTS, joinRemote } from '@shared/sftp'
import { createLimiter, mapLimit } from '../../node-shared/pool'
import type { SftpService } from './service'
import type { TransferQueue } from './transfers'

/** Giới hạn số mục một lần tải thư mục — tránh vô tình kéo cả ổ đĩa. */
export const MAX_FOLDER_ENTRIES = 10_000
/** Số yêu cầu SFTP cùng lúc khi duyệt / tạo cây thư mục. */
const WALK_PARALLEL = 8

const byPath =
  <T>(key: (x: T) => string) =>
  (a: T, b: T): number =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0

function budgetExceeded(): Error {
  return new Error(`The folder has too many items (more than ${MAX_FOLDER_ENTRIES})`)
}

/**
 * Tải cả thư mục trên server về `localParent/<tên thư mục>`: tạo cây thư mục trên máy, xếp mỗi file
 * vào hàng đợi (có resume). KHÔNG đi theo symlink (có thể trỏ ra ngoài / vòng lặp). Trả về số file.
 */
export async function downloadFolder(
  sftp: SftpService,
  transfers: TransferQueue,
  remoteDir: string,
  localParent: string,
  overwrite: boolean
): Promise<number> {
  const root = join(localParent, replaceUnsafeFileChars(baseName(remoteDir)))
  if (existsSync(root) && !overwrite) throw new Error(FOLDER_EXISTS)
  const files: { remote: string; local: string }[] = []
  const dirs: string[] = [root]
  let budget = MAX_FOLDER_ENTRIES
  // Duyệt song song: các thư mục con được đọc cùng lúc, tối đa WALK_PARALLEL yêu cầu.
  const limit = createLimiter(WALK_PARALLEL)
  const walk = async (remote: string, local: string): Promise<void> => {
    const entries = await limit(() => sftp.readdir(remote))
    budget -= entries.length
    if (budget < 0) throw budgetExceeded()
    await Promise.all(
      entries.map(async (e) => {
        const child = joinRemote(remote, e.filename)
        const target = join(local, replaceUnsafeFileChars(e.filename))
        // readdir của một số server báo thuộc tính của ĐÍCH link → lstat lại.
        const own =
          e.attrs.isDirectory() || e.attrs.isSymbolicLink()
            ? await limit(() => sftp.lstat(child))
            : e.attrs
        if (own.isSymbolicLink()) return
        if (own.isDirectory()) {
          dirs.push(target)
          await walk(child, target)
        } else if (own.isFile()) files.push({ remote: child, local: target })
      })
    )
  }
  await walk(remoteDir, root)
  // Thứ tự ổn định (duyệt song song trả về lộn xộn): tải theo đường dẫn.
  dirs.sort()
  files.sort(byPath((f) => f.remote))
  for (const dir of dirs) await mkdir(dir, { recursive: true })
  for (const f of files) transfers.enqueue('download', f.local, f.remote, overwrite)
  return files.length
}

/** Tải cả thư mục trên máy lên `remoteParent/<tên thư mục>`. Bỏ qua symlink. Trả về số file. */
export async function uploadFolder(
  sftp: SftpService,
  transfers: TransferQueue,
  localDir: string,
  remoteParent: string,
  overwrite: boolean
): Promise<number> {
  const root = joinRemote(remoteParent, basename(localDir))
  if ((await sftp.statOrNull(root)) && !overwrite) throw new Error(FOLDER_EXISTS)
  const files: { local: string; remote: string }[] = []
  const dirs: string[] = [root]
  let budget = MAX_FOLDER_ENTRIES
  const walk = async (local: string, remote: string): Promise<void> => {
    for (const e of await readdir(local, { withFileTypes: true })) {
      if (--budget < 0) throw budgetExceeded()
      const child = join(local, e.name)
      const target = joinRemote(remote, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        dirs.push(target)
        await walk(child, target)
      } else if (e.isFile()) files.push({ local: child, remote: target })
    }
  }
  await walk(localDir, root)
  // Tạo thư mục trên server theo từng tầng (cha trước con), các thư mục cùng tầng song song.
  const levels = new Map<number, string[]>()
  for (const dir of dirs) {
    const depth = dir.split('/').length
    levels.set(depth, [...(levels.get(depth) ?? []), dir])
  }
  for (const depth of [...levels.keys()].sort((a, b) => a - b))
    await mapLimit(levels.get(depth) ?? [], WALK_PARALLEL, async (dir) => {
      if (!(await sftp.statOrNull(dir))) await sftp.mkdir(dir)
    })
  files.sort(byPath((f) => f.remote))
  for (const f of files) transfers.enqueue('upload', f.local, f.remote, overwrite)
  return files.length
}
