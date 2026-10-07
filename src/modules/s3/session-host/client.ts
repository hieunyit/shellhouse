import { createHash } from 'node:crypto'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCopyCommand,
  type CopyObjectCommandInput,
  type CreateBucketCommandInput,
  type HeadObjectCommandOutput
} from '@aws-sdk/client-s3'
import type { _Object } from '@aws-sdk/client-s3'
import { t, tn } from '@shared/i18n'
import { runQueue } from '../../../node-shared/pool'
import { proxiedAgents } from '../../../node-shared/proxy-tunnel'
import { isCertificateError } from '@shared/proxy'

/** Thông tin kết nối một tài khoản S3 (đã giải mã secret — chỉ có ở main / Session Host). */
export interface S3Connection {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  /** Proxy (Settings › Network) — thiếu / null = kết nối thẳng. */
  proxy?: string | null
  /** Bỏ qua kiểm tra chứng chỉ TLS. */
  insecureTls?: boolean
}

/** Hai cấp đầu liệt kê theo "thư mục" để chia việc; sâu hơn liệt kê phẳng (ít request nhất). */
const SPLIT_DEPTH = 2
/** CopyObject một phát chỉ tới 5 GiB; lớn hơn phải copy từng phần (UploadPartCopy). */
const MAX_SINGLE_COPY = 5 * 1024 ** 3
const COPY_PART = 512 * 1024 ** 2

/** Region mặc định của tài khoản (trống = us-east-1). */
export function accountRegion(connection: S3Connection): string {
  return connection.region || 'us-east-1'
}

/**
 * Client S3 cho một tài khoản: đủ socket cho mọi request song song, giữ kết nối (không bắt tay
 * TLS lại mỗi request); retryMode adaptive — gặp SlowDown / 503 thì tự giảm tốc.
 *
 * - `followRegionRedirects`: bucket ở region khác (AWS trả 301 PermanentRedirect) vẫn dùng được —
 *   SDK tự gửi lại đúng region. S3Service còn giữ client riêng theo region của bucket để khỏi tốn
 *   một vòng redirect mỗi request và để link chia sẻ ký đúng region.
 * - Endpoint tự đặt (MinIO, Ceph, Wasabi, B2…): checksum chỉ khi bắt buộc — mặc định mới của SDK
 *   (CRC32 mọi request, header aws-chunked) làm nhiều dịch vụ tương thích S3 từ chối; DeleteObjects
 *   kèm Content-MD5 như SDK cũ (nhiều server vẫn đòi header này).
 */
export function createS3Client(
  connection: S3Connection,
  maxSockets: number,
  region: string = accountRegion(connection)
): S3Client {
  const agent = { keepAlive: true, maxSockets }
  const custom = connection.endpoint !== ''
  const client = new S3Client({
    maxAttempts: 5,
    retryMode: 'adaptive',
    requestHandler: proxiedAgents(
      connection.proxy ?? null,
      agent,
      connection.insecureTls ? { rejectUnauthorized: false } : {}
    ),
    region,
    followRegionRedirects: true,
    ...(custom
      ? {
          endpoint: connection.endpoint,
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const
        }
      : {}),
    forcePathStyle: connection.forcePathStyle,
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey
    }
  })
  if (custom) addContentMd5(client)
  return client
}

/**
 * Lệnh mà nhiều server tương thích S3 (MinIO cũ, Ceph…) đòi Content-MD5 — SDK mới chỉ gửi checksum
 * CRC32. Body XML của các lệnh này là chuỗi ở bước build, trước khi ký.
 */
const MD5_COMMANDS = new Set([
  'DeleteObjectsCommand',
  'PutBucketLifecycleConfigurationCommand',
  'PutBucketCorsCommand',
  'PutObjectTaggingCommand'
])

