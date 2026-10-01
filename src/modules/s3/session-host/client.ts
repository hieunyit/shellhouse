import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCopyCommand
} from '@aws-sdk/client-s3'
import type { _Object } from '@aws-sdk/client-s3'
import { runQueue } from '../../../node-shared/pool'

/** Thông tin kết nối một tài khoản S3 (đã giải mã secret — chỉ có ở main / Session Host). */
export interface S3Connection {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

/** Hai cấp đầu liệt kê theo "thư mục" để chia việc; sâu hơn liệt kê phẳng (ít request nhất). */
const SPLIT_DEPTH = 2
/** CopyObject một phát chỉ tới 5 GiB; lớn hơn phải copy từng phần (UploadPartCopy). */
const MAX_SINGLE_COPY = 5 * 1024 ** 3
const COPY_PART = 512 * 1024 ** 2

/**
 * Client S3 cho một tài khoản: đủ socket cho mọi request song song, giữ kết nối (không bắt tay
 * TLS lại mỗi request); retryMode adaptive — gặp SlowDown / 503 thì tự giảm tốc.
 */
export function createS3Client(connection: S3Connection, maxSockets: number): S3Client {
  const agent = { keepAlive: true, maxSockets }
  return new S3Client({
    maxAttempts: 5,
    retryMode: 'adaptive',
    requestHandler: { httpAgent: new HttpAgent(agent), httpsAgent: new HttpsAgent(agent) },
    region: connection.region || 'us-east-1',
    ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
    forcePathStyle: connection.forcePathStyle,
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey
    }
  })
}

/** CopySource phải URL-encode (giữ "/"). */
export function copySource(bucket: string, key: string): string {
  return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`
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

/** Lỗi S3 → câu dễ hiểu. */
export function errorText(error: unknown): string {
  const e = error as { name?: string; message?: string; Code?: string } | null
  const code = e?.Code ?? e?.name
  if (code === 'NoSuchBucket') return 'The bucket does not exist'
  if (code === 'NoSuchKey') return 'The object does not exist'
  if (code === 'AccessDenied') return 'Access denied (check the key permissions)'
  if (code === 'InvalidAccessKeyId') return 'The access key ID is not valid'
  if (code === 'SignatureDoesNotMatch') return 'The secret key is wrong'
  if (code === 'BucketAlreadyExists' || code === 'BucketAlreadyOwnedByYou')
    return 'A bucket with this name already exists'
  if (code === 'AbortError') return 'Cancelled'
  if (code === 'InvalidObjectState')
    return 'The object is archived (Glacier) — restore it before reading or copying it'
  return e?.message ?? String(error)
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

/** Copy một object trên server (cùng tài khoản); > 5 GiB thì copy từng phần, không tải về máy. */
export async function serverCopy(
  client: S3Client,
  from: { bucket: string; key: string },
  to: { bucket: string; key: string },
  size: number,
  signal?: AbortSignal
): Promise<void> {
  const source = copySource(from.bucket, from.key)
  if (size <= MAX_SINGLE_COPY) {
    await client.send(
      new CopyObjectCommand({ Bucket: to.bucket, Key: to.key, CopySource: source }),
      {
        abortSignal: signal
      }
    )
    return
  }
  const head = await client.send(new HeadObjectCommand({ Bucket: from.bucket, Key: from.key }))
  const { UploadId } = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: to.bucket,
      Key: to.key,
      ContentType: head.ContentType,
      Metadata: head.Metadata
    })
  )
  const partSize = Math.max(COPY_PART, Math.ceil(size / 9000))
  try {
    const parts: { ETag: string | undefined; PartNumber: number }[] = []
    for (let start = 0, n = 1; start < size; start += partSize, n++) {
      if (signal?.aborted) throw new Error('Cancelled')
      const end = Math.min(start + partSize, size) - 1
      const out = await client.send(
        new UploadPartCopyCommand({
          Bucket: to.bucket,
          Key: to.key,
          UploadId,
          PartNumber: n,
          CopySource: source,
          CopySourceRange: `bytes=${start}-${end}`
        })
      )
      parts.push({ ETag: out.CopyPartResult?.ETag, PartNumber: n })
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: to.bucket,
        Key: to.key,
        UploadId,
        MultipartUpload: { Parts: parts }
      })
    )
  } catch (error) {
    await client
      .send(new AbortMultipartUploadCommand({ Bucket: to.bucket, Key: to.key, UploadId }))
      .catch(() => undefined)
    throw error
  }
}
