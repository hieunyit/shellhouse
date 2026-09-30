import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { replaceUnsafeFileChars } from '@shared/file-names'
import {
  objectNameProblem,
  parentPrefix,
  type S3Bucket,
  type S3Entry,
  type S3Listing,
  type S3Op,
  type S3StatsPage
} from '@shared/s3'
import type { TransferStatus } from '@shared/sftp'
import { S3Edits } from './edit'

export interface S3Connection {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

/** Mỗi lần liệt kê hiện tối đa chừng này mục (thư mục khổng lồ: báo truncated). */
const MAX_LIST = 5000
const MAX_TREE = 10_000
const MAX_PARALLEL = 3
const PART_SUFFIX = '.shellhouse-part'
const PROGRESS_MS = 250
/** Mỗi lần gọi `stats` quét tối đa chừng này trang (1000 object/trang). */
const STATS_PAGES = 20
const COPY_PARALLEL = 8
/** CopyObject một phát chỉ tới 5 GiB; lớn hơn phải copy từng phần (UploadPartCopy). */
const MAX_SINGLE_COPY = 5 * 1024 ** 3
const COPY_PART = 512 * 1024 ** 2

interface Job {
  status: TransferStatus
  run: (job: Job) => Promise<void>
  abort: AbortController
  /** Báo kết thúc (xong / lỗi / huỷ) cho ai đang chờ job này. */
  settle?: (error: Error | null) => void
}

/** Một cặp copy: object nguồn → key đích. */
interface CopyPair {
  from: string
  to: string
  size: number
}

/** Tên cuối của key: "a/b/c.txt" → "c.txt", "a/b/" → "b". */
function lastName(key: string): string {
  return key.replace(/\/$/, '').split('/').at(-1) ?? key
}

/** CopySource phải URL-encode (giữ "/"). */
function copySource(bucket: string, key: string): string {
  return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}

function errorText(error: unknown): string {
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

/** Thao tác S3 của một tab + hàng đợi truyền file (chạy trong Session Host). */
export class S3Service {
  private readonly client: S3Client
  private readonly jobs = new Map<string, Job>()
  private running = 0
  private notifyTimer: NodeJS.Timeout | null = null
  private disposed = false
  private edits: S3Edits | null = null

  constructor(
    connection: S3Connection,
    private readonly onTransfers: (list: TransferStatus[]) => void
  ) {
    this.client = new S3Client({
      region: connection.region || 'us-east-1',
      ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
      forcePathStyle: connection.forcePathStyle,
      credentials: {
        accessKeyId: connection.accessKeyId,
        secretAccessKey: connection.secretAccessKey
      }
    })
  }

  async run(op: S3Op): Promise<unknown> {
    try {
      return await this.dispatch(op)
    } catch (error) {
      throw new Error(errorText(error), { cause: error })
    }
  }

  private async dispatch(op: S3Op): Promise<unknown> {
    switch (op.op) {
      case 'listBuckets':
        return this.listBuckets()
      case 'createBucket':
        await this.client.send(new CreateBucketCommand({ Bucket: op.bucket }))
        return null
      case 'list':
        return this.list(op.bucket, op.prefix)
      case 'mkdir':
        await this.client.send(
          new PutObjectCommand({
            Bucket: op.bucket,
            Key: op.key.endsWith('/') ? op.key : `${op.key}/`,
            Body: ''
          })
        )
        return null
      case 'delete':
        return this.remove(op.bucket, op.keys)
      case 'presign':
        return getSignedUrl(this.client, new GetObjectCommand({ Bucket: op.bucket, Key: op.key }), {
          expiresIn: op.expiresSeconds
        })
      case 'upload':
        return this.enqueueUpload(op.bucket, op.prefix, op.localPath)
      case 'download':
        return this.enqueueDownload(op.bucket, op.key, op.localPath, op.overwrite)
      case 'stats':
        return this.stats(op.bucket, op.prefix, op.token)
      case 'copy':
        return this.copy(op.bucket, op.keys, op.destBucket, op.destPrefix, op.move, op.overwrite)
      case 'rename':
        return this.rename(op.bucket, op.key, op.name, op.overwrite)
      case 'edit':
        this.edits ??= new S3Edits(this)
        await this.edits.open(op.bucket, op.key, op.localPath)
        return null
      case 'cancel': {
        const job = this.jobs.get(op.transferId)
        job?.abort.abort()
        if (job?.status.state === 'queued') {
          job.status.state = 'cancelled'
          job.settle?.(new Error('Cancelled'))
          this.notify(true)
        }
        return null
      }
      case 'clearDone':
        for (const [id, job] of this.jobs) if (job.status.state === 'done') this.jobs.delete(id)
        this.notify(true)
        return null
    }
  }

  private async listBuckets(): Promise<S3Bucket[]> {
    const out = await this.client.send(new ListBucketsCommand({}))
    return (out.Buckets ?? [])
      .map((b) => ({ name: b.Name ?? '', createdAt: b.CreationDate?.getTime() ?? null }))
      .filter((b) => b.name)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async list(bucket: string, prefix: string): Promise<S3Listing> {
    const entries: S3Entry[] = []
    let token: string | undefined
    let truncated = false
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: '/',
          ContinuationToken: token
        })
      )
      for (const p of out.CommonPrefixes ?? []) {
        if (!p.Prefix) continue
        entries.push({
          name: p.Prefix.slice(prefix.length).replace(/\/$/, ''),
          key: p.Prefix,
          isFolder: true,
          size: 0,
          modified: null,
          storageClass: null
        })
      }
      for (const o of out.Contents ?? []) {
        // Object "thư mục" của chính prefix này (tạo bằng New folder) — không hiện.
        if (!o.Key || o.Key === prefix) continue
        entries.push({
          name: o.Key.slice(prefix.length),
          key: o.Key,
          isFolder: false,
          size: o.Size ?? 0,
          modified: o.LastModified?.getTime() ?? null,
          storageClass: o.StorageClass ?? null
        })
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined
      if (entries.length >= MAX_LIST && token) {
        truncated = true
        break
      }
    } while (token)
    entries.sort((a, b) =>
      a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1
    )
    return { bucket, prefix, entries, truncated }
  }

