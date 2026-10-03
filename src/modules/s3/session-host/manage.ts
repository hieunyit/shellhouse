import {
  DeleteBucketCorsCommand,
  DeleteBucketLifecycleCommand,
  DeleteObjectsCommand,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutObjectTaggingCommand,
  type HeadObjectCommandOutput,
  type LifecycleRule,
  type S3Client
} from '@aws-sdk/client-s3'
import { t, tn } from '@shared/i18n'
import { S3_LIST_PAGE, S3_OBJECT_CHANGED, type S3Op } from '../shared/ops'
import type {
  S3CorsRule,
  S3Feature,
  S3LifecycleRule,
  S3ObjectDetails,
  S3ObjectEdit,
  S3Tag,
  S3Version,
  S3VersionListing,
  S3Versioning
} from '../shared/manage'
import {
  errorCode,
  errorText,
  isAccessDenied,
  isPreconditionFailed,
  isUnsupported,
  serverCopy,
  type CopyOptions
} from './client'

/**
 * Quản lý nâng cao (versioning, lifecycle, CORS, metadata, tag, phiên bản object) — hàm thuần nhận
 * client đúng region của bucket, S3Service chỉ chuyển op sang đây.
 */

/** Đọc một cấu hình: không hỗ trợ / không có quyền → trạng thái thay vì lỗi. `empty` = mã "chưa cấu hình". */
export async function feature<T>(
  read: () => Promise<T>,
  empty?: { codes: readonly string[]; value: T }
): Promise<S3Feature<T>> {
  try {
    return { state: 'ok', value: await read() }
  } catch (error) {
    const code = errorCode(error)
    if (empty && code && empty.codes.includes(code)) return { state: 'ok', value: empty.value }
    if (isUnsupported(error)) return { state: 'unsupported' }
    if (isAccessDenied(error)) return { state: 'denied' }
    return { state: 'error', message: errorText(error) }
  }
}

// ---------- Versioning ----------

export function readVersioning(client: S3Client, bucket: string): Promise<S3Feature<S3Versioning>> {
  return feature(async () => {
    const out = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }))
    return out.Status === 'Enabled' || out.Status === 'Suspended' ? out.Status : 'Off'
  })
}

export async function writeVersioning(
  client: S3Client,
  bucket: string,
  enabled: boolean
): Promise<void> {
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: enabled ? 'Enabled' : 'Suspended' }
    })
  )
}

// ---------- Lifecycle ----------

/** Rule của SDK → dạng sửa được; phần không mô tả được thì giữ `raw`. */
export function fromSdkRule(rule: LifecycleRule, index: number): S3LifecycleRule {
  const extra: string[] = []
  const filter = rule.Filter
  // Rule kiểu cũ (Prefix ngay trong rule, trước khi có Filter) — vẫn gặp ở bucket lâu năm.
  let prefix = (rule as { Prefix?: string }).Prefix ?? ''
  if (filter) {
    if (filter.Prefix !== undefined) prefix = filter.Prefix
    if (filter.Tag) extra.push(t('Tag filter'))
    if (filter.And) extra.push(t('Combined filter'))
    if (filter.ObjectSizeGreaterThan !== undefined || filter.ObjectSizeLessThan !== undefined)
      extra.push(t('Size filter'))
  }
  if (rule.Expiration?.Date) extra.push(t('Expiration date'))
  if (rule.Expiration?.ExpiredObjectDeleteMarker) extra.push(t('Remove expired delete markers'))
  if (rule.Transitions?.length) extra.push(t('Storage class transitions'))
  if (rule.NoncurrentVersionTransitions?.length) extra.push(t('Noncurrent version transitions'))
  if (rule.NoncurrentVersionExpiration?.NewerNoncurrentVersions !== undefined)
    extra.push(t('Keep newer noncurrent versions'))
  return {
    id: rule.ID ?? `rule-${String(index + 1)}`,
    enabled: rule.Status === 'Enabled',
    prefix,
    expireDays: rule.Expiration?.Days ?? null,
    noncurrentDays: rule.NoncurrentVersionExpiration?.NoncurrentDays ?? null,
    abortMultipartDays: rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
    extra,
    raw: extra.length ? JSON.stringify(rule) : null
  }
}

