import { z } from 'zod'

/**
 * Trình quản lý S3 (như S3 Browser): tài khoản S3 / tương thích S3 (MinIO, Wasabi, Cloudflare R2,
 * Ceph…), duyệt bucket + "thư mục" (prefix), tải lên / tải về, link chia sẻ có hạn.
 */

/** Endpoint: trống = AWS. Chỉ http(s), không có thông tin đăng nhập trong URL. */
const Endpoint = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    if (v === '') return true
    try {
      const u = new URL(v)
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password
    } catch {
      return false
    }
  }, 'Enter a URL like https://s3.example.com (or leave empty for AWS)')

/** Bucket hoặc "thư mục" được ghim lên thanh bên (prefix '' = cả bucket). */
export const S3Pin = z.object({
  bucket: z.string().min(1).max(255),
  prefix: z.string().max(1024)
})
export type S3Pin = z.infer<typeof S3Pin>

/** Tối đa số mục ghim mỗi tài khoản. */
export const MAX_S3_PINS = 50

export const S3AccountSummary = z.object({
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  /** Bucket dạng https://endpoint/bucket thay vì https://bucket.endpoint (MinIO, Ceph). */
  forcePathStyle: z.boolean(),
  hasSecret: z.boolean(),
  pins: z.array(S3Pin)
})
export type S3AccountSummary = z.infer<typeof S3AccountSummary>

export const S3AccountInput = z.object({
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1, 'A name is required').max(100),
  endpoint: Endpoint,
  region: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-z0-9-]*$/, 'Region looks like us-east-1'),
  accessKeyId: z.string().trim().min(1, 'Enter the access key ID').max(256),
  /** undefined = giữ secret đã lưu. */
  secretAccessKey: z.string().max(1024).optional(),
  forcePathStyle: z.boolean()
})
export type S3AccountInput = z.infer<typeof S3AccountInput>

const Bucket = z.string().min(1).max(255)
const Key = z.string().max(1024)
const LocalPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'))

/** Editor trong app: object lớn nhất đọc / ghi được. */
export const S3_EDIT_MAX_BYTES = 8 * 1024 * 1024
/** Lưu mà object đã đổi (ETag khác) kể từ lúc mở. */
export const S3_OBJECT_CHANGED = 'The object was changed in the bucket since you opened it'

