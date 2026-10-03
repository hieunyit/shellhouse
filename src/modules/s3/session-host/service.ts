import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client
} from '@aws-sdk/client-s3'
import type { _Object } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  hostNameOptions,
  safeFileName,
  safeRelativeSegments,
  UniqueNames
} from '@shared/file-names'
import {
  S3_EDIT_MAX_BYTES,
  S3_LIST_PAGE,
  S3_OBJECT_CHANGED,
  type S3Bucket,
  type S3BucketInfo,
  type S3BulkJob,
  type S3Entry,
  type S3Listing,
  type S3Op,
  type S3StatsProgress,
  type S3TransferDelta,
  type S3UploadConflict
} from '../shared/ops'
import type { TransferStatus } from '@shared/sftp'
import { t, tn } from '@shared/i18n'
import { formatNumber } from '@shared/i18n/format'
import {
  accountRegion,
  createBucketInput,
  createS3Client,
  errorText,
  isConditionalWriteUnsupported,
  isNotFound,
  isPreconditionFailed,
  preservedAttributes,
  scanObjects,
  type S3Connection
} from './client'
import { BulkJob, countObjects, deleteErrorSummary, lastName, type BulkEnv } from './bulk'
import * as manage from './manage'
import { S3Edits } from './edit'
import { SyncJob } from './sync'

export type { S3Connection } from './client'

/** Tải cả thư mục về máy: tối đa chừng này file mỗi lần (mỗi file là một dòng trong Transfers). */
const MAX_TREE = 10_000

const PART_SUFFIX = '.shellhouse-part'
const PROGRESS_MS = 250
/** Mặc định (chỉnh trong Settings → Files): request cùng lúc khi quét / copy / xoá, file cùng lúc. */
export const DEFAULT_S3_LIMITS = { requests: 16, transfers: 6 } as const
/** Mỗi file lớn tự chia phần gửi song song (lib-storage). */
const UPLOAD_QUEUE = 4
/** Phần nhỏ nhất khi tải lên; file > 78 GiB thì phần to dần (S3 cho tối đa 10 000 phần). */
const UPLOAD_PART = 8 * 1024 * 1024
/** Việc nền (thống kê, đồng bộ, xoá / copy) không ai hỏi tiến độ quá lâu → dừng và dọn. */
const JOB_TTL_MS = 2 * 60 * 1000
/** HeadBucket lỗi mà không có header region: dùng region tài khoản trong khoảng này rồi hỏi lại. */
const REGION_FALLBACK_MS = 5 * 60 * 1000

/** Header `x-amz-bucket-region` trong lỗi HeadBucket (301 / 400 / 403 của AWS vẫn gửi kèm). */
export function bucketRegionHeader(error: unknown): string | null {
  const response = (error as { $response?: { statusCode?: number; headers?: unknown } } | null)
    ?.$response
  if (!response || ![301, 400, 403].includes(response.statusCode ?? 0)) return null
  const headers = response.headers as Record<string, string | undefined> | undefined
  const region = headers?.['x-amz-bucket-region'] ?? headers?.['X-Amz-Bucket-Region']
  return typeof region === 'string' && /^[a-z0-9-]+$/.test(region) ? region : null
}
/** Đóng tab: chờ tối đa chừng này cho các lượt huỷ (AbortMultipartUpload) gửi xong. */
const DISPOSE_WAIT_MS = 3000

/** Thuộc tính object giữ lại khi tải lên đè (sửa file). */
export type ObjectAttributes = ReturnType<typeof preservedAttributes>

interface Job {
  status: TransferStatus
  run: (job: Job) => Promise<void>
  abort: AbortController
  /** Báo kết thúc (xong / lỗi / huỷ) cho ai đang chờ job này. */
  settle?: (error: Error | null) => void
  /** Đang chạy: promise kết thúc hẳn (kể cả dọn dẹp sau khi huỷ). */
  running?: Promise<void>
}

/** Phần thân đường dẫn `target` có nằm trong `root` không (chặn "..", đường dẫn tuyệt đối). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  // "..x" là tên hợp lệ bên trong; chỉ ".." hoặc "../…" mới là thoát ra ngoài.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const NAME_OPTIONS = hostNameOptions(process.platform)

/** `root` + đường dẫn tương đối kiểu key S3 → đường dẫn an toàn trong `root` (không thì lỗi). */
export function safeLocalTarget(root: string, rel: string, options = NAME_OPTIONS): string {
  const target = join(root, ...safeRelativeSegments(rel, options))
  if (!isInside(root, target))
    throw new Error(t('Unsafe file name in the bucket: {name}', { name: rel }))
  return target
}

/**
 * Nhiều đường dẫn tương đối (key trong một thư mục S3) → đường dẫn trong `root`, KHÔNG trùng nhau:
 * hai key khác nhau ra cùng tên an toàn ("a:b" / "a_b", "a//b" / "a/_/b", "x." / "x" trên Windows,
 * "A" / "a" trên ổ không phân biệt hoa thường) thì key sau thêm " (2)"… Đường dẫn không phải đổi
 * gì được giữ đúng tên. File và thư mục cùng tên gốc là hai mục khác nhau.
 */