/** Thêm Content-MD5 cho các lệnh trong MD5_COMMANDS. */
function addContentMd5(client: S3Client): void {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const request = args.request as { headers?: Record<string, string>; body?: unknown } | null
      if (
        MD5_COMMANDS.has(context.commandName ?? '') &&
        request?.headers &&
        typeof request.body === 'string' &&
        !Object.keys(request.headers).some((h) => h.toLowerCase() === 'content-md5')
      )
        request.headers['content-md5'] = createHash('md5').update(request.body).digest('base64')
      return next(args)
    },
    { step: 'build', name: 'shellhouseDeleteContentMd5', override: true }
  )
}

/**
 * Tham số CreateBucket: ngoài us-east-1 phải nói rõ region (LocationConstraint) — thiếu thì AWS
 * báo IllegalLocationConstraintException. "auto" (Cloudflare R2) không phải region thật.
 */
export function createBucketInput(bucket: string, region: string): CreateBucketCommandInput {
  return region && region !== 'us-east-1' && region !== 'auto'
    ? {
        Bucket: bucket,
        CreateBucketConfiguration: {
          LocationConstraint: region as NonNullable<
            CreateBucketCommandInput['CreateBucketConfiguration']
          >['LocationConstraint']
        }
      }
    : { Bucket: bucket }
}

/**
 * Thuộc tính cần giữ khi ghi đè nội dung một object (sửa file, copy nhiều phần): kiểu nội dung,
 * header HTTP, metadata người dùng, storage class (không thì object quay về STANDARD).
 */
export function preservedAttributes(head: Partial<HeadObjectCommandOutput> | null | undefined): {
  ContentType?: string
  CacheControl?: string
  ContentDisposition?: string
  ContentEncoding?: string
  ContentLanguage?: string
  Metadata?: Record<string, string>
  StorageClass?: NonNullable<HeadObjectCommandOutput['StorageClass']>
} {
  if (!head) return {}
  return {
    ...(head.ContentType ? { ContentType: head.ContentType } : {}),
    ...(head.CacheControl ? { CacheControl: head.CacheControl } : {}),
    ...(head.ContentDisposition ? { ContentDisposition: head.ContentDisposition } : {}),
    ...(head.ContentEncoding ? { ContentEncoding: head.ContentEncoding } : {}),
    ...(head.ContentLanguage ? { ContentLanguage: head.ContentLanguage } : {}),
    ...(head.Metadata && Object.keys(head.Metadata).length ? { Metadata: head.Metadata } : {}),
    // HEAD không trả StorageClass cho STANDARD — chỉ gửi khi khác (không thừa header với MinIO…).
    ...(head.StorageClass && head.StorageClass !== 'STANDARD'
      ? { StorageClass: head.StorageClass }
      : {})
  }
}

/** Mã lỗi S3 (name / Code) của một lỗi SDK. */
export function errorCode(error: unknown): string | undefined {
  const e = error as { name?: string; Code?: string } | null
  return e?.Code ?? e?.name
}

/** Điều kiện ghi (If-Match / If-None-Match) không đạt: object đã đổi / đã có. */
export function isPreconditionFailed(error: unknown): boolean {
  const e = error as { $metadata?: { httpStatusCode?: number } } | null
  return errorCode(error) === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412
}

/** Dịch vụ không hỗ trợ header điều kiện khi ghi (MinIO cũ, Ceph…) → bỏ header, kiểm tra kiểu cũ. */
export function isConditionalWriteUnsupported(error: unknown): boolean {
  const e = error as { $metadata?: { httpStatusCode?: number } } | null
  const code = errorCode(error)
  return (
    code === 'NotImplemented' ||
    e?.$metadata?.httpStatusCode === 501 ||
    (code === 'InvalidArgument' && /if-?match|if-?none-?match/i.test(String(error)))
  )
}

/**
 * "Test connection" trong form tài khoản: một ListBuckets (tối đa 10 giây). Khoá không có quyền
 * liệt kê bucket nhưng ký đúng (AccessDenied) vẫn là kết nối được.
 */
