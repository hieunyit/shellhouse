import { z } from 'zod'
import { t } from '@shared/i18n'
import type { TransferStatus } from '@shared/sftp'
import { S3CorsRules, S3LifecycleRule, MAX_LIFECYCLE_RULES, S3ObjectEdit, S3Tags } from './manage'

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

/**
 * Cảnh báo cho endpoint http:// (không mã hoá): secret key không gửi đi (chỉ dùng để ký) nhưng nội
 * dung file và link chia sẻ đi dạng rõ. Máy này / mạng nội bộ (MinIO dev) thì không cảnh báo.
 */
export function endpointWarning(endpoint: string): string | null {
  let url: URL
  try {
    url = new URL(endpoint.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  return local
    ? null
    : t(
        'This endpoint uses http:// — files and share links travel unencrypted. Use https:// if the service supports it.'
      )
}

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
  /** Bỏ qua kiểm tra chứng chỉ TLS (máy chủ tự ký / CA nội bộ). */
  insecureTls: z.boolean(),
  /** Luôn kết nối thẳng, không qua proxy của app. */
  direct: z.boolean(),
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
  forcePathStyle: z.boolean(),
  insecureTls: z.boolean().default(false),
  direct: z.boolean().default(false)
})
/** Dạng nhận vào (trường mạng có mặc định — tài khoản cũ / test không cần ghi). */
export type S3AccountInput = z.input<typeof S3AccountInput>

const Bucket = z.string().min(1).max(255)
const Key = z.string().max(1024)
const VersionId = z.string().min(1).max(1024)
const LocalPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'))

/** Editor trong app: object lớn nhất đọc / ghi được. */
export const S3_EDIT_MAX_BYTES = 8 * 1024 * 1024
/** Lưu mà object đã đổi (ETag khác) kể từ lúc mở. */
export const S3_OBJECT_CHANGED = 'The object was changed in the bucket since you opened it'

/** Việc nền: xoá / copy / move / đổi tên (op `jobStart`). */
export const S3BulkJob = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delete'), bucket: Bucket, keys: z.array(Key).min(1).max(1000) }),
  /** Copy (hoặc move) object / "thư mục" (key kết thúc "/") vào `destPrefix` của `destBucket`. */
  z.object({
    kind: z.literal('copy'),
    bucket: Bucket,
    keys: z.array(Key).min(1).max(1000),
    destBucket: Bucket,
    destPrefix: Key,
    move: z.boolean(),
    overwrite: z.boolean()
  }),
  /** Đổi tên object hoặc "thư mục" (giữ nguyên thư mục cha). */
  z.object({
    kind: z.literal('rename'),
    bucket: Bucket,
    key: Key,
    name: z.string().min(1).max(1024),
    overwrite: z.boolean()
  })
])
export type S3BulkJob = z.infer<typeof S3BulkJob>

/** Tiến độ một việc nền (op `jobPoll`). */
export interface S3JobProgress {
  phase: 'running' | 'done' | 'stopped' | 'error'
  /** Object đã liệt kê được (tổng tăng dần khi còn đang quét thư mục). */
  found: number
  /** Đã xoá / đã copy. */
  done: number
  failed: number
  /** Còn đang liệt kê (chưa biết tổng). */
  scanning: boolean
  /** Lỗi từng object (tối đa 20). */
  errors: { key: string; message: string }[]
  /** Lỗi làm dừng cả việc (trùng tên, copy vào chính nó…). */
  error: string | null
}

/** Kết quả op `uploadCheck` cho từng đường dẫn. */
export interface S3UploadConflict {
  localPath: string
  name: string
  isFolder: boolean
  /** Số file sẽ tải lên. */
  files: number
  /** Số file trùng key đã có trên bucket. */
  existing: number
}