/** Dạng sửa được → rule của SDK (rule `raw` gửi lại nguyên vẹn, chỉ đổi Status). */
export function toSdkRule(rule: S3LifecycleRule): LifecycleRule {
  const status = rule.enabled ? 'Enabled' : 'Disabled'
  if (rule.raw) {
    const raw = JSON.parse(rule.raw) as LifecycleRule
    // JSON làm mất kiểu Date — SDK cần Date để ghi đúng định dạng.
    if (raw.Expiration?.Date) raw.Expiration.Date = new Date(raw.Expiration.Date)
    for (const tr of raw.Transitions ?? []) if (tr.Date) tr.Date = new Date(tr.Date)
    return { ...raw, Status: status }
  }
  return {
    ...(rule.id ? { ID: rule.id } : {}),
    Status: status,
    Filter: { Prefix: rule.prefix },
    ...(rule.expireDays !== null ? { Expiration: { Days: rule.expireDays } } : {}),
    ...(rule.noncurrentDays !== null
      ? { NoncurrentVersionExpiration: { NoncurrentDays: rule.noncurrentDays } }
      : {}),
    ...(rule.abortMultipartDays !== null
      ? { AbortIncompleteMultipartUpload: { DaysAfterInitiation: rule.abortMultipartDays } }
      : {})
  }
}

export function readLifecycle(
  client: S3Client,
  bucket: string
): Promise<S3Feature<S3LifecycleRule[]>> {
  return feature(
    async () => {
      const out = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))
      return (out.Rules ?? []).map(fromSdkRule)
    },
    { codes: ['NoSuchLifecycleConfiguration'], value: [] }
  )
}

export async function writeLifecycle(
  client: S3Client,
  bucket: string,
  rules: readonly S3LifecycleRule[]
): Promise<void> {
  if (rules.length === 0) {
    await client.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }))
    return
  }
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: rules.map(toSdkRule) }
    })
  )
}

// ---------- CORS ----------

export function readCors(client: S3Client, bucket: string): Promise<S3Feature<S3CorsRule[]>> {
  return feature(
    async () => {
      const out = await client.send(new GetBucketCorsCommand({ Bucket: bucket }))
      return (out.CORSRules ?? []).map((r) => {
        const rule: S3CorsRule = {
          ...(r.ID ? { ID: r.ID } : {}),
          AllowedMethods: (r.AllowedMethods ?? []) as S3CorsRule['AllowedMethods'],
          AllowedOrigins: r.AllowedOrigins ?? []
        }
        if (r.AllowedHeaders?.length) rule.AllowedHeaders = r.AllowedHeaders
        if (r.ExposeHeaders?.length) rule.ExposeHeaders = r.ExposeHeaders
        if (r.MaxAgeSeconds !== undefined) rule.MaxAgeSeconds = r.MaxAgeSeconds
        return rule
      })
    },
    { codes: ['NoSuchCORSConfiguration'], value: [] }
  )
}

export async function writeCors(
  client: S3Client,
  bucket: string,
  rules: readonly S3CorsRule[]
): Promise<void> {
  if (rules.length === 0) {
    await client.send(new DeleteBucketCorsCommand({ Bucket: bucket }))
    return
  }
  await client.send(
    new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: [...rules] } })
  )
}

// ---------- Chi tiết object, metadata, tag ----------

function encryptionLabel(head: HeadObjectCommandOutput): string | null {
  if (!head.ServerSideEncryption) return null
  return head.SSEKMSKeyId
    ? `${head.ServerSideEncryption} (${head.SSEKMSKeyId})`
    : head.ServerSideEncryption
}

export function readTags(
  client: S3Client,
  bucket: string,
  key: string,
  versionId?: string
): Promise<S3Feature<S3Tag[]>> {
  return feature(
    async () => {
      const out = await client.send(
        new GetObjectTaggingCommand({ Bucket: bucket, Key: key, VersionId: versionId })
      )
      return (out.TagSet ?? []).map((tag) => ({ key: tag.Key ?? '', value: tag.Value ?? '' }))
    },
    { codes: ['NoSuchTagSet', 'NoSuchTagSetError'], value: [] }
  )
}

export async function objectDetails(
  client: S3Client,
  bucket: string,
  key: string,
  versionId?: string
): Promise<S3ObjectDetails> {
  const [head, tags] = await Promise.all([
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId })),
    readTags(client, bucket, key, versionId)
  ])
  return {
    bucket,
    key,
    versionId: head.VersionId ?? versionId ?? null,
    size: head.ContentLength ?? 0,
    etag: head.ETag ?? null,
    lastModified: head.LastModified?.getTime() ?? null,
    contentType: head.ContentType ?? null,
    cacheControl: head.CacheControl ?? null,
    contentDisposition: head.ContentDisposition ?? null,
    contentEncoding: head.ContentEncoding ?? null,
    contentLanguage: head.ContentLanguage ?? null,
    storageClass: head.StorageClass ?? 'STANDARD',
    encryption: encryptionLabel(head),
    restore: head.Restore ?? null,
    metadata: head.Metadata ?? {},
    tags
  }
}

