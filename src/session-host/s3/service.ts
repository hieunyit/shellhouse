import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { replaceUnsafeFileChars } from '@shared/file-names'
import type { S3Bucket, S3Entry, S3Listing, S3Op } from '@shared/s3'
import type { TransferStatus } from '@shared/sftp'

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

interface Job {
  status: TransferStatus
  run: (job: Job) => Promise<void>
  abort: AbortController
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
  return e?.message ?? String(error)
}

/** Thao tác S3 của một tab + hàng đợi truyền file (chạy trong Session Host). */
export class S3Service {
  private readonly client: S3Client
  private readonly jobs = new Map<string, Job>()
  private running = 0
  private notifyTimer: NodeJS.Timeout | null = null
  private disposed = false

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
      case 'cancel': {
        const job = this.jobs.get(op.transferId)
        job?.abort.abort()
        if (job?.status.state === 'queued') {
          job.status.state = 'cancelled'
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
    const list = [...all]
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
    return list.length
  }

  // ---------- Truyền file ----------

  transfers(): TransferStatus[] {
    return [...this.jobs.values()].map((j) => ({ ...j.status }))
  }

  private add(
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    run: (job: Job) => Promise<void>
  ): string {
    const id = randomUUID()
    this.jobs.set(id, {
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
        bytesPerSecond: 0
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

  private async upload(job: Job, bucket: string, key: string, localPath: string): Promise<void> {
    job.status.size = (await stat(localPath)).size
    // lib-storage: tự chia nhiều phần (multipart) cho file lớn, gửi song song.
    const upload = new Upload({
      client: this.client,
      params: { Bucket: bucket, Key: key, Body: createReadStream(localPath) },
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
      this.add('download', localPath, `s3://${bucket}/${key}`, (job) =>
        this.download(job, bucket, key, localPath)
      )
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
      this.add('download', target, `s3://${bucket}/${o.key}`, (job) =>
        this.download(job, bucket, o.key, target)
      )
      count++
    }
    await mkdir(root, { recursive: true })
    return count
  }

  private async download(job: Job, bucket: string, key: string, localPath: string): Promise<void> {
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
          },
          (error: unknown) => {
            job.status.state = job.abort.signal.aborted ? 'cancelled' : 'error'
            job.status.error = job.abort.signal.aborted ? null : errorText(error)
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
    for (const job of this.jobs.values()) job.abort.abort()
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.client.destroy()
  }
}
