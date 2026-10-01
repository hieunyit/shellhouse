import type { Readable } from 'node:stream'
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  type S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { S3Op, S3SyncProgress } from '../shared/ops'
import { normalizePrefix, planSync, syncOverlap, type SyncObject } from '../shared/sync'
import { mapLimit } from '../../../node-shared/pool'
import { errorText, isNotFound, scanObjects, serverCopy } from './client'

/** Mỗi bên tối đa chừng này object (map key → size/etag ~100 byte/object trong bộ nhớ). */
export const MAX_SYNC_OBJECTS = 1_000_000
const SAMPLE = 300
const MAX_ERRORS = 50
/** Truyền qua máy: mỗi object tối đa 2 phần × 8 MiB trong bộ nhớ cùng lúc. */
const PART_SIZE = 8 * 1024 * 1024
const PART_QUEUE = 2

type SyncOp = Extract<S3Op, { op: 'syncStart' }>

/**
 * Một lượt đồng bộ `bucket/prefix` → đích, chạy nền trong Session Host:
 * 1. quét hai bên song song (như thống kê), 2. so sánh (planSync), 3. copy mới / thay đổi —
 * cùng tài khoản thì copy trên server, khác tài khoản thì tải từ nguồn và đẩy lên đích theo luồng
 * (không ghi đĩa), 4. `mirror` thì xoá ở đích object không còn ở nguồn (lô 1000).
 * Lỗi từng object được ghi lại, lượt chạy tiếp; dừng bất cứ lúc nào bằng `stop()`.
 */
export class SyncJob {
  private readonly abort = new AbortController()
  private readonly progress: S3SyncProgress
  private readonly sourcePrefix: string
  private readonly destPrefix: string
  /** Đo tốc độ: mẫu mỗi ≥ 500 ms, làm mượt bằng trung bình trượt (không nhảy giật). */
  private sampleAt = Date.now()
  private sampleBytes = 0
  private lastByteAt = 0
  private readonly active = new Map<string, { size: number; done: number }>()
  finished = false

  constructor(
    private readonly env: {
      source: S3Client
      dest: S3Client
      /** Cùng tài khoản: CopyObject trên server. */
      serverSide: boolean
      concurrency: number
      scanConcurrency: number
    },
    private readonly op: SyncOp
  ) {
    this.sourcePrefix = normalizePrefix(op.prefix)
    this.destPrefix = normalizePrefix(op.dest.prefix)
    this.progress = {
      phase: 'scanning',
      dryRun: op.dryRun,
      serverSide: env.serverSide,
      scanned: { source: 0, dest: 0 },
      plan: { new: 0, update: 0, delete: 0, same: 0, bytes: 0 },
      done: { copied: 0, deleted: 0, bytes: 0, failed: 0 },
      bytesPerSecond: 0,
      concurrency: op.concurrency ?? env.concurrency,
      active: [],
      sample: [],
      errors: [],
      error: null
    }
  }

  snapshot(): S3SyncProgress {
    const p = this.progress
    // Tốc độ về 0 nếu vài giây không có byte nào (đang copy object lớn trên server…).
    const idle = Date.now() - this.lastByteAt > 3000
    return {
      ...p,
      bytesPerSecond: idle ? 0 : p.bytesPerSecond,
      active: [...this.active].slice(0, 8).map(([key, a]) => ({ key, size: a.size, done: a.done })),
      scanned: { ...p.scanned },
      plan: { ...p.plan },
      done: { ...p.done },
      sample: [...p.sample],
      errors: [...p.errors]
    }
  }

  stop(): void {
    this.abort.abort()
  }

  /** Đọc lại cờ sau await (TS tưởng giá trị không đổi kể từ lần kiểm tra trước). */
  private stopped(): boolean {
    return this.abort.signal.aborted
  }

  async run(): Promise<void> {
    const signal = this.abort.signal
    try {
      if (
        syncOverlap(
          this.env.serverSide,
          { bucket: this.op.bucket, prefix: this.sourcePrefix },
          { bucket: this.op.dest.bucket, prefix: this.destPrefix }
        )
      )
        throw new Error('The source and destination overlap — pick a different folder or bucket')
      const destExists = await this.ensureDestBucket()
      const [source, dest] = await Promise.all([
        this.scan(this.env.source, this.op.bucket, this.sourcePrefix, 'source'),
        destExists
          ? this.scan(this.env.dest, this.op.dest.bucket, this.destPrefix, 'dest')
          : new Map<string, SyncObject>()
      ])
      const { items, same } = planSync(source, dest, {
        mirror: this.op.mirror,
        compare: this.op.compare
      })
      const p = this.progress
      for (const it of items) {
        p.plan[it.action]++
        if (it.action !== 'delete') p.plan.bytes += it.size
      }
      p.plan.same = same
      p.sample = items.slice(0, SAMPLE).map((it) => ({
        key: it.rel,
        action: it.action,
        size: it.size
      }))
      if (this.op.dryRun) {
        p.phase = 'planned'
        return
      }
      p.phase = 'copying'
      this.sampleAt = Date.now()
      const copies = items.filter((it) => it.action !== 'delete')
      await mapLimit(copies, p.concurrency, async (it) => {
        if (signal.aborted) return
        const entry = { size: it.size, done: 0 }
        this.active.set(it.rel, entry)
        try {
          await this.copyOne(it.rel, it.size, entry)
          p.done.copied++
          if (this.env.serverSide) this.count(it.size)
        } catch (error) {
          if (!this.stopped()) this.fail(it.rel, error)
        } finally {
          this.active.delete(it.rel)
        }
      })
      const deletes = items.filter((it) => it.action === 'delete').map((it) => it.rel)
      if (deletes.length && !signal.aborted) {
        p.phase = 'deleting'
        await this.deleteAll(deletes)
      }
      p.phase = signal.aborted ? 'stopped' : 'done'
    } catch (error) {
      this.progress.phase = signal.aborted ? 'stopped' : 'error'
      if (!signal.aborted) this.progress.error = errorText(error)
    } finally {
      this.finished = true
    }
  }