/** Lớp lưu trữ + mã hoá của nguồn cần giữ khi copy (CopyObject mặc định bỏ cả hai). */
export function keepStorage(head: HeadObjectCommandOutput): NonNullable<CopyOptions['keep']> {
  return {
    ...(head.StorageClass && head.StorageClass !== 'STANDARD'
      ? { StorageClass: head.StorageClass }
      : {}),
    ...(head.ServerSideEncryption === 'aws:kms' || head.ServerSideEncryption === 'aws:kms:dsse'
      ? {
          ServerSideEncryption: head.ServerSideEncryption,
          ...(head.SSEKMSKeyId ? { SSEKMSKeyId: head.SSEKMSKeyId } : {})
        }
      : head.ServerSideEncryption === 'AES256'
        ? { ServerSideEncryption: 'AES256' as const }
        : {})
  }
}

/** Phần sửa của người dùng → thuộc tính ghi khi copy REPLACE (giữ Content-Encoding / Language cũ). */
export function replacedAttributes(
  head: HeadObjectCommandOutput,
  edit: S3ObjectEdit
): NonNullable<CopyOptions['replace']> {
  const metadata: Record<string, string> = {}
  for (const m of edit.metadata) metadata[m.key.trim().toLowerCase()] = m.value
  return {
    ...(edit.contentType.trim() ? { ContentType: edit.contentType.trim() } : {}),
    ...(edit.cacheControl.trim() ? { CacheControl: edit.cacheControl.trim() } : {}),
    ...(edit.contentDisposition.trim()
      ? { ContentDisposition: edit.contentDisposition.trim() }
      : {}),
    ...(head.ContentEncoding ? { ContentEncoding: head.ContentEncoding } : {}),
    ...(head.ContentLanguage ? { ContentLanguage: head.ContentLanguage } : {}),
    Metadata: metadata
  }
}

/** Object lớn hơn chừng này copy từng phần — tag không tự đi theo, phải ghi lại. */
const MULTIPART_COPY_FROM = 5 * 1024 ** 3

/**
 * Sửa metadata: copy object vào chính nó (REPLACE). Kiểm tra ETag (nếu có) bằng HEAD và bằng
 * CopySourceIfMatch — người khác ghi đè giữa chừng thì báo S3_OBJECT_CHANGED, không ghi.
 */
export async function updateObject(
  client: S3Client,
  bucket: string,
  key: string,
  edit: S3ObjectEdit,
  expectEtag?: string
): Promise<S3ObjectDetails> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  if (expectEtag && head.ETag !== expectEtag) throw new Error(t(S3_OBJECT_CHANGED))
  const size = head.ContentLength ?? 0
  // Copy từng phần không mang theo tag: đọc trước, ghi lại sau.
  const tags = size > MULTIPART_COPY_FROM ? await readTags(client, bucket, key) : null
  try {
    await serverCopy(client, { bucket, key }, { bucket, key }, size, undefined, {
      replace: replacedAttributes(head, edit),
      keep: keepStorage(head),
      ...(head.ETag ? { ifMatch: head.ETag } : {})
    })
  } catch (error) {
    if (isPreconditionFailed(error)) throw new Error(t(S3_OBJECT_CHANGED), { cause: error })
    throw error
  }
  if (tags?.state === 'ok' && tags.value.length) await writeTags(client, bucket, key, tags.value)
  return objectDetails(client, bucket, key)
}

export async function writeTags(
  client: S3Client,
  bucket: string,
  key: string,
  tags: readonly S3Tag[],
  versionId?: string
): Promise<void> {
  await client.send(
    new PutObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
      Tagging: { TagSet: tags.map((tag) => ({ Key: tag.key, Value: tag.value })) }
    })
  )
}

// ---------- Phiên bản object ----------

interface RawVersion {
  Key?: string
  VersionId?: string
  IsLatest?: boolean
  LastModified?: Date
  Size?: number
  ETag?: string
  StorageClass?: string
}

function toVersion(v: RawVersion, prefix: string, deleteMarker: boolean): S3Version | null {
  if (!v.Key) return null
  return {
    key: v.Key,
    name: v.Key.slice(prefix.length),
    versionId: v.VersionId ?? 'null',
    isLatest: v.IsLatest ?? false,
    deleteMarker,
    size: deleteMarker ? 0 : (v.Size ?? 0),
    modified: v.LastModified?.getTime() ?? null,
    etag: deleteMarker ? null : (v.ETag ?? null),
    storageClass: deleteMarker ? null : (v.StorageClass ?? null)
  }
}

/** Mới nhất trước trong cùng một key (S3 trả phiên bản và delete marker thành hai danh sách). */
export function sortVersions(list: S3Version[]): S3Version[] {
  return list.sort((a, b) =>
    a.key !== b.key
      ? a.key < b.key
        ? -1
        : 1
      : a.isLatest !== b.isLatest
        ? a.isLatest
          ? -1
          : 1
        : (b.modified ?? 0) - (a.modified ?? 0)
  )
}

