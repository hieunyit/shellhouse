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
  /** Xem trước: đọc tối đa `maxBytes` đầu file (văn bản / ảnh), không ghi ra đĩa. */
  z.object({
    op: z.literal('preview'),
    path: RemotePath,
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024)
  }),
  z.object({ op: z.literal('chmod'), path: RemotePath, mode: z.number().int().min(0).max(0o7777) }),
  /**
   * Ghi đè nội dung file (editor trong app) — ghi tại chỗ: giữ owner, quyền, hard link. `expect` =
   * file phải còn đúng như lúc mở (mtime + size), khác → lỗi FILE_CHANGED (đã bị sửa nơi khác).
   */
  z.object({
    op: z.literal('write'),
    path: RemotePath,
    /** base64, tối đa MAX_WRITE_BYTES. */
    data: z.string().max(Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4),
    expect: z.object({ mtime: z.number(), size: z.number().int().nonnegative() }).optional()
  }),
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
  /** Tải cả thư mục về `localParent/<tên>`; trả về số file đã xếp hàng. */
  z.object({
    op: z.literal('downloadFolder'),
    remotePath: RemotePath,
    localParent: LocalPath,
    overwrite: z.boolean()
  }),
  /** Tải cả thư mục trên máy lên `remoteParent/<tên>`; trả về số file đã xếp hàng. */
  z.object({
    op: z.literal('uploadFolder'),
    localPath: LocalPath,
    remoteParent: RemotePath,
    overwrite: z.boolean()
  }),
  /**
   * Sửa file: tải về `localPath` (do main cấp, trong thư mục tạm), rồi theo dõi — mỗi lần lưu
   * thì tự tải ngược lên. Trả về khi đã tải về xong.
   */
  z.object({ op: z.literal('edit'), remotePath: RemotePath, localPath: LocalPath }),
  z.object({ op: z.literal('cancel'), transferId: z.string().max(64) }),
  z.object({ op: z.literal('retry'), transferId: z.string().max(64) }),
  /** Bỏ lượt lỗi / đã huỷ: xoá khỏi danh sách và xoá file part. */
  z.object({ op: z.literal('discard'), transferId: z.string().max(64) }),
  /** `keepParts`: giữ file part của lượt dở dang (tải lại cùng file sau thì tiếp tục). */
  z.object({ op: z.literal('clearDone'), keepParts: z.boolean().optional() }),
  /**
   * File tải dở bị bỏ lại trong thư mục trên máy (khung Local): `names` = tên file đích (bỏ đuôi
   * `.shellhouse-part`) thấy trong danh sách thư mục. Trả về LocalPartInfo[].
   */
  z.object({
    op: z.literal('localParts'),
    dir: LocalPath,
    names: z.array(z.string().min(1).max(1024)).max(500)
  }),
  /** Xoá file part + meta của các mục đó; trả về số file part đã xoá. */
  z.object({
    op: z.literal('discardLocalParts'),
    dir: LocalPath,
    names: z.array(z.string().min(1).max(1024)).max(500)
  })
])
export type SftpOp = z.infer<typeof SftpOp>

/** Đuôi file tải dở (ghi xong mới đổi tên) và file meta đi kèm (resume). */
export const PART_SUFFIX = '.shellhouse-part'
export const PART_META_SUFFIX = '.shellhouse-part-meta'

/** File tạm của lượt truyền dở dang — ẩn khỏi danh sách file (như file ẩn). */
export function isPartFile(name: string): boolean {
  return name.endsWith(PART_SUFFIX) || name.endsWith(PART_META_SUFFIX)
}

/** File tải dở bị bỏ lại trong thư mục trên máy (op `localParts`). */
export interface LocalPartInfo {
  /** Tên file đích (không có đuôi part). */
  name: string
  /** Đã tải được. */
  partBytes: number
  /** Kích thước đầy đủ (từ file meta), null nếu không có meta. */
  totalBytes: number | null
  /** Nguồn trên server (từ file meta). */
  remotePath: string | null
  /** Server của tab này còn đúng file nguồn đó → tiếp tục được. */
  resumable: boolean
}

/** Ghi file từ editor trong app: lớn nhất chừng này byte. */
export const MAX_WRITE_BYTES = 8 * 1024 * 1024

/** Lỗi khi lưu mà file trên server đã đổi kể từ lúc mở — renderer hỏi "ghi đè?". */
export const FILE_CHANGED = 'The file was changed on the server since you opened it'

/** Lỗi khi tải thư mục mà đích đã có thư mục cùng tên — renderer hỏi "gộp và ghi đè?". */
export const FOLDER_EXISTS = 'A folder with this name already exists at the destination'

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
  /** Lượt tải lên của tính năng sửa file (lưu trong editor → server). */
  edit?: boolean
  /** Lỗi / huỷ mà còn giữ file part: "Resume" tiếp tục từ chỗ dừng, "Discard" xoá file part. */
  resumable?: boolean
  /** Cùng một lần tải thư mục: Transfers gộp thành một dòng (hàng trăm file nhỏ không ngập danh sách). */
  batch?: TransferBatch
}

/** Nhóm lượt truyền của một lần tải thư mục. */
export interface TransferBatch {
  id: string
  /** Tên thư mục. */
  label: string
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

/** Kết quả xem trước file: phần đầu file (base64) + kích thước thật. */
export interface SftpPreview {
  path: string
  size: number
  /** Unix ms (để phát hiện file bị sửa nơi khác khi lưu). */
  mtime: number
  /** base64 của tối đa maxBytes đầu file. */
  data: string
  truncated: boolean
}