export async function testConnection(
  connection: S3Connection
): Promise<{ ok: boolean; message: string }> {
  const client = createS3Client(connection, 2)
  try {
    const out = await client.send(new ListBucketsCommand({}), {
      abortSignal: AbortSignal.timeout(10_000)
    })
    const n = out.Buckets?.length ?? 0
    return {
      ok: true,
      message: tn(n, 'Connected — {n} bucket', 'Connected — {n} buckets')
    }
  } catch (error) {
    if (errorCode(error) === 'AccessDenied')
      return { ok: true, message: t('Connected, but this key is not allowed to list buckets') }
    if (errorCode(error) === 'TimeoutError' || errorCode(error) === 'AbortError')
      return { ok: false, message: t('No answer from the endpoint within 10 seconds') }
    return { ok: false, message: errorText(error) }
  } finally {
    client.destroy()
  }
}

/** CopySource phải URL-encode (giữ "/"); `versionId` = copy từ một phiên bản cũ. */
export function copySource(bucket: string, key: string, versionId?: string): string {
  const source = `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`
  return versionId ? `${source}?versionId=${encodeURIComponent(versionId)}` : source
}

/**
 * Dịch vụ không có API này (Cloudflare R2 không có versioning, B2 không có lifecycle qua S3 API,
 * MinIO một ổ đĩa…): 501 NotImplemented, 405 MethodNotAllowed, hoặc mã riêng của từng hãng.
 */
export function isUnsupported(error: unknown): boolean {
  const e = error as { $metadata?: { httpStatusCode?: number } } | null
  const code = errorCode(error)
  return (
    code === 'NotImplemented' ||
    code === 'XNotImplemented' ||
    code === 'MethodNotAllowed' ||
    code === 'UnsupportedOperation' ||
    code === 'NotSupported' ||
    e?.$metadata?.httpStatusCode === 501 ||
    e?.$metadata?.httpStatusCode === 405
  )
}

export function isAccessDenied(error: unknown): boolean {
  const e = error as { $metadata?: { httpStatusCode?: number } } | null
  return errorCode(error) === 'AccessDenied' || e?.$metadata?.httpStatusCode === 403
}

export function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.name === 'NoSuchBucket' ||
    e?.$metadata?.httpStatusCode === 404
  )
}

/** Lỗi S3 → câu dễ hiểu (theo ngôn ngữ giao diện). */
export function errorText(error: unknown): string {
  const e = error as { name?: string; message?: string; Code?: string } | null
  const code = e?.Code ?? e?.name
  if (code === 'NoSuchBucket') return t('The bucket does not exist')
  if (code === 'NoSuchKey') return t('The object does not exist')
  if (code === 'NoSuchVersion') return t('That version of the object does not exist')
  if (code === 'AccessDenied') return t('Access denied (check the key permissions)')
  if (code === 'InvalidAccessKeyId') return t('The access key ID is not valid')
  if (code === 'SignatureDoesNotMatch') return t('The secret key is wrong')
  if (code === 'BucketAlreadyExists' || code === 'BucketAlreadyOwnedByYou')
    return t('A bucket with this name already exists')
  if (code === 'AbortError') return t('Cancelled')
  if (code === 'PermanentRedirect' || code === 'AuthorizationHeaderMalformed')
    return t('The bucket is in another region — check the region of the account')
  if (code === 'IllegalLocationConstraintException' || code === 'InvalidLocationConstraint')
    return t('The region of the account does not match this endpoint — check the region')
  if (code === 'InvalidObjectState')
    return t('The object is archived (Glacier) — restore it before reading or copying it')
  if (isUnsupported(error)) return t('Not supported by this provider')
  const message = e?.message ?? String(error)
  if (isCertificateError(message))
    return t(
      '{error} — if you trust this server, turn on “Skip certificate verification” in the account settings',
      { error: message }
    )
  return message
}

/**
 * Duyệt mọi object dưới `prefix`, nhiều request song song. S3 chỉ phân trang tuần tự trong một
 * prefix (token trang sau nằm trong trang trước), nên chia việc theo "thư mục": 2 cấp đầu liệt kê
 * có Delimiter để lấy các thư mục con rồi quét chúng song song; sâu hơn thì liệt kê phẳng. Mỗi
 * object được báo đúng một lần.
 */