export function planLocalTargets(
  root: string,
  rels: readonly string[],
  options: ConstructorParameters<typeof UniqueNames>[0] = NAME_OPTIONS
): string[] {
  const dirs = new Map<string, UniqueNames>()
  const plan = (rel: string): string => {
    const parts = rel.split('/')
    const out: string[] = []
    // Id thư mục cha theo tên GỐC (tên gốc không chứa "/" → không nhập nhằng).
    let parent = ''
    parts.forEach((part, i) => {
      let names = dirs.get(parent)
      if (!names) {
        names = new UniqueNames(options)
        dirs.set(parent, names)
      }
      out.push(names.name(`${i === parts.length - 1 ? 'f' : 'd'}:${part}`, part))
      parent += `/${part}`
    })
    const target = join(root, ...out)
    if (!isInside(root, target))
      throw new Error(t('Unsafe file name in the bucket: {name}', { name: rel }))
    return target
  }
  const unchanged = (rel: string): boolean =>
    rel.split('/').every((part) => safeFileName(part, options) === part)
  const order = rels
    .map((_, i) => i)
    .sort((a, b) => Number(!unchanged(rels[a] ?? '')) - Number(!unchanged(rels[b] ?? '')))
  const out = new Array<string>(rels.length)
  for (const i of order) out[i] = plan(rels[i] ?? '')
  return out
}

/** Thao tác S3 của một tab + hàng đợi truyền file (chạy trong Session Host). */
export class S3Service {
  private readonly client: S3Client
  private readonly region: string
  /** Endpoint tự đặt (MinIO…): một client cho mọi bucket; AWS: client theo region của bucket. */
  private readonly custom: boolean
  private readonly regionClients = new Map<string, S3Client>()
  private readonly bucketRegions = new Map<string, string>()
  private readonly regionLookups = new Map<string, Promise<string>>()
  /** Bucket hỏi region bị lỗi → dùng region tài khoản tới mốc này (ms). */
  private readonly regionFallbacks = new Map<string, number>()
  private readonly versioningCache = new Map<string, S3BucketInfo['versioning']>()
  private readonly jobs = new Map<string, Job>()
  /** Hàng đợi id job đang chờ (FIFO) — pump không phải duyệt cả danh sách mỗi lần. */
  private queue: string[] = []
  private queueHead = 0
  private running = 0
  private notifyTimer: NodeJS.Timeout | null = null
  /** Job đổi từ lần báo trước / đã bị xoá khỏi danh sách (gửi renderer phần thay đổi). */
  private readonly dirty = new Set<string>()
  private readonly removed = new Set<string>()
  private disposed = false
  private edits: S3Edits | null = null
  private readonly statsJobs = new Map<
    string,
    { progress: S3StatsProgress; abort: AbortController; touched: number }
  >()
  private readonly syncJobs = new Map<
    string,
    { job: SyncJob; touched: number; finished: Promise<void> }
  >()
  private readonly bulkJobs = new Map<string, BulkJob>()
  /** Dịch vụ từ chối If-Match khi ghi → bỏ header (vẫn kiểm tra ETag bằng HEAD). */
  private conditionalWrites = true

  private readonly requests: number
  private readonly maxTransfers: number
  private readonly maxSockets: number

  constructor(
    private readonly connection: S3Connection,
    private readonly onTransfers: (delta: S3TransferDelta) => void,
    limits: { requests: number; transfers: number } = DEFAULT_S3_LIMITS,
    /** Kết nối của tài khoản khác (đích đồng bộ) — main giải mã secret. */
    private readonly resolveAccount: (accountId: string) => Promise<S3Connection> = () =>
      Promise.reject(new Error(t('Other accounts are not available here')))
  ) {
    this.requests = limits.requests
    this.maxTransfers = limits.transfers
    // Đủ socket cho mọi request song song (quét + các phần của file đang truyền).
    this.maxSockets = this.requests + this.maxTransfers * UPLOAD_QUEUE + 4
    this.region = accountRegion(connection)
    this.custom = connection.endpoint !== ''
    this.client = createS3Client(connection, this.maxSockets)
  }

  async run(op: S3Op): Promise<unknown> {
    try {
      return await this.dispatch(op)
    } catch (error) {
      throw new Error(errorText(error), { cause: error })
    }
  }

  // ---------- Client theo region của bucket ----------

  /**
   * Client đúng region của bucket. AWS: bucket ở region khác region của tài khoản thì request tới
   * endpoint mặc định bị 301 — followRegionRedirects cứu được nhưng tốn thêm một vòng mỗi request,
   * còn link chia sẻ thì ký sai region. Region lấy từ ListBuckets (BucketRegion) hoặc HeadBucket.
   */
  async clientFor(bucket: string): Promise<S3Client> {
    if (this.custom) return this.client
    const known = this.bucketRegions.get(bucket)
    if (known) return this.clientForRegion(known)
    if ((this.regionFallbacks.get(bucket) ?? 0) > Date.now()) return this.client
    const region = await this.lookupRegion(bucket)
    return this.clientForRegion(region)
  }