export const S3Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('listBuckets') }),
  z.object({ op: z.literal('createBucket'), bucket: Bucket }),
  /** Một "thư mục": các prefix con + object trực tiếp. */
  z.object({ op: z.literal('list'), bucket: Bucket, prefix: Key }),
  /** Tạo "thư mục" = object rỗng tên kết thúc bằng "/". */
  z.object({ op: z.literal('mkdir'), bucket: Bucket, key: Key }),
  /** Xoá object; key kết thúc "/" = xoá mọi thứ dưới prefix đó. */
  z.object({ op: z.literal('delete'), bucket: Bucket, keys: z.array(Key).min(1).max(1000) }),
  /** Link tải có hạn (không cần tài khoản). */
  z.object({
    op: z.literal('presign'),
    bucket: Bucket,
    key: Key,
    expiresSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 3600)
  }),
  /** File hoặc thư mục trên máy → `prefix`. */
  z.object({ op: z.literal('upload'), bucket: Bucket, prefix: Key, localPath: LocalPath }),
  /** Object → file; key kết thúc "/" = cả thư mục → `localPath/<tên>`. */
  z.object({
    op: z.literal('download'),
    bucket: Bucket,
    key: Key,
    localPath: LocalPath,
    overwrite: z.boolean()
  }),
  /**
   * Thống kê số object + dung lượng dưới `prefix` ('' = cả bucket): chạy nền, song song nhiều
   * request; trả về id để hỏi tiến độ (`statsPoll`) hoặc dừng (`statsStop`).
   */
  z.object({ op: z.literal('statsStart'), bucket: Bucket, prefix: Key }),
  z.object({ op: z.literal('statsPoll'), id: z.string().max(64) }),
  z.object({ op: z.literal('statsStop'), id: z.string().max(64) }),
  /** Copy (hoặc move) object / "thư mục" (key kết thúc "/") vào `destPrefix` của `destBucket`. */
  z.object({
    op: z.literal('copy'),
    bucket: Bucket,
    keys: z.array(Key).min(1).max(1000),
    destBucket: Bucket,
    destPrefix: Key,
    move: z.boolean(),
    overwrite: z.boolean()
  }),
  /** Đổi tên object hoặc "thư mục" (giữ nguyên thư mục cha). */
  z.object({
    op: z.literal('rename'),
    bucket: Bucket,
    key: Key,
    name: z.string().min(1).max(1024),
    overwrite: z.boolean()
  }),
  /** Tải object về `localPath` rồi theo dõi: lưu trong editor → tải lên đè (nếu server chưa đổi). */
  z.object({ op: z.literal('edit'), bucket: Bucket, key: Key, localPath: LocalPath }),
  /** Editor trong app: đọc nội dung object (≤ S3_EDIT_MAX_BYTES) kèm ETag. */
  z.object({ op: z.literal('readText'), bucket: Bucket, key: Key }),
  /**
   * Editor trong app: ghi đè object, giữ Content-Type / metadata. `expectEtag` = object phải còn
   * đúng như lúc mở, khác → lỗi S3_OBJECT_CHANGED.
   */
  z.object({
    op: z.literal('writeText'),
    bucket: Bucket,
    key: Key,
    data: z.string().max(Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4),
    expectEtag: z.string().max(256).optional()
  }),
  z.object({ op: z.literal('cancel'), transferId: z.string().max(64) }),
  /** Bucket của một tài khoản khác (đích đồng bộ). */
  z.object({ op: z.literal('listBucketsOf'), accountId: z.string().min(1).max(64) }),
  /** Region, versioning, mã hoá của một bucket (lỗi / không hỗ trợ → null). */
  z.object({ op: z.literal('bucketInfo'), bucket: Bucket }),
  /** Ghi file người dùng vừa chọn trong hộp Save (export danh sách bucket). */
  z.object({
    op: z.literal('writeFile'),
    localPath: LocalPath,
    content: z.string().max(50 * 1024 * 1024)
  }),
  /**
   * Đồng bộ `bucket/prefix` → `dest` (cùng hoặc khác tài khoản). Chạy nền; `dryRun` chỉ quét và
   * lập kế hoạch. Hỏi tiến độ bằng `syncPoll`, dừng bằng `syncStop`.
   */
  z.object({
    op: z.literal('syncStart'),
    bucket: Bucket,
    prefix: Key,
    dest: z.object({
      /** Không có = cùng tài khoản. */
      accountId: z.string().min(1).max(64).optional(),
      bucket: Bucket,
      prefix: Key
    }),
    /** Xoá ở đích những object không còn ở nguồn. */
    mirror: z.boolean(),
    compare: z.enum(['size', 'etag']),
    createBucket: z.boolean(),
    dryRun: z.boolean(),
    /** Số object chép cùng lúc; không có = theo cài đặt (Settings → Modules → S3). */
    concurrency: z.number().int().min(1).max(64).optional()
  }),
  z.object({ op: z.literal('syncPoll'), id: z.string().max(64) }),
  z.object({ op: z.literal('syncStop'), id: z.string().max(64) }),
  z.object({ op: z.literal('clearDone') })
])
export type S3Op = z.infer<typeof S3Op>

/** Thông tin thêm của bucket (cho export). null = không lấy được / dịch vụ không hỗ trợ. */
export interface S3BucketInfo {
  region: string | null
  versioning: 'Enabled' | 'Suspended' | 'Off' | null
  encryption: string | null
}

export type SyncAction = 'new' | 'update' | 'delete'

