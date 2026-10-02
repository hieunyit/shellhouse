import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client
} from '@aws-sdk/client-s3'
import type { _Object } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { replaceUnsafeFileChars } from '@shared/file-names'
import {
  objectNameProblem,
  parentPrefix,
  S3_EDIT_MAX_BYTES,
  S3_OBJECT_CHANGED,
  type S3Bucket,
  type S3BucketInfo,
  type S3Entry,
  type S3Listing,
  type S3Op,
  type S3StatsProgress
} from '../shared/ops'
import type { TransferStatus } from '@shared/sftp'
import { mapLimit } from '../../../node-shared/pool'
import {
  createS3Client,
  errorText,
  isNotFound,
  scanObjects,
  serverCopy,
  type S3Connection
} from './client'
import { S3Edits } from './edit'
import { SyncJob } from './sync'

export type { S3Connection } from './client'

/** Mỗi lần liệt kê hiện tối đa chừng này mục (thư mục khổng lồ: báo truncated). */
const MAX_LIST = 5000
const MAX_TREE = 10_000

const PART_SUFFIX = '.shellhouse-part'
const PROGRESS_MS = 250
/** Mặc định (chỉnh trong Settings → Files): request cùng lúc khi quét / copy / xoá, file cùng lúc. */
export const DEFAULT_S3_LIMITS = { requests: 16, transfers: 6 } as const
/** Mỗi file lớn tự chia phần gửi song song (lib-storage). */
const UPLOAD_QUEUE = 4

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

/** Thao tác S3 của một tab + hàng đợi truyền file (chạy trong Session Host). */
export class S3Service {
  private readonly client: S3Client
  private readonly jobs = new Map<string, Job>()
  private running = 0
  private notifyTimer: NodeJS.Timeout | null = null
  private disposed = false
  private edits: S3Edits | null = null
  private readonly statsJobs = new Map<
    string,
    { progress: S3StatsProgress; abort: AbortController }
  >()
  private readonly syncJobs = new Map<string, SyncJob>()

  private readonly requests: number
  private readonly maxTransfers: number