  private clientForRegion(region: string): S3Client {
    if (region === this.region) return this.client
    let client = this.regionClients.get(region)
    if (!client) {
      client = createS3Client(this.connection, this.maxSockets, region)
      this.regionClients.set(region, client)
    }
    return client
  }

  private lookupRegion(bucket: string): Promise<string> {
    let pending = this.regionLookups.get(bucket)
    if (!pending) {
      pending = this.client
        .send(new HeadBucketCommand({ Bucket: bucket }))
        .then(
          (out) => {
            const region = out.BucketRegion || this.region
            this.bucketRegions.set(bucket, region)
            return region
          },
          (error: unknown) => {
            // 301/400/403 vẫn kèm header region thật của bucket → nhớ luôn.
            const hinted = bucketRegionHeader(error)
            if (hinted) {
              this.bucketRegions.set(bucket, hinted)
              return hinted
            }
            // Không hỏi được (chưa có bucket, không có quyền…): dùng region tài khoản, nhớ một lúc
            // để mỗi thao tác không tốn thêm một HeadBucket lỗi.
            this.regionFallbacks.set(bucket, Date.now() + REGION_FALLBACK_MS)
            return this.region
          }
        )
        .finally(() => this.regionLookups.delete(bucket))
      this.regionLookups.set(bucket, pending)
    }
    return pending
  }

  private get env(): BulkEnv {
    return {
      clientFor: (bucket) => this.clientFor(bucket),
      requests: this.requests,
      deleteParallel: this.deleteParallel
    }
  }

  private async dispatch(op: S3Op): Promise<unknown> {
    this.sweepJobs()
    switch (op.op) {
      case 'listBuckets':
        return this.listBuckets()
      case 'createBucket':
        await this.client.send(new CreateBucketCommand(createBucketInput(op.bucket, this.region)))
        if (!this.custom) this.bucketRegions.set(op.bucket, this.region)
        return null
      case 'list':
        return this.list(op.bucket, op.prefix, op.token)
      case 'mkdir':
        await (
          await this.clientFor(op.bucket)
        ).send(
          new PutObjectCommand({
            Bucket: op.bucket,
            Key: op.key.endsWith('/') ? op.key : `${op.key}/`,
            Body: ''
          })
        )
        return null
      case 'delete':
        return this.runBulk({ kind: 'delete', bucket: op.bucket, keys: op.keys })
      case 'jobStart': {
        const id = randomUUID()
        this.bulkJobs.set(id, new BulkJob(this.env, op.job))
        return id
      }
      case 'jobPoll': {
        const job = this.bulkJobs.get(op.id)
        if (!job) throw new Error(t('The operation was stopped'))
        const snapshot = job.snapshot()
        if (job.done) this.bulkJobs.delete(op.id)
        return snapshot
      }
      case 'jobStop': {
        const job = this.bulkJobs.get(op.id)
        job?.stop()
        return job?.snapshot() ?? null
      }
      case 'countObjects':
        return countObjects(this.env, op.bucket, op.keys, op.limit)
      case 'versioning':
        return this.versioning(op.bucket)
      case 'presign':
        return getSignedUrl(
          await this.clientFor(op.bucket),
          new GetObjectCommand({ Bucket: op.bucket, Key: op.key, VersionId: op.versionId }),
          { expiresIn: op.expiresSeconds }
        )
      case 'upload':
        return this.enqueueUpload(op.bucket, op.prefix, op.localPath, op.overwrite ?? true)
      case 'uploadCheck':
        return this.uploadCheck(op.bucket, op.prefix, op.localPaths)
      case 'download':
        return this.enqueueDownload(
          op.bucket,
          op.key,
          op.localPath,
          op.overwrite,
          op.intoFolder ?? false,
          op.versionId
        )
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
        return this.runBulk({
          kind: 'copy',
          bucket: op.bucket,
          keys: op.keys,
          destBucket: op.destBucket,
          destPrefix: op.destPrefix,
          move: op.move,
          overwrite: op.overwrite
        })
      case 'rename':
        return this.runBulk({
          kind: 'rename',
          bucket: op.bucket,
          key: op.key,
          name: op.name,
          overwrite: op.overwrite
        })
      case 'edit':
        this.edits ??= new S3Edits(this)
        await this.edits.open(op.bucket, op.key, op.localPath)
        return null
      case 'cancel': {
        const ids = [...(op.transferIds ?? []), ...(op.transferId ? [op.transferId] : [])]
        for (const id of ids) this.cancel(id)
        this.notify(true)
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
        const entry = this.syncJobs.get(op.id)
        if (!entry) throw new Error(t('The sync was stopped'))
        entry.touched = Date.now()
        const snapshot = entry.job.snapshot()
        if (entry.job.finished) this.syncJobs.delete(op.id)
        return snapshot
      }
      case 'syncStop': {
        const entry = this.syncJobs.get(op.id)
        entry?.job.stop()
        return entry?.job.snapshot() ?? null
      }
      case 'clearDone':
        // "Clear finished": cả lượt xong, lỗi và đã huỷ.
        for (const [id, job] of this.jobs)
          if (
            job.status.state === 'done' ||
            job.status.state === 'error' ||
            job.status.state === 'cancelled'
          )
            this.forget(id)
        this.notify(true)
        return null
      default:
        return this.manage(op)
    }
  }

