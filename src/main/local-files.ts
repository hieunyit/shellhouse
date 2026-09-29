import { readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { LocalListing } from '@shared/local-files'

/** Thư mục khổng lồ (node_modules, thư mục log) — chỉ hiện chừng này mục. */
const MAX_ENTRIES = 5000

/**
 * Liệt kê một thư mục trên máy cho khung "Local" của trình quản lý file SFTP hai cột. Chỉ đọc
 * tên / kích thước / thời gian — không đọc nội dung file.
 */
export async function listLocal(path: string | null, home: string): Promise<LocalListing> {
  const dir = path && isAbsolute(path) ? resolve(path) : home
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.slice(0, MAX_ENTRIES).map(async (d) => {
      const full = join(dir, d.name)
      // Link: theo đích để biết là thư mục hay file (link hỏng → file cỡ 0).
      const info = await stat(full).catch(() => null)
      return {
        name: d.name,
        isDir: info?.isDirectory() ?? d.isDirectory(),
        size: info?.isFile() ? info.size : 0,
        mtime: info?.mtimeMs ?? 0
      }
    })
  )
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  const parent = dirname(dir)
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    sep,
    entries,
    truncated: dirents.length > MAX_ENTRIES
  }
}
