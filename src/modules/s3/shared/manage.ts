import { z } from 'zod'
import { t } from '@shared/i18n'

/**
 * Quản lý nâng cao của bucket / object: versioning, lifecycle, CORS, metadata, tag, phiên bản
 * object. Nhiều dịch vụ tương thích S3 chỉ hỗ trợ một phần (Cloudflare R2 không có versioning,
 * MinIO một ổ đĩa không bật được versioning…) — đọc trả về `S3Feature` thay vì ném lỗi, giao diện
 * hiện "Not supported by this provider".
 */

/** Một cấu hình có thể không được dịch vụ hỗ trợ / không có quyền đọc. */
export type S3Feature<T> =
  | { state: 'ok'; value: T }
  | { state: 'unsupported' }
  | { state: 'denied' }
  | { state: 'error'; message: string }

export type S3Versioning = 'Enabled' | 'Suspended' | 'Off'

// ---------- Tag ----------

export const S3Tag = z.object({ key: z.string().min(1).max(128), value: z.string().max(256) })
export type S3Tag = z.infer<typeof S3Tag>
/** S3 cho tối đa 10 tag mỗi object. */
export const MAX_S3_TAGS = 10
export const S3Tags = z.array(S3Tag).max(MAX_S3_TAGS)

/** Lỗi đầu tiên của danh sách tag đang sửa (null = hợp lệ). */
export function tagsProblem(tags: readonly S3Tag[]): string | null {
  if (tags.length > MAX_S3_TAGS) return t('An object can have at most {n} tags', { n: MAX_S3_TAGS })
  const seen = new Set<string>()
  for (const tag of tags) {
    if (!tag.key.trim()) return t('Every tag needs a key')
    if (tag.key.length > 128) return t('Tag keys can be at most 128 characters')
    if (tag.value.length > 256) return t('Tag values can be at most 256 characters')
    if (seen.has(tag.key)) return t('The tag key “{key}” is used twice', { key: tag.key })
    seen.add(tag.key)
  }
  return null
}

// ---------- Metadata ----------

/** Metadata người dùng (x-amz-meta-*): tổng tối đa 2 KB. */
export const MAX_S3_METADATA_BYTES = 2048

export const S3MetaEntry = z.object({
  key: z.string().min(1).max(256),
  value: z.string().max(2048)
})
export type S3MetaEntry = z.infer<typeof S3MetaEntry>

/** Phần sửa được của object (CopyObject vào chính nó, MetadataDirective REPLACE). */
export const S3ObjectEdit = z.object({
  contentType: z.string().max(256),
  cacheControl: z.string().max(1024),
  contentDisposition: z.string().max(1024),
  metadata: z.array(S3MetaEntry).max(100)
})
export type S3ObjectEdit = z.infer<typeof S3ObjectEdit>

/** Ký tự hợp lệ trong tên header (key metadata đi thành x-amz-meta-<key>). */
const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
/** Giá trị header: ASCII in được (S3 không giữ đúng ký tự ngoài ASCII trong metadata). */
const HEADER_VALUE = /^[\x20-\x7e]*$/

/** Lỗi đầu tiên của phần sửa metadata (null = hợp lệ). */
export function objectEditProblem(edit: S3ObjectEdit): string | null {
  for (const [label, value] of [
    ['Content-Type', edit.contentType],
    ['Cache-Control', edit.cacheControl],
    ['Content-Disposition', edit.contentDisposition]
  ] as const)
    if (!HEADER_VALUE.test(value))
      return t('{name} can only contain plain ASCII characters', { name: label })
  const seen = new Set<string>()
  let bytes = 0
  for (const m of edit.metadata) {
    const key = m.key.trim().toLowerCase()
    if (!key) return t('Every metadata entry needs a key')
    if (!HEADER_TOKEN.test(key))
      return t('The metadata key “{key}” can only use letters, numbers and - _ .', { key: m.key })
    if (!HEADER_VALUE.test(m.value))
      return t('The value of “{key}” can only contain plain ASCII characters', { key: m.key })
    if (seen.has(key)) return t('The metadata key “{key}” is used twice', { key })
    seen.add(key)
    bytes += key.length + m.value.length
  }
  if (bytes > MAX_S3_METADATA_BYTES) return t('User metadata is limited to 2 KB in total')
  return null
}

