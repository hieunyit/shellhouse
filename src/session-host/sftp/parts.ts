import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { LocalPartInfo } from '@shared/sftp'
import { PART_META_SUFFIX, PART_SUFFIX } from './transfers'

/** File meta chỉ vài chục byte; đọc tối đa chừng này (đường dẫn nguồn dài vẫn đủ). */
const MAX_META_READ = 8192

interface PartMeta {
  size: number
  mtime: number
  remote: string | null
}

function parseMeta(text: string): PartMeta | null {
  try {
    const meta = JSON.parse(text) as {
      v?: unknown
      size?: unknown
      mtime?: unknown
      remote?: unknown
    }
    if (meta.v !== 1 || typeof meta.size !== 'number' || typeof meta.mtime !== 'number') return null
    return {
      size: meta.size,
      mtime: meta.mtime,
      // Đường dẫn trên server (chỉ dùng để stat nguồn trên server của chính tab): thường "/…", nhưng
      // không ép — server SFTP trên Windows / test có thể dùng dạng khác. Chỉ chặn rỗng / NUL / quá dài.
      remote:
        typeof meta.remote === 'string' &&
        meta.remote.length > 0 &&
        meta.remote.length <= 4096 &&
        !meta.remote.includes('\0')
          ? meta.remote
          : null
    }
  } catch {
    return null
  }
}

async function readMeta(path: string): Promise<PartMeta | null> {
  const file = await fs.open(path, 'r').catch(() => null)
  if (!file) return null
  try {
    const buf = Buffer.alloc(MAX_META_READ)
    const { bytesRead } = await file.read(buf, 0, MAX_META_READ, 0)
    return parseMeta(buf.subarray(0, bytesRead).toString('utf8'))
  } catch {
    return null
  } finally {
    await file.close()
  }
}

/** Tên một mục ngay trong `dir` (không đi ra ngoài, không dấu phân cách). */
function validName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
}

function checkDir(dir: string): void {
  if (!isAbsolute(dir)) throw new Error('Local path must be absolute')
}

/**
 * File tải dở bị bỏ lại trong một thư mục trên máy (`<tên>.shellhouse-part` + meta): khung Local
 * gửi những tên nó thấy trong danh sách (không quét thư mục nào khác). `remoteStat` = stat trên
 * server của tab (null: chưa kết nối) — tiếp tục được khi nguồn còn đúng kích thước + mtime như
 * lúc bắt đầu; phần đuôi còn được so lại lúc tải (transfers.ts).
 */
export async function inspectLocalParts(
  dir: string,
  names: readonly string[],
  remoteStat: ((path: string) => Promise<{ size: number; mtime: number } | null>) | null,
  busy: (localPath: string) => boolean
): Promise<LocalPartInfo[]> {
  checkDir(dir)
  const out = await Promise.all(
    [...new Set(names)].filter(validName).map(async (name): Promise<LocalPartInfo | null> => {
      const target = join(dir, name)
      if (busy(target)) return null
      const part = await fs.stat(target + PART_SUFFIX).catch(() => null)
      if (!part?.isFile()) return null
      const meta = await readMeta(target + PART_META_SUFFIX)
      let resumable = false
      if (meta?.remote && remoteStat && part.size > 0 && part.size <= meta.size) {
        const remote = await remoteStat(meta.remote).catch(() => null)
        resumable = remote !== null && remote.size === meta.size && remote.mtime === meta.mtime
      }
      return {
        name,
        partBytes: part.size,
        totalBytes: meta?.size ?? null,
        remotePath: meta?.remote ?? null,
        resumable
      }
    })
  )
  return out.filter((x): x is LocalPartInfo => x !== null)
}

/** Xoá file part + meta của các mục `names` trong `dir` (bỏ qua mục đang có lượt tải ghi vào). */
export async function discardLocalParts(
  dir: string,
  names: readonly string[],
  busy: (localPath: string) => boolean
): Promise<number> {
  checkDir(dir)
  let removed = 0
  for (const name of new Set(names)) {
    if (!validName(name)) continue
    const target = join(dir, name)
    if (busy(target)) continue
    const existed = await fs
      .stat(target + PART_SUFFIX)
      .then(() => true)
      .catch(() => false)
    await fs.rm(target + PART_SUFFIX, { force: true })
    await fs.rm(target + PART_META_SUFFIX, { force: true })
    if (existed) removed++
  }
  return removed
}