/** Chế độ "Show versions" của một thư mục (xem op `listVersions`). */
export async function listVersions(
  client: S3Client,
  op: Extract<S3Op, { op: 'listVersions' }>
): Promise<S3VersionListing> {
  const { bucket, prefix } = op
  const folders: S3VersionListing['folders'] = []
  const versions: S3Version[] = []
  let keyMarker = op.keyMarker
  let versionIdMarker = op.versionIdMarker
  let truncated = false
  for (;;) {
    const out = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(keyMarker && versionIdMarker ? { VersionIdMarker: versionIdMarker } : {})
      })
    )
    for (const p of out.CommonPrefixes ?? [])
      if (p.Prefix && !folders.some((f) => f.key === p.Prefix))
        folders.push({ name: p.Prefix.slice(prefix.length).replace(/\/$/, ''), key: p.Prefix })
    for (const v of out.Versions ?? []) {
      // Object "thư mục" của chính prefix này (New folder) — không hiện.
      if (v.Key === prefix) continue
      const item = toVersion(v, prefix, false)
      if (item) versions.push(item)
    }
    for (const m of out.DeleteMarkers ?? []) {
      if (m.Key === prefix) continue
      const item = toVersion(m, prefix, true)
      if (item) versions.push(item)
    }
    const more = !!out.IsTruncated && !!out.NextKeyMarker
    keyMarker = out.NextKeyMarker
    versionIdMarker = out.NextVersionIdMarker
    if (!more) break
    if (versions.length + folders.length >= S3_LIST_PAGE) {
      truncated = true
      break
    }
  }
  return {
    bucket,
    prefix,
    folders: folders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    versions: sortVersions(versions),
    truncated,
    ...(truncated && keyMarker
      ? { next: { keyMarker, versionIdMarker: versionIdMarker ?? '' } }
      : {})
  }
}

/** Phiên bản tối đa hiện trong bảng chi tiết một object. */
const MAX_OBJECT_VERSIONS = 1000

/** Mọi phiên bản của đúng một key (Prefix = key, bỏ các key dài hơn cùng đầu). */
export function objectVersions(
  client: S3Client,
  bucket: string,
  key: string
): Promise<S3Feature<S3Version[]>> {
  return feature(async () => {
    const list: S3Version[] = []
    let keyMarker: string | undefined
    let versionIdMarker: string | undefined
    const parent = key.slice(0, key.lastIndexOf('/') + 1)
    for (;;) {
      const out = await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key,
          ...(keyMarker ? { KeyMarker: keyMarker, VersionIdMarker: versionIdMarker } : {})
        })
      )
      let past = false
      for (const v of out.Versions ?? [])
        if (v.Key === key) list.push(toVersion(v, parent, false) as S3Version)
        else if ((v.Key ?? '') > key) past = true
      for (const m of out.DeleteMarkers ?? [])
        if (m.Key === key) list.push(toVersion(m, parent, true) as S3Version)
        else if ((m.Key ?? '') > key) past = true
      // Đã sang key khác (S3 trả theo thứ tự key) hoặc hết → dừng.
      if (past || !out.IsTruncated || !out.NextKeyMarker || list.length >= MAX_OBJECT_VERSIONS)
        break
      keyMarker = out.NextKeyMarker
      versionIdMarker = out.NextVersionIdMarker
    }
    return sortVersions(list)
  })
}

/** Khôi phục phiên bản cũ: copy thành bản mới nhất, giữ metadata, tag, lớp lưu trữ, mã hoá. */
export async function restoreVersion(
  client: S3Client,
  bucket: string,
  key: string,
  versionId: string
): Promise<void> {
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId })
  )
  await serverCopy(
    client,
    { bucket, key, versionId },
    { bucket, key },
    head.ContentLength ?? 0,
    undefined,
    { keep: keepStorage(head) }
  )
}

/** Xoá vĩnh viễn các phiên bản (một lô ≤ 1000). Trả về số đã xoá; lỗi từng mục → ném một câu. */
export async function deleteVersions(
  client: S3Client,
  bucket: string,
  items: readonly { key: string; versionId: string }[]
): Promise<number> {
  const out = await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: items.map((i) => ({ Key: i.key, VersionId: i.versionId })),
        Quiet: true
      }
    })
  )
  const errors = out.Errors ?? []
  if (errors.length) {
    const first = errors[0]
    throw new Error(
      tn(
        errors.length,
        'Could not delete {n} version: {detail}',
        'Could not delete {n} versions: {detail}',
        { detail: `${first?.Key ?? ''} (${first?.Message ?? first?.Code ?? ''})` }
      )
    )
  }
  return items.length
}