/** Thông tin chi tiết một object (HeadObject + tag). */
export interface S3ObjectDetails {
  bucket: string
  key: string
  versionId: string | null
  size: number
  etag: string | null
  lastModified: number | null
  contentType: string | null
  cacheControl: string | null
  contentDisposition: string | null
  contentEncoding: string | null
  contentLanguage: string | null
  /** HEAD không trả STANDARD → ghi rõ "STANDARD". */
  storageClass: string
  /** "AES256", "aws:kms (key)"… null = không mã hoá / dịch vụ không báo. */
  encryption: string | null
  /** Object lưu trữ (Glacier): trạng thái khôi phục (header x-amz-restore). */
  restore: string | null
  metadata: Record<string, string>
  tags: S3Feature<S3Tag[]>
}

// ---------- Phiên bản object ----------

export interface S3Version {
  key: string
  /** Tên hiển thị (không gồm prefix cha). */
  name: string
  versionId: string
  isLatest: boolean
  deleteMarker: boolean
  size: number
  modified: number | null
  etag: string | null
  storageClass: string | null
}

/** Một "thư mục" ở chế độ xem phiên bản: thư mục con + mọi phiên bản của object trực tiếp. */
export interface S3VersionListing {
  bucket: string
  prefix: string
  folders: { name: string; key: string }[]
  versions: S3Version[]
  truncated: boolean
  /** Có khi `truncated`: gửi lại trong op `listVersions` để lấy phần tiếp theo. */
  next?: { keyMarker: string; versionIdMarker: string }
}

/** Khoá chọn của một phiên bản trong danh sách (key + versionId). */
export function versionRef(v: { key: string; versionId: string }): string {
  return `${v.key}\u0000${v.versionId}`
}

/** Version ID ngắn để hiện ("null" của object trước khi bật versioning giữ nguyên). */
export function shortVersionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id
}

// ---------- Lifecycle ----------

const Days = z.number().int().min(1).max(36_500)

/**
 * Một rule lifecycle ở dạng giao diện sửa được: lọc theo prefix, hết hạn bản hiện tại / bản cũ,
 * huỷ multipart dở dang. Rule có phần Shellhouse không mô tả (chuyển lớp lưu trữ, lọc theo tag,
 * ngày cố định…) giữ nguyên bản gốc trong `raw` và chỉ bật / tắt hoặc xoá được.
 */
export const S3LifecycleRule = z.object({
  id: z.string().max(255),
  enabled: z.boolean(),
  prefix: z.string().max(1024),
  expireDays: Days.nullable(),
  noncurrentDays: Days.nullable(),
  abortMultipartDays: Days.nullable(),
  /** Tên các phần không sửa được ở đây ("Transitions", "Tag filter"…). */
  extra: z.array(z.string().max(100)).max(20),
  /** JSON của rule gốc khi có `extra` — gửi lại nguyên vẹn khi lưu. */
  raw: z.string().max(20_000).nullable()
})
export type S3LifecycleRule = z.infer<typeof S3LifecycleRule>
export const MAX_LIFECYCLE_RULES = 1000

/** Rule mới từ form "Add rule". */
export function newLifecycleRule(input: {
  id: string
  prefix: string
  expireDays: number | null
  noncurrentDays: number | null
  abortMultipartDays: number | null
}): S3LifecycleRule {
  return { ...input, enabled: true, extra: [], raw: null }
}

/** Lỗi của rule đang thêm (null = hợp lệ). */
export function lifecycleRuleProblem(
  rule: Pick<
    S3LifecycleRule,
    'id' | 'prefix' | 'expireDays' | 'noncurrentDays' | 'abortMultipartDays'
  >,
  existing: readonly S3LifecycleRule[]
): string | null {
  if (rule.id.length > 255) return t('The rule name can be at most 255 characters')
  if (rule.id && existing.some((r) => r.id === rule.id))
    return t('A rule named “{name}” already exists', { name: rule.id })
  if (rule.prefix.startsWith('/')) return t('The prefix cannot start with “/”')
  const days = [rule.expireDays, rule.noncurrentDays, rule.abortMultipartDays]
  if (days.every((d) => d === null)) return t('Choose at least one action')
  if (days.some((d) => d !== null && (!Number.isInteger(d) || d < 1 || d > 36_500)))
    return t('Days must be a whole number from 1 to 36500')
  return null
}