  constructor(
    connection: S3Connection,
    private readonly onTransfers: (list: TransferStatus[]) => void,
    limits: { requests: number; transfers: number } = DEFAULT_S3_LIMITS,
    /** Kết nối của tài khoản khác (đích đồng bộ) — main giải mã secret. */
    private readonly resolveAccount: (accountId: string) => Promise<S3Connection> = () =>
      Promise.reject(new Error('Other accounts are not available here'))
  ) {
    this.requests = limits.requests
    this.maxTransfers = limits.transfers
    // Đủ socket cho mọi request song song (quét + các phần của file đang truyền).
    this.client = createS3Client(connection, this.requests + this.maxTransfers * UPLOAD_QUEUE + 4)
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
      case 'statsStart':
        return this.startStats(op.bucket, op.prefix)
      case 'statsPoll':
        return this.pollStats(op.id)
      case 'statsStop': {
        const job = this.statsJobs.get(op.id)
        job?.abort.abort()
        this.statsJobs.delete(op.id)
        return job ? { ...job.progress, byClass: { ...job.progress.byClass }, done: true } : null
      }
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
      case 'listBucketsOf': {
        const client = createS3Client(await this.resolveAccount(op.accountId), 4)
        try {
          return await this.listBuckets(client)
        } finally {
          client.destroy()
        }
      }
      case 'bucketInfo':
        return this.bucketInfo(op.bucket)
      case 'readText':
        return this.readText(op.bucket, op.key)
      case 'writeText':
        return this.writeText(op.bucket, op.key, Buffer.from(op.data, 'base64'), op.expectEtag)
      case 'writeFile':
        await writeFile(op.localPath, op.content, 'utf8')
        return null
      case 'syncStart':
        return this.startSync(op)
      case 'syncPoll': {
        const job = this.syncJobs.get(op.id)
        if (!job) throw new Error('The sync was stopped')
        const snapshot = job.snapshot()
        if (job.finished) this.syncJobs.delete(op.id)
        return snapshot
      }
      case 'syncStop': {
        const job = this.syncJobs.get(op.id)
        job?.stop()
        return job?.snapshot() ?? null
      }
      case 'clearDone':
        for (const [id, job] of this.jobs) if (job.status.state === 'done') this.jobs.delete(id)
        this.notify(true)
        return null
    }
  }

  private async listBuckets(client: S3Client = this.client): Promise<S3Bucket[]> {
    const out = await client.send(new ListBucketsCommand({}))
    return (out.Buckets ?? [])
      .map((b) => ({
        name: b.Name ?? '',
        createdAt: b.CreationDate?.getTime() ?? null,
        region: b.BucketRegion ?? null
      }))
      .filter((b) => b.name)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Region / versioning / mã hoá — mỗi mục một request; dịch vụ không hỗ trợ thì null. */
  private async bucketInfo(bucket: string): Promise<S3BucketInfo> {
    const [location, versioning, encryption] = await Promise.allSettled([
      this.client.send(new GetBucketLocationCommand({ Bucket: bucket })),
      this.client.send(new GetBucketVersioningCommand({ Bucket: bucket })),
      this.client.send(new GetBucketEncryptionCommand({ Bucket: bucket }))
    ])
    const rule =
      encryption.status === 'fulfilled'
        ? encryption.value.ServerSideEncryptionConfiguration?.Rules?.[0]
            ?.ApplyServerSideEncryptionByDefault
        : undefined
    const encryptionCode =
      encryption.status === 'rejected'
        ? (encryption.reason as { name?: string } | null)?.name
        : undefined
    return {
      // ListBuckets cũ / dịch vụ khác: LocationConstraint rỗng = us-east-1.
      region:
        location.status === 'fulfilled' ? location.value.LocationConstraint || 'us-east-1' : null,
      versioning:
        versioning.status === 'fulfilled'
          ? versioning.value.Status === 'Enabled' || versioning.value.Status === 'Suspended'
            ? versioning.value.Status
            : 'Off'
          : null,
      encryption: rule?.SSEAlgorithm
        ? `${rule.SSEAlgorithm}${rule.KMSMasterKeyID ? ` (${rule.KMSMasterKeyID})` : ''}`
        : encryptionCode === 'ServerSideEncryptionConfigurationNotFoundError'
          ? 'None'
          : null
    }
  }

  // ---------- Đồng bộ ----------

  private async startSync(op: Extract<S3Op, { op: 'syncStart' }>): Promise<string> {
    const destClient = op.dest.accountId
      ? createS3Client(await this.resolveAccount(op.dest.accountId), this.requests + 8)
      : null
    const id = randomUUID()
    const job = new SyncJob(
      {
        source: this.client,
        dest: destClient ?? this.client,
        serverSide: destClient === null,
        concurrency: destClient ? Math.max(4, this.maxTransfers) : this.requests,
        scanConcurrency: this.requests
      },
      op
    )
    this.syncJobs.set(id, job)
    void job.run().finally(() => {
      destClient?.destroy()
    })
    return id
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

  private scanTree(
    bucket: string,
    prefix: string,
    onObjects: (objects: readonly _Object[]) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return scanObjects(this.client, bucket, prefix, this.requests, onObjects, signal)
  }

  /** Mọi key dưới prefix (đệ quy, song song), tối đa MAX_TREE; sắp theo key. */
  private async allKeys(bucket: string, prefix: string): Promise<{ key: string; size: number }[]> {
    const keys: { key: string; size: number }[] = []
    const abort = new AbortController()
    await this.scanTree(
      bucket,
      prefix,
      (objects) => {
        for (const o of objects) if (o.Key) keys.push({ key: o.Key, size: o.Size ?? 0 })
        if (keys.length > MAX_TREE)
          abort.abort(new Error(`The folder has too many objects (more than ${MAX_TREE})`))
      },
      abort.signal
    )
    return keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  /** Xoá object và cả "thư mục" (key kết thúc "/"). Trả về số object đã xoá. */
  /** Mỗi lô xoá là 1000 object — vài lô cùng lúc là đủ. */
  private get deleteParallel(): number {
    return Math.max(2, Math.floor(this.requests / 4))
  }

  private async remove(bucket: string, keys: readonly string[]): Promise<number> {
    const all = new Set<string>(keys)
    const trees = await mapLimit(
      keys.filter((k) => k.endsWith('/')),
      this.deleteParallel,
      (key) => this.allKeys(bucket, key)
    )
    for (const tree of trees) for (const k of tree) all.add(k.key)
    await this.deleteExact(bucket, [...all])
    return all.size
  }

  /** Xoá đúng các key này (không đệ quy): lô 1000 key, nhiều lô song song. */
  private async deleteExact(bucket: string, list: readonly string[]): Promise<void> {
    const batches: string[][] = []
    for (let i = 0; i < list.length; i += 1000) batches.push(list.slice(i, i + 1000))
    await mapLimit(batches, this.deleteParallel, async (batch) => {
      const out = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true }
        })
      )
      const failed = out.Errors?.[0]
      if (failed) throw new Error(`Could not delete ${failed.Key ?? ''}: ${failed.Message ?? ''}`)
    })
  }

  // ---------- Thống kê ----------

  /** Bắt đầu thống kê chạy nền (song song); renderer hỏi tiến độ bằng `statsPoll`. */
  private startStats(bucket: string, prefix: string): string {
    const id = randomUUID()
    const abort = new AbortController()
    const progress: S3StatsProgress = {
      objects: 0,
      bytes: 0,
      byClass: {},
      done: false,
      error: null
    }
    this.statsJobs.set(id, { progress, abort })
    this.scanTree(
      bucket,
      prefix,
      (objects) => {
        for (const o of objects) {
          const size = o.Size ?? 0
          // Object "thư mục" rỗng (New folder) không phải dữ liệu.
          if (!o.Key || (o.Key.endsWith('/') && size === 0)) continue
          const cls = o.StorageClass ?? 'STANDARD'
          const cur = progress.byClass[cls] ?? { objects: 0, bytes: 0 }
          progress.byClass[cls] = { objects: cur.objects + 1, bytes: cur.bytes + size }
          progress.objects++
          progress.bytes += size
        }
      },
      abort.signal
    ).then(
      () => {
        progress.done = true
      },
      (error: unknown) => {
        progress.done = true
        if (!abort.signal.aborted) progress.error = errorText(error)
      }
    )
    return id
  }

  private pollStats(id: string): S3StatsProgress {
    const job = this.statsJobs.get(id)
    if (!job) throw new Error('The statistics were stopped')
    // Bản sao: object gốc vẫn đang được cộng dồn.
    const snapshot = { ...job.progress, byClass: { ...job.progress.byClass } }
    if (snapshot.done) this.statsJobs.delete(id)
    return snapshot
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

  private copyObject(bucket: string, destBucket: string, pair: CopyPair): Promise<void> {
    return serverCopy(
      this.client,
      { bucket, key: pair.from },
      { bucket: destBucket, key: pair.to },
      pair.size
    )
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
    await Promise.all(Array.from({ length: Math.min(this.requests, pairs.length) }, worker))
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
      queueSize: UPLOAD_QUEUE,
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

  /** Editor trong app: đọc cả object (nhỏ) vào bộ nhớ. */
  private async readText(
    bucket: string,
    key: string
  ): Promise<{ data: string; size: number; etag: string | null }> {
    const head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    const size = head.ContentLength ?? 0
    if (size > S3_EDIT_MAX_BYTES) throw new Error('The object is too large for the editor')
    const out = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const chunks: Buffer[] = []
    for await (const chunk of out.Body as Readable) chunks.push(chunk as Buffer)
    return { data: Buffer.concat(chunks).toString('base64'), size, etag: out.ETag ?? null }
  }

  /** Editor trong app: ghi đè object, giữ Content-Type / metadata; kiểm tra ETag nếu có. */
  private async writeText(
    bucket: string,
    key: string,
    data: Buffer,
    expectEtag: string | undefined
  ): Promise<{ etag: string | null; size: number }> {
    if (data.length > S3_EDIT_MAX_BYTES) throw new Error('The object is too large for the editor')
    const head = await this.client
      .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      .catch((error: unknown) => {
        if (isNotFound(error)) return null
        throw error
      })
    if (expectEtag && head && head.ETag !== expectEtag) throw new Error(S3_OBJECT_CHANGED)
    const out = await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ...(head?.ContentType ? { ContentType: head.ContentType } : {}),
        ...(head?.CacheControl ? { CacheControl: head.CacheControl } : {}),
        ...(head?.ContentDisposition ? { ContentDisposition: head.ContentDisposition } : {}),
        ...(head?.Metadata ? { Metadata: head.Metadata } : {})
      })
    )
    return { etag: out.ETag ?? null, size: data.length }
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
      if (this.running >= this.maxTransfers) return
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
    for (const job of this.statsJobs.values()) job.abort.abort()
    this.statsJobs.clear()
    for (const job of this.syncJobs.values()) job.stop()
    this.syncJobs.clear()
    for (const job of this.jobs.values()) job.abort.abort()
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.client.destroy()
  }
}