  /** Versioning, lifecycle, CORS, metadata, tag, phiên bản object (session-host/manage.ts). */
  private async manage(op: S3Op): Promise<unknown> {
    if (!('bucket' in op)) throw new Error(`Unknown operation ${op.op}`)
    const client = await this.clientFor(op.bucket)
    switch (op.op) {
      case 'getVersioning': {
        const status = await manage.readVersioning(client, op.bucket)
        this.versioningCache.set(op.bucket, status.state === 'ok' ? status.value : null)
        return status
      }
      case 'setVersioning':
        await manage.writeVersioning(client, op.bucket, op.enabled)
        this.versioningCache.set(op.bucket, op.enabled ? 'Enabled' : 'Suspended')
        return null
      case 'getLifecycle':
        return manage.readLifecycle(client, op.bucket)
      case 'putLifecycle':
        await manage.writeLifecycle(client, op.bucket, op.rules)
        return null
      case 'getCors':
        return manage.readCors(client, op.bucket)
      case 'putCors':
        await manage.writeCors(client, op.bucket, op.rules)
        return null
      case 'objectDetails':
        return manage.objectDetails(client, op.bucket, op.key, op.versionId)
      case 'updateObject':
        return manage.updateObject(client, op.bucket, op.key, op.edit, op.expectEtag)
      case 'putTags':
        await manage.writeTags(client, op.bucket, op.key, op.tags, op.versionId)
        return null
      case 'listVersions':
        return manage.listVersions(client, op)
      case 'objectVersions':
        return manage.objectVersions(client, op.bucket, op.key)
      case 'restoreVersion':
        await manage.restoreVersion(client, op.bucket, op.key, op.versionId)
        return null
      case 'deleteVersions':
        return manage.deleteVersions(client, op.bucket, op.items)
      default:
        throw new Error(`Unknown operation ${(op as { op: string }).op}`)
    }
  }

  /** Việc nền chạy rồi chờ xong (op cũ `delete` / `copy` / `rename`): trả về số object. */
  private async runBulk(spec: S3BulkJob): Promise<number> {
    const job = new BulkJob(this.env, spec)
    // Ghi vào bulkJobs để dispose dừng được; không ai poll nên giữ `touched` mới cho sweep khỏi dọn.
    const id = randomUUID()
    this.bulkJobs.set(id, job)
    const keepAlive = setInterval(() => {
      job.touched = Date.now()
    }, JOB_TTL_MS / 2)
    try {
      await job.finished
    } finally {
      clearInterval(keepAlive)
      this.bulkJobs.delete(id)
    }
    const p = job.snapshot()
    if (p.error) throw new Error(p.error)
    if (p.failed > 0) {
      if (spec.kind === 'delete') throw new Error(deleteErrorSummary(p.errors, p.failed))
      const first = p.errors[0]
      throw new Error(
        first
          ? tn(
              p.failed,
              '{n} object failed — {key}: {message}',
              '{n} objects failed — {key}: {message}',
              {
                key: first.key,
                message: first.message
              }
            )
          : tn(p.failed, '{n} object failed', '{n} objects failed')
      )
    }
    return p.done
  }

  /** Dọn việc nền không ai hỏi tiến độ nữa (renderer đóng hộp thoại / bị reload giữa chừng). */
  private sweepJobs(): void {
    const old = Date.now() - JOB_TTL_MS
    for (const [id, job] of this.statsJobs)
      if (job.touched < old) {
        job.abort.abort()
        this.statsJobs.delete(id)
      }
    for (const [id, entry] of this.syncJobs)
      if (entry.touched < old) {
        entry.job.stop()
        this.syncJobs.delete(id)
      }
    for (const [id, job] of this.bulkJobs)
      if (job.touched < old) {
        job.stop()
        this.bulkJobs.delete(id)
      }
  }

  private async listBuckets(client: S3Client = this.client): Promise<S3Bucket[]> {
    const out = await client.send(new ListBucketsCommand({}))
    const list = (out.Buckets ?? [])
      .map((b) => ({
        name: b.Name ?? '',
        createdAt: b.CreationDate?.getTime() ?? null,
        region: b.BucketRegion ?? null
      }))
      .filter((b) => b.name)
      .sort((a, b) => a.name.localeCompare(b.name))
    // Nhớ region từng bucket (AWS) — request sau tới thẳng đúng region.
    if (client === this.client && !this.custom)
      for (const b of list) if (b.region) this.bucketRegions.set(b.name, b.region)
    return list
  }