  /** Mọi key dưới prefix (đệ quy), tối đa MAX_TREE. */
  private async allKeys(bucket: string, prefix: string): Promise<{ key: string; size: number }[]> {
    const keys: { key: string; size: number }[] = []
    let token: string | undefined
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
      )
      for (const o of out.Contents ?? []) if (o.Key) keys.push({ key: o.Key, size: o.Size ?? 0 })
      if (keys.length > MAX_TREE)
        throw new Error(`The folder has too many objects (more than ${MAX_TREE})`)
      token = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (token)
    return keys
  }

  /** Xoá object và cả "thư mục" (key kết thúc "/"). Trả về số object đã xoá. */
  private async remove(bucket: string, keys: readonly string[]): Promise<number> {
    const all = new Set<string>()
    for (const key of keys) {
      if (key.endsWith('/')) for (const k of await this.allKeys(bucket, key)) all.add(k.key)
      all.add(key)
    }
    await this.deleteExact(bucket, [...all])
    return all.size
  }

  /** Xoá đúng các key này (không đệ quy). */
  private async deleteExact(bucket: string, list: readonly string[]): Promise<void> {
    for (let i = 0; i < list.length; i += 1000) {
      const out = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: list.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true }
        })
      )
      const failed = out.Errors?.[0]
      if (failed) throw new Error(`Could not delete ${failed.Key ?? ''}: ${failed.Message ?? ''}`)
    }
  }

  // ---------- Thống kê ----------

  private async stats(bucket: string, prefix: string, token?: string): Promise<S3StatsPage> {
    const page: S3StatsPage = { objects: 0, bytes: 0, byClass: {}, next: null }
    let next = token
    for (let i = 0; i < STATS_PAGES; i++) {
      const out = await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: next })
      )
      for (const o of out.Contents ?? []) {
        const size = o.Size ?? 0
        // Object "thư mục" rỗng (New folder) không phải dữ liệu.
        if (!o.Key || (o.Key.endsWith('/') && size === 0)) continue
        const cls = o.StorageClass ?? 'STANDARD'
        const cur = page.byClass[cls] ?? { objects: 0, bytes: 0 }
        page.byClass[cls] = { objects: cur.objects + 1, bytes: cur.bytes + size }
        page.objects++
        page.bytes += size
      }
      next = out.IsTruncated ? out.NextContinuationToken : undefined
      if (!next) break
    }
    page.next = next ?? null
    return page
  }

  // ---------- Copy / move / đổi tên ----------

  private async exists(bucket: string, key: string): Promise<boolean> {
    if (key.endsWith('/')) {
      const out = await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 })
      )
      return (out.KeyCount ?? out.Contents?.length ?? 0) > 0
    }
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  /** Các cặp copy cho một object / "thư mục" nguồn → key đích. */
  private async plan(
    bucket: string,
    key: string,
    destBucket: string,
    destKey: string,
    overwrite: boolean
  ): Promise<CopyPair[]> {
    const name = lastName(key)
    if (bucket === destBucket && key === destKey)
      throw new Error(`“${name}” is already in this folder`)
    if (key.endsWith('/') && bucket === destBucket && destKey.startsWith(key))
      throw new Error(`A folder cannot be copied into itself (“${name}”)`)
    if (!overwrite && (await this.exists(destBucket, destKey)))
      throw new Error(`“${lastName(destKey)}” already exists at the destination`)
    if (!key.endsWith('/')) {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      return [{ from: key, to: destKey, size: head.ContentLength ?? 0 }]
    }
    return (await this.allKeys(bucket, key)).map((o) => ({
      from: o.key,
      to: destKey + o.key.slice(key.length),
      size: o.size
    }))
  }

  private async copyObject(bucket: string, destBucket: string, pair: CopyPair): Promise<void> {
    const source = copySource(bucket, pair.from)
    if (pair.size <= MAX_SINGLE_COPY) {
      await this.client.send(
        new CopyObjectCommand({ Bucket: destBucket, Key: pair.to, CopySource: source })
      )
      return
    }
    // Object > 5 GiB: copy từng phần trên server (không tải về máy).
    const head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: pair.from }))
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: destBucket,
        Key: pair.to,
        ContentType: head.ContentType,
        Metadata: head.Metadata
      })
    )
    const partSize = Math.max(COPY_PART, Math.ceil(pair.size / 9000))
    try {
      const parts: { ETag: string | undefined; PartNumber: number }[] = []
      for (let start = 0, n = 1; start < pair.size; start += partSize, n++) {
        const end = Math.min(start + partSize, pair.size) - 1
        const out = await this.client.send(
          new UploadPartCopyCommand({
            Bucket: destBucket,
            Key: pair.to,
            UploadId,
            PartNumber: n,
            CopySource: source,
            CopySourceRange: `bytes=${start}-${end}`
          })
        )
        parts.push({ ETag: out.CopyPartResult?.ETag, PartNumber: n })
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: destBucket,
          Key: pair.to,
          UploadId,
          MultipartUpload: { Parts: parts }
        })
      )
    } catch (error) {
      await this.client
        .send(new AbortMultipartUploadCommand({ Bucket: destBucket, Key: pair.to, UploadId }))
        .catch(() => undefined)
      throw error
    }
  }

  /** Copy các cặp (song song), move thì xoá nguồn sau khi copy xong hết. Trả về số object. */
  private async runCopy(
    bucket: string,
    destBucket: string,
    pairs: CopyPair[],
    move: boolean
  ): Promise<number> {
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < pairs.length) {
        const pair = pairs[i++]
        if (pair) await this.copyObject(bucket, destBucket, pair)
      }
    }
    await Promise.all(Array.from({ length: Math.min(COPY_PARALLEL, pairs.length) }, worker))
    if (move) await this.deleteExact(bucket, [...new Set(pairs.map((p) => p.from))])
    return pairs.length
  }

  private async copy(
    bucket: string,
    keys: readonly string[],
    destBucket: string,
    destPrefix: string,
    move: boolean,
    overwrite: boolean
  ): Promise<number> {
    const base = destPrefix && !destPrefix.endsWith('/') ? `${destPrefix}/` : destPrefix
    const pairs: CopyPair[] = []
    // Kiểm tra hết trước (trùng tên, copy vào chính nó…) rồi mới bắt đầu copy.
    for (const key of keys) {
      const destKey = base + lastName(key) + (key.endsWith('/') ? '/' : '')
      pairs.push(...(await this.plan(bucket, key, destBucket, destKey, overwrite)))
    }
    if (pairs.length > MAX_TREE) throw new Error(`Too many objects (more than ${MAX_TREE})`)
    return this.runCopy(bucket, destBucket, pairs, move)
  }

  private async rename(
    bucket: string,
    key: string,
    name: string,
    overwrite: boolean
  ): Promise<number> {
    const problem = objectNameProblem(name)
    if (problem) throw new Error(problem)
    const folder = key.endsWith('/')
    const destKey = parentPrefix(key) + name + (folder ? '/' : '')
    if (destKey === key) return 0
    const pairs = await this.plan(bucket, key, bucket, destKey, overwrite)
    return this.runCopy(bucket, bucket, pairs, true)
  }

  // ---------- Sửa file (S3Edits) ----------

  async head(bucket: string, key: string): Promise<{ etag: string | null; contentType: string }> {
    const out = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return { etag: out.ETag ?? null, contentType: out.ContentType ?? '' }
  }

  /** Tải object về (qua hàng đợi, hiện trong Transfers) và chờ xong. */
  async downloadAndWait(
    bucket: string,
    key: string,
    localPath: string
  ): Promise<{ etag: string | null; contentType: string }> {
    let info = { etag: null as string | null, contentType: '' }
    await this.addAndWait('download', localPath, `s3://${bucket}/${key}`, false, async (job) => {
      info = await this.download(job, bucket, key, localPath)
    })
    return info
  }

  /**
   * Tải file lên đè object — chỉ khi object trên server vẫn là bản `expectEtag` (không thì báo lỗi,
   * không ghi đè thay đổi của người khác). Trả về ETag mới.
   */
  async uploadIfUnchanged(
    bucket: string,
    key: string,
    localPath: string,
    expectEtag: string | null,
    contentType: string
  ): Promise<string | null> {
    let etag: string | null = null
    await this.addAndWait('upload', localPath, `s3://${bucket}/${key}`, true, async (job) => {
      const current = await this.head(bucket, key).catch((error: unknown) => {
        if (isNotFound(error)) return { etag: null }
        throw error
      })
      if (expectEtag !== null && current.etag !== expectEtag)
        throw new Error(
          'The object was changed on the server since you opened it — not overwritten. Open it again to edit the latest version.'
        )
      await this.upload(job, bucket, key, localPath, contentType)
      etag = (await this.head(bucket, key)).etag
    })
    return etag
  }

  // ---------- Truyền file ----------

  transfers(): TransferStatus[] {
    return [...this.jobs.values()].map((j) => ({ ...j.status }))
  }

  /** Thêm job và chờ nó kết thúc (lỗi / huỷ → reject). */
  private addAndWait(
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    edit: boolean,
    run: (job: Job) => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.add(direction, localPath, remotePath, run, edit, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private add(
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    run: (job: Job) => Promise<void>,
    edit = false,
    settle?: (error: Error | null) => void
  ): string {
    const id = randomUUID()
    this.jobs.set(id, {
      settle,
      status: {
        id,
        direction,
        localPath,
        remotePath,
        size: 0,
        transferred: 0,
        resumedFrom: 0,
        state: 'queued',
        error: null,
        bytesPerSecond: 0,
        ...(edit ? { edit: true } : {})
      },
      run,
      abort: new AbortController()
    })
    this.notify(true)
    this.pump()
    return id
  }

  /** File hoặc cả thư mục trên máy → s3://bucket/prefix. Trả về số file đã xếp hàng. */
  private async enqueueUpload(bucket: string, prefix: string, localPath: string): Promise<number> {
    const info = await stat(localPath)
    const base = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix
    if (info.isFile()) {
      const key = base + basename(localPath)
      this.add('upload', localPath, `s3://${bucket}/${key}`, (job) =>
        this.upload(job, bucket, key, localPath)
      )
      return 1
    }
    const files: { local: string; key: string }[] = []
    const walk = async (dir: string, keyPrefix: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (files.length > MAX_TREE) throw new Error('The folder has too many files')
        if (e.isSymbolicLink()) continue
        const child = join(dir, e.name)
        if (e.isDirectory()) await walk(child, `${keyPrefix}${e.name}/`)
        else if (e.isFile()) files.push({ local: child, key: keyPrefix + e.name })
      }
    }
    await walk(localPath, `${base}${basename(localPath)}/`)
    for (const f of files)
      this.add('upload', f.local, `s3://${bucket}/${f.key}`, (job) =>
        this.upload(job, bucket, f.key, f.local)
      )
    return files.length
  }

  private async upload(
    job: Job,
    bucket: string,
    key: string,
    localPath: string,
    contentType?: string
  ): Promise<void> {
    job.status.size = (await stat(localPath)).size
    // lib-storage: tự chia nhiều phần (multipart) cho file lớn, gửi song song.
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: createReadStream(localPath),
        ...(contentType ? { ContentType: contentType } : {})
      },
      abortController: job.abort,
      queueSize: 4,
      partSize: 8 * 1024 * 1024
    })
    const meter = this.meter(job)
    upload.on('httpUploadProgress', (p) => {
      meter(p.loaded ?? 0)
    })
    await upload.done()
  }

  /** Object → file; key kết thúc "/" = cả thư mục vào `localParent/<tên>`. */
  private async enqueueDownload(
    bucket: string,
    key: string,
    localPath: string,
    overwrite: boolean
  ): Promise<number> {
    if (!key.endsWith('/')) {
      if (!overwrite && existsSync(localPath))
        throw new Error('The destination file already exists')
      this.add('download', localPath, `s3://${bucket}/${key}`, async (job) => {
        await this.download(job, bucket, key, localPath)
      })
      return 1
    }
    const folderName = replaceUnsafeFileChars(basename(key.replace(/\/$/, ''))) || bucket
    const root = join(localPath, folderName)
    if (existsSync(root) && !overwrite)
      throw new Error('A folder with this name already exists at the destination')
    const objects = await this.allKeys(bucket, key)
    let count = 0
    for (const o of objects) {
      const rel = o.key.slice(key.length)
      if (!rel || rel.endsWith('/')) continue // object "thư mục"
      const target = join(root, ...rel.split('/').map(replaceUnsafeFileChars))
      this.add('download', target, `s3://${bucket}/${o.key}`, async (job) => {
        await this.download(job, bucket, o.key, target)
      })
      count++
    }
    await mkdir(root, { recursive: true })
    return count
  }

  private async download(
    job: Job,
    bucket: string,
    key: string,
    localPath: string
  ): Promise<{ etag: string | null; contentType: string }> {
    await mkdir(dirname(localPath), { recursive: true })
    const out = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: job.abort.signal
    })
    job.status.size = out.ContentLength ?? 0
    const part = localPath + PART_SUFFIX
    const meter = this.meter(job)
    let loaded = 0
    const body = out.Body as Readable
    body.on('data', (chunk: Buffer) => {
      loaded += chunk.length
      meter(loaded)
    })
    try {
      await pipeline(body, createWriteStream(part), { signal: job.abort.signal })
      const written = (await stat(part)).size
      if (out.ContentLength !== undefined && written !== out.ContentLength)
        throw new Error(`Size mismatch after download (${written}/${out.ContentLength})`)
      await rename(part, localPath)
    } catch (error) {
      await rm(part, { force: true })
      throw error
    }
    return { etag: out.ETag ?? null, contentType: out.ContentType ?? '' }
  }

  /** Cập nhật tiến độ + tốc độ từ số byte đã truyền. */
  private meter(job: Job): (loaded: number) => void {
    let windowStart = Date.now()
    let windowBytes = job.status.transferred
    return (loaded) => {
      job.status.transferred = loaded
      const now = Date.now()
      if (now - windowStart >= 1000) {
        job.status.bytesPerSecond = Math.round(
          ((loaded - windowBytes) * 1000) / (now - windowStart)
        )
        windowStart = now
        windowBytes = loaded
      }
      this.notify()
    }
  }

  private pump(): void {
    if (this.disposed) return
    for (const job of this.jobs.values()) {
      if (this.running >= MAX_PARALLEL) return
      if (job.status.state !== 'queued') continue
      if (job.abort.signal.aborted) {
        job.status.state = 'cancelled'
        job.settle?.(new Error('Cancelled'))
        continue
      }
      this.running++
      job.status.state = 'running'
      this.notify(true)
      void job
        .run(job)
        .then(
          () => {
            job.status.state = 'done'
            job.status.transferred = job.status.size
            job.status.bytesPerSecond = 0
            job.settle?.(null)
          },
          (error: unknown) => {
            job.status.state = job.abort.signal.aborted ? 'cancelled' : 'error'
            job.status.error = job.abort.signal.aborted ? null : errorText(error)
            job.settle?.(new Error(job.status.error ?? 'Cancelled'))
          }
        )
        .finally(() => {
          this.running--
          this.notify(true)
          this.pump()
        })
    }
  }

  private notify(immediate = false): void {
    if (this.disposed) return
    if (immediate) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer)
      this.notifyTimer = null
      this.onTransfers(this.transfers())
      return
    }
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = null
      this.onTransfers(this.transfers())
    }, PROGRESS_MS)
  }

  dispose(): void {
    this.disposed = true
    this.edits?.dispose()
    for (const job of this.jobs.values()) job.abort.abort()
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.client.destroy()
  }
}
