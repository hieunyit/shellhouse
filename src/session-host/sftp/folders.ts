import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { replaceUnsafeFileChars } from '@shared/file-names'
import { baseName, FOLDER_EXISTS, joinRemote } from '@shared/sftp'
import type { SftpService } from './service'
import type { TransferQueue } from './transfers'

/** Giới hạn số mục một lần tải thư mục — tránh vô tình kéo cả ổ đĩa. */
export const MAX_FOLDER_ENTRIES = 10_000

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
  const walk = async (remote: string, local: string): Promise<void> => {
    for (const e of await sftp.readdir(remote)) {
      if (--budget < 0) throw budgetExceeded()
      const child = joinRemote(remote, e.filename)
      const target = join(local, replaceUnsafeFileChars(e.filename))
      // readdir của một số server báo thuộc tính của ĐÍCH link → lstat lại.
      const own =
        e.attrs.isDirectory() || e.attrs.isSymbolicLink() ? await sftp.lstat(child) : e.attrs
      if (own.isSymbolicLink()) continue
      if (own.isDirectory()) {
        dirs.push(target)
        await walk(child, target)
      } else if (own.isFile()) files.push({ remote: child, local: target })
    }
  }
  await walk(remoteDir, root)
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
  for (const dir of dirs) if (!(await sftp.statOrNull(dir))) await sftp.mkdir(dir)
  for (const f of files) transfers.enqueue('upload', f.local, f.remote, overwrite)
  return files.length
}