export function scanObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  concurrency: number,
  onObjects: (objects: readonly _Object[]) => void,
  signal?: AbortSignal
): Promise<void> {
  return runQueue(
    [{ prefix, depth: 0 }],
    concurrency,
    async (task, push) => {
      const split = task.depth < SPLIT_DEPTH
      let token: string | undefined
      do {
        const out = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: task.prefix,
            ...(split ? { Delimiter: '/' } : {}),
            ContinuationToken: token
          }),
          { abortSignal: signal }
        )
        if (out.Contents?.length) onObjects(out.Contents)
        if (split)
          for (const p of out.CommonPrefixes ?? [])
            if (p.Prefix) push({ prefix: p.Prefix, depth: task.depth + 1 })
        token = out.IsTruncated ? out.NextContinuationToken : undefined
      } while (token && !signal?.aborted)
    },
    signal
  )
}

/** Tuỳ chọn copy trên server (sửa metadata, khôi phục phiên bản…). */
export interface CopyOptions {
  /** Thay kiểu nội dung / header / metadata (MetadataDirective REPLACE). */
  replace?: ReturnType<typeof preservedAttributes>
  /**
   * Giữ lớp lưu trữ / mã hoá của nguồn — CopyObject mặc định đưa object về STANDARD và mã hoá
   * mặc định của bucket.
   */
  keep?: Pick<CopyObjectCommandInput, 'StorageClass' | 'ServerSideEncryption' | 'SSEKMSKeyId'>
  /** Nguồn phải còn đúng ETag này (không thì 412 PreconditionFailed). */
  ifMatch?: string
}

/** Copy một object trên server (cùng tài khoản); > 5 GiB thì copy từng phần, không tải về máy. */
export async function serverCopy(
  client: S3Client,
  from: { bucket: string; key: string; versionId?: string },
  to: { bucket: string; key: string },
  size: number,
  signal?: AbortSignal,
  copy: CopyOptions = {}
): Promise<void> {
  const source = copySource(from.bucket, from.key, from.versionId)
  const condition = copy.ifMatch ? { CopySourceIfMatch: copy.ifMatch } : {}
  if (size <= MAX_SINGLE_COPY) {
    await client.send(
      new CopyObjectCommand({
        Bucket: to.bucket,
        Key: to.key,
        CopySource: source,
        ...condition,
        ...(copy.replace ? { MetadataDirective: 'REPLACE' as const, ...copy.replace } : {}),
        ...copy.keep
      }),
      { abortSignal: signal }
    )
    return
  }
  const options = { abortSignal: signal }
  const head = await client.send(
    new HeadObjectCommand({ Bucket: from.bucket, Key: from.key, VersionId: from.versionId }),
    options
  )
  const { UploadId } = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: to.bucket,
      Key: to.key,
      ...(copy.replace ?? preservedAttributes(head)),
      ...copy.keep
    }),
    options
  )
  const partSize = Math.max(COPY_PART, Math.ceil(size / 9000))
  try {
    const parts: { ETag: string | undefined; PartNumber: number }[] = []
    for (let start = 0, n = 1; start < size; start += partSize, n++) {
      if (signal?.aborted) throw new Error(t('Cancelled'))
      const end = Math.min(start + partSize, size) - 1
      const out = await client.send(
        new UploadPartCopyCommand({
          Bucket: to.bucket,
          Key: to.key,
          UploadId,
          PartNumber: n,
          CopySource: source,
          CopySourceRange: `bytes=${start}-${end}`,
          ...condition
        }),
        options
      )
      parts.push({ ETag: out.CopyPartResult?.ETag, PartNumber: n })
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: to.bucket,
        Key: to.key,
        UploadId,
        MultipartUpload: { Parts: parts }
      }),
      options
    )
  } catch (error) {
    await client
      .send(new AbortMultipartUploadCommand({ Bucket: to.bucket, Key: to.key, UploadId }))
      .catch(() => undefined)
    throw error
  }
}