/** Id tự đặt cho rule mới chưa có tên: "expire-logs" / "rule-3". */
export function suggestRuleId(prefix: string, existing: readonly S3LifecycleRule[]): string {
  const base =
    prefix
      .replace(/\/+$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'all-objects'
  const taken = new Set(existing.map((r) => r.id))
  let id = `shellhouse-${base}`
  for (let n = 2; taken.has(id); n++) id = `shellhouse-${base}-${String(n)}`
  return id
}

// ---------- CORS ----------

export const S3CorsRule = z
  .object({
    ID: z.string().max(255).optional(),
    AllowedMethods: z.array(z.enum(['GET', 'PUT', 'POST', 'DELETE', 'HEAD'])).min(1),
    AllowedOrigins: z.array(z.string().min(1).max(1024)).min(1),
    AllowedHeaders: z.array(z.string().max(1024)).optional(),
    ExposeHeaders: z.array(z.string().max(1024)).optional(),
    MaxAgeSeconds: z.number().int().min(0).optional()
  })
  .strict()
export type S3CorsRule = z.infer<typeof S3CorsRule>
export const S3CorsRules = z.array(S3CorsRule).max(100)

/** Mẫu cho ô CORS trống: cho phép mọi trang web tải object (GET / HEAD). */
export const CORS_TEMPLATE: S3CorsRule[] = [
  {
    AllowedHeaders: ['*'],
    AllowedMethods: ['GET', 'HEAD'],
    AllowedOrigins: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3000
  }
]

/** JSON trong ô CORS → danh sách rule, hoặc câu báo lỗi (chỗ sai). Ô trống = không có CORS. */
export function parseCorsJson(
  text: string
): { ok: true; rules: S3CorsRule[] } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, rules: [] }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return {
      ok: false,
      error: t('Not valid JSON: {message}', { message: e instanceof Error ? e.message : String(e) })
    }
  }
  // Dán nguyên cấu hình từ AWS CLI ({ "CORSRules": [...] }) cũng được.
  if (json && typeof json === 'object' && !Array.isArray(json) && 'CORSRules' in json)
    json = json.CORSRules
  const parsed = S3CorsRules.safeParse(json)
  if (parsed.success) return { ok: true, rules: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue?.path.length ? issue.path.join('.') : ''
  return {
    ok: false,
    error: where
      ? t('{path}: {message}', { path: where, message: issue?.message ?? '' })
      : (issue?.message ?? t('Invalid CORS configuration'))
  }
}

// ---------- Link chia sẻ ----------

/** Link chia sẻ (presigned URL) dài nhất S3 cho phép: 7 ngày. */
export const MAX_LINK_SECONDS = 7 * 24 * 3600
const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86_400 } as const
export type LinkUnit = keyof typeof UNIT_SECONDS

/** Số + đơn vị trong ô "Custom" → giây; ngoài 1 phút – 7 ngày → null. */
export function shareLinkSeconds(amount: string, unit: LinkUnit): number | null {
  const n = Number(amount)
  if (!amount.trim() || !Number.isFinite(n) || n <= 0) return null
  const seconds = Math.round(n * UNIT_SECONDS[unit])
  return seconds >= 60 && seconds <= MAX_LINK_SECONDS ? seconds : null
}

// ---------- Địa chỉ object ----------

/**
 * URL HTTPS (hoặc http của endpoint tự đặt) của object — địa chỉ công khai, chỉ mở được khi object /
 * bucket cho đọc công khai (không thì dùng link chia sẻ). AWS: virtual-hosted theo region của bucket.
 */
export function objectHttpUrl(
  account: { endpoint: string; region: string; forcePathStyle: boolean },
  bucket: string,
  key: string,
  bucketRegion?: string | null
): string {
  const path = key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  if (!account.endpoint) {
    const region = bucketRegion || account.region || 'us-east-1'
    // Tên bucket có "." không hợp với chứng chỉ *.s3… → dạng path.
    return bucket.includes('.')
      ? `https://s3.${region}.amazonaws.com/${bucket}/${path}`
      : `https://${bucket}.s3.${region}.amazonaws.com/${path}`
  }
  let url: URL
  try {
    url = new URL(account.endpoint)
  } catch {
    return `${account.endpoint.replace(/\/+$/, '')}/${bucket}/${path}`
  }
  const base = url.pathname.replace(/\/+$/, '')
  return account.forcePathStyle
    ? `${url.protocol}//${url.host}${base}/${bucket}/${path}`
    : `${url.protocol}//${bucket}.${url.host}${base}/${path}`
}