  /** Region / versioning / mã hoá — mỗi mục một request; dịch vụ không hỗ trợ thì null. */
  private async bucketInfo(bucket: string): Promise<S3BucketInfo> {
    const client = await this.clientFor(bucket)
    const [location, versioning, encryption] = await Promise.allSettled([
      client.send(new GetBucketLocationCommand({ Bucket: bucket })),
      client.send(new GetBucketVersioningCommand({ Bucket: bucket })),
      client.send(new GetBucketEncryptionCommand({ Bucket: bucket }))
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
    const status =
      versioning.status === 'fulfilled'
        ? versioning.value.Status === 'Enabled' || versioning.value.Status === 'Suspended'
          ? versioning.value.Status
          : 'Off'
        : null
    this.versioningCache.set(bucket, status)
    return {
      // ListBuckets cũ / dịch vụ khác: LocationConstraint rỗng = us-east-1.
      region:
        location.status === 'fulfilled' ? location.value.LocationConstraint || 'us-east-1' : null,
      versioning: status,
      encryption: rule?.SSEAlgorithm
        ? `${rule.SSEAlgorithm}${rule.KMSMasterKeyID ? ` (${rule.KMSMasterKeyID})` : ''}`
        : encryptionCode === 'ServerSideEncryptionConfigurationNotFoundError'
          ? 'None'
          : null
    }
  }

  /** Versioning của bucket (cho câu cảnh báo khi xoá) — nhớ trong phiên. */
  private async versioning(bucket: string): Promise<S3BucketInfo['versioning']> {
    if (this.versioningCache.has(bucket)) return this.versioningCache.get(bucket) ?? null
    const status = await (
      await this.clientFor(bucket)
    )
      .send(new GetBucketVersioningCommand({ Bucket: bucket }))
      .then(
        (out) =>
          out.Status === 'Enabled' || out.Status === 'Suspended' ? out.Status : ('Off' as const),
        () => null
      )
    this.versioningCache.set(bucket, status)
    return status
  }

  // ---------- Đồng bộ ----------

  private async startSync(op: Extract<S3Op, { op: 'syncStart' }>): Promise<string> {
    const destConnection = op.dest.accountId ? await this.resolveAccount(op.dest.accountId) : null
    const destClient = destConnection ? createS3Client(destConnection, this.requests + 8) : null
    const id = randomUUID()
    const job = new SyncJob(
      {
        source: await this.clientFor(op.bucket),
        dest: destClient ?? (await this.clientFor(op.dest.bucket)),
        destRegion: destConnection ? accountRegion(destConnection) : this.region,
        serverSide: destClient === null,
        concurrency: destClient ? Math.max(4, this.maxTransfers) : this.requests,
        scanConcurrency: this.requests
      },
      op
    )
    const finished = job.run().finally(() => {
      destClient?.destroy()
    })
    this.syncJobs.set(id, { job, touched: Date.now(), finished })
    return id
  }

  async list(bucket: string, prefix: string, startToken?: string): Promise<S3Listing> {
    const client = await this.clientFor(bucket)
    const entries: S3Entry[] = []
    let token: string | undefined = startToken
    let truncated = false
    do {
      const out = await client.send(
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
      if (entries.length >= S3_LIST_PAGE && token) {
        truncated = true
        break
      }
    } while (token)
    entries.sort((a, b) =>
      a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1
    )
    return {
      bucket,
      prefix,
      entries,
      truncated,
      ...(truncated && token ? { nextToken: token } : {})
    }
  }

  private async scanTree(
    bucket: string,
    prefix: string,
    onObjects: (objects: readonly _Object[]) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return scanObjects(
      await this.clientFor(bucket),
      bucket,
      prefix,
      this.requests,
      onObjects,
      signal
    )
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
          abort.abort(
            new Error(
              t('The folder has too many objects (more than {n})', { n: formatNumber(MAX_TREE) })
            )
          )
      },
      abort.signal
    )
    // scanObjects dừng êm khi bị huỷ — báo lý do (quá nhiều object) thay vì trả về nửa chừng.
    if (abort.signal.aborted) throw abort.signal.reason
    return keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  /** Mỗi lô xoá là 1000 object — vài lô cùng lúc là đủ. */
  private get deleteParallel(): number {
    return Math.max(2, Math.floor(this.requests / 4))
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
    this.statsJobs.set(id, { progress, abort, touched: Date.now() })
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
    if (!job) throw new Error(t('The statistics were stopped'))
    job.touched = Date.now()
    // Bản sao: object gốc vẫn đang được cộng dồn.
    const snapshot = { ...job.progress, byClass: { ...job.progress.byClass } }
    if (snapshot.done) this.statsJobs.delete(id)
    return snapshot
  }

  // ---------- Sửa file (S3Edits) ----------

  async head(bucket: string, key: string): Promise<{ etag: string | null; contentType: string }> {
    const out = await (
      await this.clientFor(bucket)
    ).send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return { etag: out.ETag ?? null, contentType: out.ContentType ?? '' }
  }

  /** Tải object về (qua hàng đợi, hiện trong Transfers) và chờ xong. */
  async downloadAndWait(
    bucket: string,
    key: string,
    localPath: string
  ): Promise<{ etag: string | null; attributes: ObjectAttributes }> {
    let info: { etag: string | null; attributes: ObjectAttributes } = {
      etag: null,
      attributes: {}
    }
    await this.addAndWait('download', localPath, `s3://${bucket}/${key}`, false, async (job) => {
      info = await this.download(job, bucket, key, localPath)
    })
    return info
  }

  /**
   * Tải file lên đè object — chỉ khi object trên server vẫn là bản `expectEtag` (không thì báo lỗi,
   * không ghi đè thay đổi của người khác). Giữ Content-Type, metadata, storage class của object.
   * Trả về ETag mới.
   */
  async uploadIfUnchanged(
    bucket: string,
    key: string,
    localPath: string,
    expectEtag: string | null,
    attributes: ObjectAttributes
  ): Promise<string | null> {
    let etag: string | null = null
    const changed = (): Error =>
      new Error(
        t(
          'The object was changed on the server since you opened it — not overwritten. Open it again to edit the latest version.'
        )
      )
    await this.addAndWait('upload', localPath, `s3://${bucket}/${key}`, true, async (job) => {
      const current = await this.head(bucket, key).catch((error: unknown) => {
        if (isNotFound(error)) return { etag: null }
        throw error
      })
      if (expectEtag !== null && current.etag !== expectEtag) throw changed()
      // If-Match: chặn cả trường hợp người khác ghi đè giữa HEAD ở trên và lúc tải lên xong.
      const condition =
        expectEtag !== null && this.conditionalWrites ? { IfMatch: expectEtag } : undefined
      try {
        await this.upload(job, bucket, key, localPath, { ...attributes, ...condition })
      } catch (error) {
        if (condition && isPreconditionFailed(error)) throw changed()
        if (!condition || !isConditionalWriteUnsupported(error)) throw error
        this.conditionalWrites = false
        await this.upload(job, bucket, key, localPath, attributes)
      }
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

  /** Thêm một lượt vào hàng đợi. Báo renderer gộp lại (thêm 5 000 file = vài tin, không 5 000 tin). */
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
    this.queue.push(id)
    this.touch(id)
    this.pump()
    return id
  }

  private cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.abort.abort()
    if (job.status.state === 'queued') {
      job.status.state = 'cancelled'
      job.settle?.(new Error(t('Cancelled')))
      this.touch(id)
    }
  }

  private forget(id: string): void {
    this.jobs.delete(id)
    this.dirty.delete(id)
    this.removed.add(id)
  }

  /** Các file sẽ tải lên từ một đường dẫn trên máy (file hoặc cả thư mục). */
  private async localPlan(
    prefix: string,
    localPath: string
  ): Promise<{ isFolder: boolean; folderKey: string; files: { local: string; key: string }[] }> {
    const info = await stat(localPath)
    const base = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix
    if (info.isFile())
      return {
        isFolder: false,
        folderKey: '',
        files: [{ local: localPath, key: base + basename(localPath) }]
      }
    const files: { local: string; key: string }[] = []
    const walk = async (dir: string, keyPrefix: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (files.length > MAX_TREE) throw new Error(t('The folder has too many files'))
        if (e.isSymbolicLink()) continue
        const child = join(dir, e.name)
        if (e.isDirectory()) await walk(child, `${keyPrefix}${e.name}/`)
        else if (e.isFile()) files.push({ local: child, key: keyPrefix + e.name })
      }
    }
    const folderKey = `${base}${basename(localPath)}/`
    await walk(localPath, folderKey)
    return { isFolder: true, folderKey, files }
  }

  /** Key nào trong `files` đã có trên bucket (một HEAD cho file lẻ, quét thư mục cho cả thư mục). */
  private async existingKeys(
    bucket: string,
    plan: { isFolder: boolean; folderKey: string; files: { key: string }[] }
  ): Promise<Set<string>> {
    const found = new Set<string>()
    if (!plan.isFolder) {
      const key = plan.files[0]?.key
      if (key === undefined) return found
      try {
        await (
          await this.clientFor(bucket)
        ).send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        found.add(key)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      return found
    }
    const wanted = new Set(plan.files.map((f) => f.key))
    await this.scanTree(bucket, plan.folderKey, (objects) => {
      for (const o of objects) if (o.Key && wanted.has(o.Key)) found.add(o.Key)
    })
    return found
  }

  private async uploadCheck(
    bucket: string,
    prefix: string,
    localPaths: readonly string[]
  ): Promise<S3UploadConflict[]> {
    const out: S3UploadConflict[] = []
    for (const localPath of localPaths) {
      const plan = await this.localPlan(prefix, localPath)
      // Khoá chỉ có quyền ghi (không đọc / liệt kê được) → coi như không trùng, vẫn cho tải lên.
      const existing = await this.existingKeys(bucket, plan).catch(() => new Set<string>())
      out.push({
        localPath,
        name: basename(localPath),
        isFolder: plan.isFolder,
        files: plan.files.length,
        existing: existing.size
      })
    }
    return out
  }

  /**
   * File hoặc cả thư mục trên máy → s3://bucket/prefix. `overwrite: false` = bỏ qua file đã có.
   * Trả về số file đã xếp hàng.
   */
  private async enqueueUpload(
    bucket: string,
    prefix: string,
    localPath: string,
    overwrite: boolean
  ): Promise<number> {
    const plan = await this.localPlan(prefix, localPath)
    const skip = overwrite ? new Set<string>() : await this.existingKeys(bucket, plan)
    let count = 0
    for (const f of plan.files) {
      if (skip.has(f.key)) continue
      this.add('upload', f.local, `s3://${bucket}/${f.key}`, (job) =>
        this.upload(job, bucket, f.key, f.local)
      )
      count++
    }
    return count
  }

  private async upload(
    job: Job,
    bucket: string,
    key: string,
    localPath: string,
    extra: ObjectAttributes & { IfMatch?: string } = {}
  ): Promise<void> {
    const size = (await stat(localPath)).size
    job.status.size = size
    const client = await this.clientFor(bucket)
    // lib-storage: tự chia nhiều phần (multipart) cho file lớn, gửi song song. Mỗi job một
    // AbortController riêng (lib-storage gán đè signal.onabort).
    const upload = new Upload({
      client,
      params: { Bucket: bucket, Key: key, Body: createReadStream(localPath), ...extra },
      abortController: job.abort,
      queueSize: UPLOAD_QUEUE,
      // S3 cho tối đa 10 000 phần: file rất lớn thì phần to ra (dư một chút cho chắc).
      partSize: Math.max(UPLOAD_PART, Math.ceil(size / 9000))
    })
    const meter = this.meter(job)
    upload.on('httpUploadProgress', (p) => {
      meter(p.loaded ?? 0)
    })
    try {
      await upload.done()
    } catch (error) {
      // Huỷ: done() trả lỗi ngay, còn AbortMultipartUpload của lib-storage chạy sau (có thể không kịp
      // gửi nếu tab đóng) — tự gửi để không để lại phần rác tính tiền trên bucket.
      const uploadId = (upload as unknown as { uploadId?: string }).uploadId
      if (job.abort.signal.aborted && uploadId)
        await client
          .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
          .catch(() => undefined)
      throw error
    }
  }

  /** Object → file; key kết thúc "/" = cả thư mục vào `localParent/<tên>`. */
  private async enqueueDownload(
    bucket: string,
    key: string,
    localPath: string,
    overwrite: boolean,
    intoFolder: boolean,
    versionId?: string
  ): Promise<number> {
    if (!key.endsWith('/')) {
      // Tên file từ key (không tin tên renderer ghép: "..\\..\\x.exe" trên Windows). Tải nhiều
      // object vào cùng thư mục: tên an toàn trùng với lượt tải đang chờ / đang chạy → thêm " (2)"
      // (hai lượt ghi chung một file .part sẽ hỏng cả hai).
      const target = intoFolder ? this.freeDownloadTarget(localPath, lastName(key)) : localPath
      if (!overwrite && existsSync(target))
        throw new Error(t('The destination file already exists'))
      this.add('download', target, `s3://${bucket}/${key}`, async (job) => {
        await this.download(job, bucket, key, target, versionId)
      })
      return 1
    }
    const folderName = safeFileName(basename(key.replace(/\/$/, '')) || bucket, NAME_OPTIONS)
    const root = join(localPath, folderName)
    if (existsSync(root) && !overwrite)
      throw new Error(t('A folder with this name already exists at the destination'))
    const objects = await this.allKeys(bucket, key)
    // Object "thư mục" (key kết thúc "/") bỏ qua. Key "a/../../.bashrc" không được ghi ra ngoài
    // thư mục đích; hai key ra cùng tên an toàn không ghi chung một file.
    const files = objects.filter((o) => {
      const rel = o.key.slice(key.length)
      return rel !== '' && !rel.endsWith('/')
    })
    const planned = planLocalTargets(
      root,
      files.map((o) => o.key.slice(key.length))
    )
    const targets = files.map((o, i) => ({ key: o.key, target: planned[i] ?? '' }))
    await mkdir(root, { recursive: true })
    for (const t of targets)
      this.add('download', t.target, `s3://${bucket}/${t.key}`, async (job) => {
        await this.download(job, bucket, t.key, t.target)
      })
    return targets.length
  }

  /** Tên file trong `dir` không trùng file một lượt tải khác đang chờ / đang chạy sẽ ghi. */
  private freeDownloadTarget(dir: string, name: string): string {
    const busy: string[] = []
    for (const job of this.jobs.values()) {
      const st = job.status
      if (st.direction !== 'download' || (st.state !== 'queued' && st.state !== 'running')) continue
      if (relative(dir, dirname(st.localPath)) === '') busy.push(basename(st.localPath))
    }
    const target = join(dir, new UniqueNames(NAME_OPTIONS, busy).name('', name))
    if (!isInside(dir, target))
      throw new Error(t('Unsafe file name in the bucket: {name}', { name }))
    return target
  }

  /** Editor trong app: đọc cả object (nhỏ) vào bộ nhớ. */
  private async readText(
    bucket: string,
    key: string
  ): Promise<{ data: string; size: number; etag: string | null }> {
    const client = await this.clientFor(bucket)
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    const size = head.ContentLength ?? 0
    if (size > S3_EDIT_MAX_BYTES) throw new Error(t('The object is too large for the editor'))
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const chunks: Buffer[] = []
    for await (const chunk of out.Body as Readable) chunks.push(chunk as Buffer)
    return { data: Buffer.concat(chunks).toString('base64'), size, etag: out.ETag ?? null }
  }

  /** Editor trong app: ghi đè object, giữ thuộc tính (Content-Type, metadata…); kiểm tra ETag nếu có. */
  private async writeText(
    bucket: string,
    key: string,
    data: Buffer,
    expectEtag: string | undefined
  ): Promise<{ etag: string | null; size: number }> {
    if (data.length > S3_EDIT_MAX_BYTES)
      throw new Error(t('The object is too large for the editor'))
    const client = await this.clientFor(bucket)
    const head = await client
      .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      .catch((error: unknown) => {
        if (isNotFound(error)) return null
        throw error
      })
    if (expectEtag && head && head.ETag !== expectEtag) throw new Error(t(S3_OBJECT_CHANGED))
    if (expectEtag && !head) throw new Error(t(S3_OBJECT_CHANGED))
    const put = (condition: boolean) =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ...preservedAttributes(head),
          // If-Match: người khác ghi giữa HEAD và PUT → 412 thay vì đè mất thay đổi của họ.
          ...(condition && expectEtag ? { IfMatch: expectEtag } : {})
        })
      )
    let out
    try {
      out = await put(this.conditionalWrites)
    } catch (error) {
      if (isPreconditionFailed(error)) throw new Error(t(S3_OBJECT_CHANGED), { cause: error })
      if (!expectEtag || !this.conditionalWrites || !isConditionalWriteUnsupported(error))
        throw error
      this.conditionalWrites = false
      out = await put(false)
    }
    return { etag: out.ETag ?? null, size: data.length }
  }

