import { z } from 'zod'

/** Đường dẫn: không rỗng, không có ký tự NUL. */
const RemotePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'Path contains a NUL character')
const LocalPath = RemotePath

export const SftpOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('realpath'), path: RemotePath }),
  z.object({ op: z.literal('list'), path: RemotePath }),
  z.object({ op: z.literal('mkdir'), path: RemotePath }),
  z.object({ op: z.literal('rename'), from: RemotePath, to: RemotePath }),
  z.object({ op: z.literal('remove'), path: RemotePath, recursive: z.boolean() }),
  z.object({ op: z.literal('chmod'), path: RemotePath, mode: z.number().int().min(0).max(0o7777) }),
  z.object({
    op: z.literal('download'),
    remotePath: RemotePath,
    localPath: LocalPath,
    overwrite: z.boolean()
  }),
  z.object({
    op: z.literal('upload'),
    localPath: LocalPath,
    remotePath: RemotePath,
    overwrite: z.boolean()
  }),
  z.object({ op: z.literal('cancel'), transferId: z.string().max(64) }),
  z.object({ op: z.literal('retry'), transferId: z.string().max(64) }),
  z.object({ op: z.literal('clearDone') })
])
export type SftpOp = z.infer<typeof SftpOp>

export type SftpEntryType = 'file' | 'dir' | 'link' | 'other'

export interface SftpEntry {
  name: string
  type: SftpEntryType
  /** Với link: true nếu trỏ tới thư mục. */
  isDirLike: boolean
  size: number
  /** Unix ms. */
  mtime: number
  /** Quyền dạng số (ví dụ 0o755). */
  mode: number
}

export interface SftpListing {
  path: string
  entries: SftpEntry[]
}

export type TransferState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface TransferStatus {
  id: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  size: number
  transferred: number
  /** Byte bỏ qua nhờ resume. */
  resumedFrom: number
  state: TransferState
  error: string | null
  bytesPerSecond: number
}

/** Chuỗi quyền kiểu `ls -l`: rwxr-xr-x. */
export function formatMode(mode: number): string {
  const bits = 'rwxrwxrwx'
  let out = ''
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? (bits[i] ?? '-') : '-'
  return out
}

/** Nối đường dẫn POSIX phía server. */
export function joinRemote(dir: string, name: string): string {
  if (name.startsWith('/')) return name
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

export function parentRemote(path: string): string {
  if (path === '/' || !path.includes('/')) return '/'
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}