export const S3Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('listBuckets') }),
  z.object({ op: z.literal('createBucket'), bucket: Bucket }),
  /**
   * Một "thư mục": các prefix con + object trực tiếp (tối đa S3_LIST_PAGE mục mỗi lần). `token` =
   * `nextToken` của lần trước → phần tiếp theo ("Load more").
   */
  z.object({
    op: z.literal('list'),
    bucket: Bucket,
    prefix: Key,
    token: z.string().max(2048).optional(),
    /**
     * Tìm trên server: chỉ các mục có tên BẮT ĐẦU bằng chuỗi này (S3 lọc theo prefix, phân biệt hoa
     * thường) trong `prefix`. Tên mục vẫn tính theo `prefix` — dùng được cả khi thư mục lớn hơn một trang.
     */
    search: z.string().max(1024).optional()
  }),
  /** Tạo "thư mục" = object rỗng tên kết thúc bằng "/". */
  z.object({ op: z.literal('mkdir'), bucket: Bucket, key: Key }),
  /** Xoá object; key kết thúc "/" = xoá mọi thứ dưới prefix đó (chạy rồi chờ xong — xem jobStart). */
  z.object({ op: z.literal('delete'), bucket: Bucket, keys: z.array(Key).min(1).max(1000) }),
  /**
   * Xoá / copy / move / đổi tên chạy nền (thư mục có thể rất lớn): trả về id, hỏi tiến độ bằng
   * `jobPoll`, dừng bằng `jobStop`.
   */
  z.object({ op: z.literal('jobStart'), job: S3BulkJob }),
  z.object({ op: z.literal('jobPoll'), id: z.string().max(64) }),
  z.object({ op: z.literal('jobStop'), id: z.string().max(64) }),
  /** Đếm object sẽ bị xoá (dừng ở `limit`) — cho hộp thoại xác nhận. */
  z.object({
    op: z.literal('countObjects'),
    bucket: Bucket,
    keys: z.array(Key).min(1).max(1000),
    limit: z.number().int().min(1).max(1_000_000)
  }),
  /** Trạng thái versioning của bucket (nhớ trong phiên; lỗi / không hỗ trợ → null). */
  z.object({ op: z.literal('versioning'), bucket: Bucket }),
  /** Link tải có hạn (không cần tài khoản); `versionId` = đúng phiên bản đó. */
  z.object({
    op: z.literal('presign'),
    bucket: Bucket,
    key: Key,
    versionId: VersionId.optional(),
    expiresSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 3600)
  }),
  /**
   * File hoặc thư mục trên máy → `prefix`. `overwrite: false` = bỏ qua file đã có trên bucket
   * (không có = ghi đè như trước).
   */
  z.object({
    op: z.literal('upload'),
    bucket: Bucket,
    prefix: Key,
    localPath: LocalPath,
    overwrite: z.boolean().optional()
  }),
  /** Trước khi tải lên: mỗi mục có bao nhiêu file sẽ đè lên object đã có. */
  z.object({
    op: z.literal('uploadCheck'),
    bucket: Bucket,
    prefix: Key,
    localPaths: z.array(LocalPath).min(1).max(1000)
  }),
  /**
   * Object → file; key kết thúc "/" = cả thư mục → `localPath/<tên>`. `intoFolder` (file): `localPath`
   * là thư mục, Session Host tự đặt tên file an toàn từ key (không tin tên renderer ghép).
   */
  z.object({
    op: z.literal('download'),
    bucket: Bucket,
    key: Key,
    localPath: LocalPath,
    overwrite: z.boolean(),
    intoFolder: z.boolean().optional(),
    /** Một phiên bản cũ của object (chỉ với file). */
    versionId: VersionId.optional()
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
  /** Huỷ một hoặc nhiều lượt truyền ("Cancel all" gửi một lần, không phải hàng nghìn lần). */
  z.object({
    op: z.literal('cancel'),
    transferId: z.string().max(64).optional(),
    transferIds: z.array(z.string().max(64)).max(100_000).optional()
  }),
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
    concurrency: z.number().int().min(1).max(64).optional(),
    /**
     * Số object tối đa được xoá ở đích (= số đã xem trước). Kế hoạch lúc chạy thật xoá nhiều hơn
     * (nguồn vừa bị xoá bớt…) → dừng, không xoá gì.
     */
    maxDelete: z.number().int().min(0).optional()
  }),
  z.object({ op: z.literal('syncPoll'), id: z.string().max(64) }),
  z.object({ op: z.literal('syncStop'), id: z.string().max(64) }),
  z.object({ op: z.literal('clearDone') }),

  // ---------- Quản lý bucket (xem shared/manage.ts) ----------

  /** Versioning của bucket — S3Feature (không hỗ trợ / không có quyền thì không ném lỗi). */
  z.object({ op: z.literal('getVersioning'), bucket: Bucket }),
  /** Bật (Enabled) hoặc tạm dừng (Suspended) versioning — S3 không cho tắt hẳn lại. */
  z.object({ op: z.literal('setVersioning'), bucket: Bucket, enabled: z.boolean() }),
  z.object({ op: z.literal('getLifecycle'), bucket: Bucket }),
  /** Ghi cả cấu hình lifecycle (danh sách rỗng = xoá cấu hình). */
  z.object({
    op: z.literal('putLifecycle'),
    bucket: Bucket,
    rules: z.array(S3LifecycleRule).max(MAX_LIFECYCLE_RULES)
  }),
  z.object({ op: z.literal('getCors'), bucket: Bucket }),
  /** Ghi cấu hình CORS (danh sách rỗng = xoá cấu hình). */
  z.object({ op: z.literal('putCors'), bucket: Bucket, rules: S3CorsRules }),

  // ---------- Object: chi tiết, metadata, tag, phiên bản ----------

  /** HeadObject + tag của object (hoặc một phiên bản). */
  z.object({
    op: z.literal('objectDetails'),
    bucket: Bucket,
    key: Key,
    versionId: VersionId.optional()
  }),
  /**
   * Sửa Content-Type / Cache-Control / Content-Disposition / metadata người dùng: copy object vào
   * chính nó (MetadataDirective REPLACE), giữ storage class, mã hoá và tag. `expectEtag` = object
   * phải còn đúng như lúc mở.
   */
  z.object({
    op: z.literal('updateObject'),
    bucket: Bucket,
    key: Key,
    edit: S3ObjectEdit,
    expectEtag: z.string().max(256).optional()
  }),
  /** Ghi đè toàn bộ tag của object (danh sách rỗng = bỏ hết tag). */
  z.object({
    op: z.literal('putTags'),
    bucket: Bucket,
    key: Key,
    versionId: VersionId.optional(),
    tags: S3Tags
  }),
  /**
   * Chế độ "Show versions": thư mục con + mọi phiên bản / delete marker của object trực tiếp trong
   * `prefix` (tối đa S3_LIST_PAGE mục mỗi lần; `next` → phần tiếp theo).
   */
  z.object({
    op: z.literal('listVersions'),
    bucket: Bucket,
    prefix: Key,
    keyMarker: Key.optional(),
    versionIdMarker: VersionId.optional()
  }),
  /** Mọi phiên bản của một object (bảng chi tiết) — S3Feature. */
  z.object({ op: z.literal('objectVersions'), bucket: Bucket, key: Key }),
  /** Khôi phục: copy phiên bản cũ thành bản hiện tại (bản cũ vẫn giữ trong lịch sử). */
  z.object({
    op: z.literal('restoreVersion'),
    bucket: Bucket,
    key: Key,
    versionId: VersionId
  }),
  /** Xoá vĩnh viễn từng phiên bản / delete marker (không khôi phục được). */
  z.object({
    op: z.literal('deleteVersions'),
    bucket: Bucket,
    items: z
      .array(z.object({ key: Key, versionId: VersionId }))
      .min(1)
      .max(1000)
  })
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

/** Mỗi lần liệt kê (op `list`) trả tối đa chừng này mục; thư mục lớn hơn thì "Load more". */
export const S3_LIST_PAGE = 5000

export interface S3Listing {
  bucket: string
  prefix: string
  /** Có khi liệt kê bằng `search`: chuỗi đã tìm. */
  search?: string
  entries: S3Entry[]
  /** Thư mục quá lớn: chỉ hiện phần đầu. */
  truncated: boolean
  /** Có khi `truncated`: gửi lại trong op `list` để lấy phần tiếp theo. */
  nextToken?: string
}

/** Thay đổi danh sách truyền file (Session Host → renderer, sự kiện `transfers`): chỉ phần đổi. */
export interface S3TransferDelta {
  upsert: TransferStatus[]
  remove: string[]
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
  if (!name.trim()) return t('Enter a name')
  if (name.includes('/')) return t('The name cannot contain “/”')
  if (name === '.' || name === '..') return t('Invalid name')
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
    return t('Use 3–63 lowercase letters, numbers, dots and hyphens')
  if (/\.\.|^\d+\.\d+\.\d+\.\d+$/.test(name)) return t('Invalid bucket name')
  return null
}
