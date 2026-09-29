import { z } from 'zod'

/** Một thư mục trên máy (khung "Local" của trình quản lý file SFTP hai cột). */
export const LocalListing = z.object({
  path: z.string(),
  /** null = gốc ổ đĩa. */
  parent: z.string().nullable(),
  /** Dấu phân cách của hệ điều hành ('\\' trên Windows). */
  sep: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      isDir: z.boolean(),
      size: z.number(),
      mtime: z.number()
    })
  ),
  /** Thư mục quá lớn, chỉ hiện một phần. */
  truncated: z.boolean()
})
export type LocalListing = z.infer<typeof LocalListing>

/** Nối đường dẫn trên máy bằng dấu phân cách main báo về. */
export function joinLocal(dir: string, name: string, sep: string): string {
  return dir.endsWith(sep) || dir.endsWith('/') ? `${dir}${name}` : `${dir}${sep}${name}`
}

/** Kiểu dữ liệu kéo thả giữa hai khung. */
export const DRAG_LOCAL = 'application/x-shellhouse-local'
export const DRAG_REMOTE = 'application/x-shellhouse-remote'