/** Tiến độ một lượt đồng bộ (op `syncPoll`). */
export interface S3SyncProgress {
  phase: 'scanning' | 'planned' | 'copying' | 'deleting' | 'done' | 'stopped' | 'error'
  dryRun: boolean
  /** Copy phía server (cùng tài khoản) hay truyền qua máy này. */
  serverSide: boolean
  scanned: { source: number; dest: number }
  plan: { new: number; update: number; delete: number; same: number; bytes: number }
  done: { copied: number; deleted: number; bytes: number; failed: number }
  /** Tốc độ đã làm mượt (trung bình trượt), 0 khi không có byte nào vài giây. */
  bytesPerSecond: number
  /** Số object chép cùng lúc của lượt này. */
  concurrency: number
  /** Object đang chép (tối đa 8) — key, dung lượng, đã chép bao nhiêu byte. */
  active: { key: string; size: number; done: number }[]
  /** Vài trăm mục đầu của kế hoạch (để xem trước). */
  sample: { key: string; action: SyncAction; size: number }[]
  /** Lỗi của từng object (tối đa 50) — lượt đồng bộ vẫn chạy tiếp. */
  errors: { key: string; message: string }[]
  /** Lỗi làm dừng cả lượt. */
  error: string | null
}

export interface S3Bucket {
  name: string
  createdAt: number | null
  /** Region (AWS trả về trong ListBuckets; MinIO/R2… thường không có). */
  region: string | null
}

/** Tên hiển thị của một mục ghim: "bucket" hoặc "bucket / a / b". */
export function pinLabel(pin: S3Pin): string {
  return [pin.bucket, ...pin.prefix.split('/').filter(Boolean)].join(' / ')
}

export interface S3Entry {
  /** Tên hiển thị (không gồm prefix cha; thư mục có "/" ở cuối bị bỏ). */
  name: string
  key: string
  isFolder: boolean
  size: number
  modified: number | null
  storageClass: string | null
}

export interface S3Listing {
  bucket: string
  prefix: string
  entries: S3Entry[]
  /** Thư mục quá lớn: chỉ hiện phần đầu. */
  truncated: boolean
}

/** Số object + dung lượng (tổng và theo storage class: STANDARD, GLACIER…). */
export interface S3Stats {
  objects: number
  bytes: number
  byClass: Record<string, { objects: number; bytes: number }>
}

/** Tiến độ một lượt thống kê (op `statsPoll`). */
export interface S3StatsProgress extends S3Stats {
  done: boolean
  error: string | null
}

export const EMPTY_STATS: S3Stats = { objects: 0, bytes: 0, byClass: {} }

/** Cộng hai kết quả thống kê. */
export function addStats(a: S3Stats, b: S3Stats): S3Stats {
  const byClass = { ...a.byClass }
  for (const [cls, v] of Object.entries(b.byClass)) {
    const cur = byClass[cls] ?? { objects: 0, bytes: 0 }
    byClass[cls] = { objects: cur.objects + v.objects, bytes: cur.bytes + v.bytes }
  }
  return { objects: a.objects + b.objects, bytes: a.bytes + b.bytes, byClass }
}

/** Tên mới cho đổi tên: không rỗng, không có "/". */
export function objectNameProblem(name: string): string | null {
  if (!name.trim()) return 'Enter a name'
  if (name.includes('/')) return 'The name cannot contain “/”'
  if (name === '.' || name === '..') return 'Invalid name'
  return null
}

/** Prefix cha: "a/b/c/" → "a/b/"; "a/" → "". */
export function parentPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/$/, '')
  const i = trimmed.lastIndexOf('/')
  return i === -1 ? '' : trimmed.slice(0, i + 1)
}

/** Tên bucket S3 hợp lệ (3–63 ký tự, chữ thường, số, "." và "-"). */
export function bucketNameProblem(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name))
    return 'Use 3–63 lowercase letters, numbers, dots and hyphens'
  if (/\.\.|^\d+\.\d+\.\d+\.\d+$/.test(name)) return 'Invalid bucket name'
  return null
}