  /** Bucket đích có chưa; chưa có + `createBucket` thì tạo (trừ khi chỉ xem trước). */
  private async ensureDestBucket(): Promise<boolean> {
    try {
      await this.env.dest.send(new HeadBucketCommand({ Bucket: this.op.dest.bucket }), {
        abortSignal: this.abort.signal
      })
      return true
    } catch (error) {
      if (!isNotFound(error)) throw error
      if (!this.op.createBucket)
        throw new Error(`The destination bucket “${this.op.dest.bucket}” does not exist`, {
          cause: error
        })
      if (this.op.dryRun) return false
      await this.env.dest.send(new CreateBucketCommand({ Bucket: this.op.dest.bucket }))
      return true
    }
  }

  private async scan(
    client: S3Client,
    bucket: string,
    prefix: string,
    side: 'source' | 'dest'
  ): Promise<Map<string, SyncObject>> {
    const out = new Map<string, SyncObject>()
    const abort = new AbortController()
    const stop = (): void => {
      abort.abort()
    }
    this.abort.signal.addEventListener('abort', stop)
    try {
      await scanObjects(
        client,
        bucket,
        prefix,
        this.env.scanConcurrency,
        (objects) => {
          for (const o of objects) {
            if (!o.Key) continue
            out.set(o.Key.slice(prefix.length), { size: o.Size ?? 0, etag: o.ETag ?? null })
          }
          this.progress.scanned[side] = out.size
          if (out.size > MAX_SYNC_OBJECTS)
            abort.abort(
              new Error(
                `More than ${MAX_SYNC_OBJECTS.toLocaleString('en')} objects on one side — sync a smaller folder`
              )
            )
        },
        abort.signal
      )
    } finally {
      this.abort.signal.removeEventListener('abort', stop)
    }
    if (abort.signal.aborted && !this.abort.signal.aborted) throw abort.signal.reason
    return out
  }

  private async copyOne(rel: string, size: number, entry: { done: number }): Promise<void> {
    const signal = this.abort.signal
    const from = { bucket: this.op.bucket, key: this.sourcePrefix + rel }
    const to = { bucket: this.op.dest.bucket, key: this.destPrefix + rel }
    if (this.env.serverSide) {
      await serverCopy(this.env.source, from, to, size, signal)
      return
    }
    const got = await this.env.source.send(
      new GetObjectCommand({ Bucket: from.bucket, Key: from.key }),
      {
        abortSignal: signal
      }
    )
    const body = got.Body as Readable
    body.on('data', (chunk: Buffer) => {
      entry.done += chunk.length
      this.count(chunk.length)
    })
    const upload = new Upload({
      client: this.env.dest,
      params: {
        Bucket: to.bucket,
        Key: to.key,
        Body: body,
        ...(got.ContentType ? { ContentType: got.ContentType } : {}),
        ...(got.ContentEncoding ? { ContentEncoding: got.ContentEncoding } : {}),
        ...(got.ContentDisposition ? { ContentDisposition: got.ContentDisposition } : {}),
        ...(got.CacheControl ? { CacheControl: got.CacheControl } : {}),
        ...(got.Metadata && Object.keys(got.Metadata).length ? { Metadata: got.Metadata } : {})
      },
      queueSize: PART_QUEUE,
      partSize: Math.max(PART_SIZE, Math.ceil(size / 9000)),
      abortController: this.abort
    })
    try {
      await upload.done()
    } finally {
      body.destroy()
    }
  }

  private async deleteAll(rels: readonly string[]): Promise<void> {
    const batches: string[][] = []
    for (let i = 0; i < rels.length; i += 1000) batches.push(rels.slice(i, i + 1000))
    await mapLimit(batches, 4, async (batch) => {
      if (this.abort.signal.aborted) return
      try {
        const out = await this.env.dest.send(
          new DeleteObjectsCommand({
            Bucket: this.op.dest.bucket,
            Delete: { Objects: batch.map((rel) => ({ Key: this.destPrefix + rel })), Quiet: true }
          }),
          { abortSignal: this.abort.signal }
        )
        const failed = new Set((out.Errors ?? []).map((e) => e.Key ?? ''))
        for (const e of out.Errors ?? [])
          this.fail((e.Key ?? '').slice(this.destPrefix.length), new Error(e.Message ?? 'Failed'))
        this.progress.done.deleted += batch.length - failed.size
      } catch (error) {
        if (!this.stopped()) for (const rel of batch) this.fail(rel, error)
      }
    })
  }

  private count(bytes: number): void {
    const p = this.progress
    p.done.bytes += bytes
    const now = Date.now()
    this.lastByteAt = now
    const elapsed = now - this.sampleAt
    if (elapsed >= 500) {
      const instant = ((p.done.bytes - this.sampleBytes) * 1000) / elapsed
      // Mẫu đầu lấy luôn; sau đó 30% mẫu mới + 70% giá trị cũ.
      p.bytesPerSecond = Math.round(
        p.bytesPerSecond === 0 ? instant : p.bytesPerSecond * 0.7 + instant * 0.3
      )
      this.sampleAt = now
      this.sampleBytes = p.done.bytes
    }
  }

  private fail(key: string, error: unknown): void {
    this.progress.done.failed++
    if (this.progress.errors.length < MAX_ERRORS)
      this.progress.errors.push({ key, message: errorText(error) })
  }
}