  private async download(
    job: Job,
    bucket: string,
    key: string,
    localPath: string,
    versionId?: string
  ): Promise<{ etag: string | null; attributes: ObjectAttributes }> {
    await mkdir(dirname(localPath), { recursive: true })
    const out = await (
      await this.clientFor(bucket)
    ).send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }), {
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
        throw new Error(
          t('Size mismatch after download ({written}/{expected})', {
            written,
            expected: out.ContentLength
          })
        )
      await rename(part, localPath)
    } catch (error) {
      await rm(part, { force: true })
      throw error
    }
    return { etag: out.ETag ?? null, attributes: preservedAttributes(out) }
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
      this.touch(job.status.id)
    }
  }

  private pump(): void {
    if (this.disposed) return
    while (this.running < this.maxTransfers && this.queueHead < this.queue.length) {
      const id = this.queue[this.queueHead++] ?? ''
      const job = this.jobs.get(id)
      if (job?.status.state !== 'queued') continue
      if (job.abort.signal.aborted) {
        job.status.state = 'cancelled'
        job.settle?.(new Error(t('Cancelled')))
        this.touch(id)
        continue
      }
      this.start(job)
    }
    // Thu gọn hàng đợi khi phần đã chạy chiếm quá nửa (không giữ mảng id dài mãi).
    if (this.queueHead > 1024 && this.queueHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.queueHead)
      this.queueHead = 0
    }
  }

  private start(job: Job): void {
    this.running++
    job.status.state = 'running'
    this.touch(job.status.id)
    job.running = job
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
          job.status.bytesPerSecond = 0
          job.settle?.(new Error(job.status.error ?? t('Cancelled')))
        }
      )
      .finally(() => {
        this.running--
        // Lượt xong / lỗi báo ngay (giao diện làm mới danh sách), nhưng gộp với các lượt khác cùng lúc.
        this.touch(job.status.id)
        this.pump()
      })
  }

  /** Job đổi → báo renderer trong lần gửi tới (tối đa ~4 lần / giây). */
  private touch(id: string): void {
    this.dirty.add(id)
    this.notify()
  }

  private flush(): void {
    this.notifyTimer = null
    if (this.disposed || (this.dirty.size === 0 && this.removed.size === 0)) return
    const upsert: TransferStatus[] = []
    for (const id of this.dirty) {
      const job = this.jobs.get(id)
      if (job) upsert.push({ ...job.status })
    }
    const remove = [...this.removed]
    this.dirty.clear()
    this.removed.clear()
    this.onTransfers({ upsert, remove })
  }

  private notify(immediate = false): void {
    if (this.disposed) return
    if (immediate) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer)
      this.flush()
      return
    }
    this.notifyTimer ??= setTimeout(() => {
      this.flush()
    }, PROGRESS_MS)
  }

  dispose(): void {
    this.disposed = true
    this.edits?.dispose()
    for (const job of this.statsJobs.values()) job.abort.abort()
    this.statsJobs.clear()
    const pending: Promise<void>[] = []
    for (const { job, finished } of this.syncJobs.values()) {
      job.stop()
      pending.push(finished)
    }
    this.syncJobs.clear()
    for (const job of this.bulkJobs.values()) {
      job.stop()
      pending.push(job.finished)
    }
    this.bulkJobs.clear()
    for (const job of this.jobs.values()) {
      job.abort.abort()
      if (job.running) pending.push(job.running)
    }
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    // Chờ các lượt đang chạy dọn xong (AbortMultipartUpload…) rồi mới đóng kết nối — có giới hạn.
    const clients = [this.client, ...this.regionClients.values()]
    let timer: NodeJS.Timeout | undefined
    void Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => {
        timer = setTimeout(resolve, pending.length ? DISPOSE_WAIT_MS : 0)
      })
    ]).then(() => {
      clearTimeout(timer)
      for (const client of clients) client.destroy()
    })
  }
}
