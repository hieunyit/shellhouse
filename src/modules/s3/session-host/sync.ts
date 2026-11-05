import type { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  type S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { t } from '@shared/i18n'
import { formatNumber } from '@shared/i18n/format'
import type { S3Op, S3SyncProgress } from '../shared/ops'
import {
  normalizePrefix,
  planSync,
  syncOverlap,
  type SyncItem,
  type SyncObject
} from '../shared/sync'
import { SyncIndex, SYNC_PAGE_SIZE } from './sync-index'
export { MAX_SYNC_OBJECTS } from './sync-index'
import { mapLimit } from '../../../node-shared/pool'
import { createBucketInput, errorText, isNotFound, serverCopy } from './client'

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
      /** Region của tài khoản đích (tạo bucket đích ngoài us-east-1). */
      destRegion: string
      /** Cùng tài khoản: CopyObject trên server. */
      serverSide: boolean
      concurrency: number
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
    let index: SyncIndex | undefined
    try {
      if (
        syncOverlap(
          this.env.serverSide,
          { bucket: this.op.bucket, prefix: this.sourcePrefix },
          { bucket: this.op.dest.bucket, prefix: this.destPrefix }
        )
      )
        throw new Error(t('The source and destination overlap — pick a different folder or bucket'))
      const destExists = await this.ensureDestBucket()
      const disk = new SyncIndex()
      index = disk
      const scanAbort = new AbortController()
      const scanSignal = AbortSignal.any([signal, scanAbort.signal])
      const scan = (
        client: S3Client,
        bucket: string,
        prefix: string,
        side: 'source' | 'dest'
      ): Promise<void> =>
        this.scan(disk, client, bucket, prefix, side, scanSignal).catch((error: unknown) => {
          scanAbort.abort(error)
          throw error
        })
      // Wait for both scans to settle before closing their shared index on failure.
      const scans = await Promise.allSettled([
        scan(this.env.source, this.op.bucket, this.sourcePrefix, 'source'),
        destExists
          ? scan(this.env.dest, this.op.dest.bucket, this.destPrefix, 'dest')
          : Promise.resolve()
      ])
      for (const scan of scans) if (scan.status === 'rejected') throw scan.reason
      signal.throwIfAborted()
      await this.plan(index)
      const p = this.progress
      // Kế hoạch lúc chạy thật xoá nhiều hơn bản đã xem trước (nguồn vừa bị xoá bớt / đổi chỗ…) →
      // dừng hẳn, không chép cũng không xoá gì.
      if (!this.op.dryRun && this.op.maxDelete !== undefined && p.plan.delete > this.op.maxDelete)
        throw new Error(
          t(
            'The sync would now delete {n} objects, more than the {max} in the preview — preview again',
            { n: formatNumber(p.plan.delete), max: formatNumber(this.op.maxDelete) }
          )
        )
      p.sample = index
        .plan(null)
        .slice(0, SAMPLE)
        .map((it) => ({
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
      for await (const page of this.pages(index)) {
        await mapLimit(
          page.filter((it) => it.action !== 'delete'),
          p.concurrency,
          async (it) => {
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
          }
        )
      }
      if (p.plan.delete && !signal.aborted) {
        p.phase = 'deleting'
        for await (const page of this.pages(index))
          await this.deleteAll(page.filter((it) => it.action === 'delete').map((it) => it.rel))
      }
      p.phase = signal.aborted ? 'stopped' : 'done'
    } catch (error) {
      this.progress.phase = signal.aborted ? 'stopped' : 'error'
      if (!signal.aborted) this.progress.error = errorText(error)
    } finally {
      try {
        index?.close()
      } catch (error) {
        this.progress.phase = 'error'
        this.progress.error = errorText(error)
      } finally {
        this.finished = true
      }
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
        throw new Error(
          t('The destination bucket “{name}” does not exist', { name: this.op.dest.bucket }),
          {
            cause: error
          }
        )
      if (this.op.dryRun) return false
      await this.env.dest.send(
        new CreateBucketCommand(createBucketInput(this.op.dest.bucket, this.env.destRegion))
      )
      return true
    }
  }

  private async scan(
    index: SyncIndex,
    client: S3Client,
    bucket: string,
    prefix: string,
    side: 'source' | 'dest',
    signal: AbortSignal
  ): Promise<void> {
    // Flat listing bounds memory even when there are millions of distinct folders.
    let token: string | undefined
    for (;;) {
      signal.throwIfAborted()
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: SYNC_PAGE_SIZE,
          ContinuationToken: token
        }),
        { abortSignal: signal }
      )
      signal.throwIfAborted()
      index.add(side, prefix, page.Contents ?? [])
      this.progress.scanned[side] = index.counts[side]
      if (!page.IsTruncated) return
      if (!page.NextContinuationToken || page.NextContinuationToken === token)
        throw new Error(t('The object listing did not advance — no sync changes were made'))
      token = page.NextContinuationToken
    }
  }

  private async plan(index: SyncIndex): Promise<void> {
    for (const side of ['source', ...(this.op.mirror ? (['dest'] as const) : [])] as const) {
      let after: string | null = null
      for (;;) {
        this.abort.signal.throwIfAborted()
        const rows = index.objects(side, after)
        const last = rows.at(-1)
        if (!last) break
        let items: SyncItem[]
        if (side === 'source') {
          const source = new Map<string, SyncObject>(rows.map((r) => [r.rel, r]))
          const dest = new Map<string, SyncObject>(
            rows
              .filter((r) => r.present !== null)
              .map((r) => [r.rel, { size: r.destSize, etag: r.destEtag }])
          )
          const result = planSync(source, dest, { mirror: false, compare: this.op.compare })
          items = result.items
          this.progress.plan.same += result.same
        } else
          items = rows
            .filter((r) => r.present === null)
            .map((r) => ({ rel: r.rel, size: r.size, action: 'delete' as const }))
        index.addPlan(items)
        for (const item of items) {
          this.progress.plan[item.action]++
          if (item.action !== 'delete') this.progress.plan.bytes += item.size
        }
        after = last.rel
        await setImmediate()
      }
    }
  }

  private async *pages(index: SyncIndex): AsyncGenerator<SyncItem[]> {
    let after: string | null = null
    while (!this.stopped()) {
      const page = index.plan(after)
      const last = page.at(-1)
      if (!last) return
      yield page
      after = last.rel
      await setImmediate()
    }
  }

  private async copyOne(rel: string, size: number, entry: { done: number }): Promise<void> {
    const signal = this.abort.signal
    const from = { bucket: this.op.bucket, key: this.sourcePrefix + rel }
    const to = { bucket: this.op.dest.bucket, key: this.destPrefix + rel }
    if (this.env.serverSide) {
      // CopyObject gửi tới region của bucket đích (cùng tài khoản: client của bucket đích).
      await serverCopy(this.env.dest, from, to, size, signal)
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
    // Mỗi object một AbortController con: lib-storage gán đè `signal.onabort`, dùng chung một
    // controller thì chỉ lượt tạo sau cùng dừng ngay khi bấm Stop.
    const child = new AbortController()
    const stop = (): void => {
      child.abort()
    }
    if (signal.aborted) child.abort()
    else signal.addEventListener('abort', stop, { once: true })
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
      abortController: child
    })
    try {
      await upload.done()
    } catch (error) {
      // Dừng: done() trả lỗi ngay, AbortMultipartUpload của lib-storage chạy sau (client đích có thể
      // đã đóng) — tự gửi để không để lại phần rác tính tiền ở bucket đích.
      const uploadId = (upload as unknown as { uploadId?: string }).uploadId
      if (child.signal.aborted && uploadId)
        await this.env.dest
          .send(
            new AbortMultipartUploadCommand({ Bucket: to.bucket, Key: to.key, UploadId: uploadId })
          )
          .catch(() => undefined)
      throw error
    } finally {
      signal.removeEventListener('abort', stop)
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
          this.fail(
            (e.Key ?? '').slice(this.destPrefix.length),
            new Error(e.Message ?? t('Failed'))
          )
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
