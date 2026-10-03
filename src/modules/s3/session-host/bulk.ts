import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client
} from '@aws-sdk/client-s3'
import { t, tn } from '@shared/i18n'
import { formatNumber } from '@shared/i18n/format'
import { objectNameProblem, parentPrefix, type S3BulkJob, type S3JobProgress } from '../shared/ops'
import { mapLimit } from '../../../node-shared/pool'
import { errorText, isNotFound, serverCopy } from './client'

const MAX_ERRORS = 20
/** DeleteObjects nhận tối đa 1000 key mỗi lần; ListObjectsV2 trả tối đa 1000 key mỗi trang. */
const BATCH = 1000

export interface BulkEnv {
  /** Client đúng region của bucket. */
  clientFor(bucket: string): Promise<S3Client>
  /** Request cùng lúc (copy object). */
  requests: number
  /** Lô xoá cùng lúc. */
  deleteParallel: number
}

/** Tên cuối của key: "a/b/c.txt" → "c.txt", "a/b/" → "b". */
export function lastName(key: string): string {
  return key.replace(/\/$/, '').split('/').at(-1) ?? key
}

/** Lỗi DeleteObjects → một câu: số object lỗi + vài key đầu. */
export function deleteErrorSummary(
  errors: readonly { key: string; message: string }[],
  failed: number
): string {
  const shown = errors
    .slice(0, 3)
    .map((e) => `${e.key} (${e.message})`)
    .join(', ')
  const more = failed > 3 ? t(', and {n} more', { n: formatNumber(failed - 3) }) : ''
  return tn(
    failed,
    'Could not delete {n} object: {detail}',
    'Could not delete {n} objects: {detail}',
    {
      detail: `${shown}${more}`
    }
  )
}

/**
 * Liệt kê phẳng mọi key dưới `prefix` theo từng trang 1000, trang sau tải trước trong lúc trang này
 * đang được xử lý. Dùng StartAfter (key cuối của trang trước) thay vì ContinuationToken — an toàn khi
 * `onPage` xoá chính các object vừa liệt kê (xoá / move) trên mọi dịch vụ tương thích S3.
 */
export async function forEachPage(
  client: S3Client,
  bucket: string,
  prefix: string,
  onPage: (objects: { key: string; size: number }[]) => Promise<void>,
  signal: AbortSignal
): Promise<void> {
  const fetchPage = async (
    startAfter: string | undefined
  ): Promise<{ objects: { key: string; size: number }[]; more: boolean }> => {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: BATCH,
        ...(startAfter ? { StartAfter: startAfter } : {})
      }),
      { abortSignal: signal }
    )
    const objects = (out.Contents ?? [])
      .filter((o): o is typeof o & { Key: string } => !!o.Key)
      .map((o) => ({ key: o.Key, size: o.Size ?? 0 }))
    return { objects, more: !!out.IsTruncated && objects.length > 0 }
  }
  let page = await fetchPage(undefined)
  for (;;) {
    if (signal.aborted) return
    const last = page.objects.at(-1)?.key
    const next = page.more ? fetchPage(last) : null
    // Trang sau đang tải; lỗi của nó (nếu có) được bắt khi await bên dưới.
    next?.catch(() => undefined)
    if (page.objects.length) await onPage(page.objects)
    if (!next) return
    page = await next
  }
}

/** Đếm object dưới các key (thư mục đệ quy), dừng ở `limit`. */
export async function countObjects(
  env: BulkEnv,
  bucket: string,
  keys: readonly string[],
  limit: number
): Promise<{ count: number; more: boolean }> {
  const client = await env.clientFor(bucket)
  const abort = new AbortController()
  let count = keys.filter((k) => !k.endsWith('/')).length
  for (const key of keys.filter((k) => k.endsWith('/'))) {
    if (count >= limit) break
    await forEachPage(
      client,
      bucket,
      key,
      (objects) => {
        count += objects.length
        if (count >= limit) abort.abort()
        return Promise.resolve()
      },
      abort.signal
    )
  }
  return { count: Math.min(count, limit), more: count >= limit && abort.signal.aborted }
}

/**
 * Việc nền xoá / copy / move / đổi tên, không giới hạn số object: thư mục được liệt kê theo trang
 * và xử lý ngay trong lúc liệt kê (bộ nhớ không tăng theo kích thước thư mục). Lỗi từng object ghi
 * lại rồi chạy tiếp; lỗi chặn (trùng tên, copy vào chính nó…) kiểm tra hết trước khi bắt đầu.
 */
export class BulkJob {
  private readonly abort = new AbortController()
  private readonly progress: S3JobProgress = {
    phase: 'running',
    found: 0,
    done: 0,
    failed: 0,
    scanning: true,
    errors: [],
    error: null
  }
  /** Lần cuối renderer hỏi tiến độ (dọn việc bị bỏ quên). */
  touched = Date.now()
  readonly finished: Promise<void>

  constructor(
    private readonly env: BulkEnv,
    private readonly job: S3BulkJob
  ) {
    this.finished = this.run()
  }

  get done(): boolean {
    return this.progress.phase !== 'running'
  }

  snapshot(): S3JobProgress {
    this.touched = Date.now()
    return { ...this.progress, errors: [...this.progress.errors] }
  }

  stop(): void {
    this.abort.abort()
  }

  private stopped(): boolean {
    return this.abort.signal.aborted
  }

  private async run(): Promise<void> {
    try {
      const job = this.job
      if (job.kind === 'delete') await this.remove(job.bucket, job.keys)
      else if (job.kind === 'copy') {
        const base =
          job.destPrefix && !job.destPrefix.endsWith('/') ? `${job.destPrefix}/` : job.destPrefix
        await this.copyAll(
          job.bucket,
          job.keys.map((key) => ({
            key,
            destKey: base + lastName(key) + (key.endsWith('/') ? '/' : '')
          })),
          job.destBucket,
          job.move,
          job.overwrite
        )
      } else {
        const problem = objectNameProblem(job.name)
        if (problem) throw new Error(problem)
        const destKey = parentPrefix(job.key) + job.name + (job.key.endsWith('/') ? '/' : '')
        if (destKey !== job.key)
          await this.copyAll(
            job.bucket,
            [{ key: job.key, destKey }],
            job.bucket,
            true,
            job.overwrite
          )
      }
      this.progress.phase = this.stopped() ? 'stopped' : 'done'
    } catch (error) {
      this.progress.phase = this.stopped() ? 'stopped' : 'error'
      if (!this.stopped()) this.progress.error = errorText(error)
    } finally {
      this.progress.scanning = false
    }
  }

  private fail(key: string, error: unknown): void {
    this.progress.failed++
    if (this.progress.errors.length < MAX_ERRORS)
      this.progress.errors.push({ key, message: errorText(error) })
  }

  // ---------- Xoá ----------

  private async remove(bucket: string, keys: readonly string[]): Promise<void> {
    const client = await this.env.clientFor(bucket)
    const signal = this.abort.signal
    const inflight = new Set<Promise<void>>()
    /** Gửi một lô xoá; đủ `deleteParallel` lô đang chạy thì chờ bớt (giữ nhịp với việc liệt kê). */
    const submit = async (batch: string[]): Promise<void> => {
      while (inflight.size >= this.env.deleteParallel) await Promise.race(inflight)
      const p: Promise<void> = this.deleteBatch(client, bucket, batch).then(() => {
        inflight.delete(p)
      })
      inflight.add(p)
    }
    try {
      const exact = [...new Set(keys.filter((k) => !k.endsWith('/')))]
      this.progress.found += exact.length
      for (let i = 0; i < exact.length; i += BATCH) await submit(exact.slice(i, i + BATCH))
      for (const prefix of keys.filter((k) => k.endsWith('/'))) {
        if (signal.aborted) break
        await forEachPage(
          client,
          bucket,
          prefix,
          async (objects) => {
            this.progress.found += objects.length
            await submit(objects.map((o) => o.key))
          },
          signal
        )
      }
      this.progress.scanning = false
    } finally {
      // Lỗi liệt kê vẫn phải chờ các lô xoá đang bay xong rồi mới chốt phase (done/failed đúng).
      await Promise.allSettled(inflight)
    }
  }

  /** Xoá đúng các key này (≤ 1000); trả về key đã xoá được. */
  private async deleteBatch(client: S3Client, bucket: string, batch: string[]): Promise<string[]> {
    if (this.stopped()) return []
    try {
      const out = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true }
        }),
        { abortSignal: this.abort.signal }
      )
      const failed = new Set<string>()
      for (const e of out.Errors ?? []) {
        failed.add(e.Key ?? '')
        this.fail(e.Key ?? '', new Error(e.Message ?? e.Code ?? t('Failed')))
      }
      this.progress.done += batch.length - failed.size
      return batch.filter((k) => !failed.has(k))
    } catch (error) {
      if (!this.stopped()) for (const key of batch) this.fail(key, error)
      return []
    }
  }

  // ---------- Copy / move ----------

  private async exists(client: S3Client, bucket: string, key: string): Promise<boolean> {
    const signal = this.abort.signal
    if (key.endsWith('/')) {
      const out = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }),
        { abortSignal: signal }
      )
      return (out.KeyCount ?? out.Contents?.length ?? 0) > 0
    }
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal
      })
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  private async copyAll(
    bucket: string,
    items: readonly { key: string; destKey: string }[],
    destBucket: string,
    move: boolean,
    overwrite: boolean
  ): Promise<void> {
    const source = await this.env.clientFor(bucket)
    // CopyObject gửi tới region của bucket đích.
    const dest = await this.env.clientFor(destBucket)
    const signal = this.abort.signal
    // Kiểm tra hết trước (trùng tên, copy vào chính nó…) rồi mới bắt đầu copy.
    const sizes = new Map<string, number>()
    for (const { key, destKey } of items) {
      const name = lastName(key)
      if (bucket === destBucket && key === destKey)
        throw new Error(t('“{name}” is already in this folder', { name }))
      if (key.endsWith('/') && bucket === destBucket && destKey.startsWith(key))
        throw new Error(t('A folder cannot be copied into itself (“{name}”)', { name }))
      if (!overwrite && (await this.exists(dest, destBucket, destKey)))
        throw new Error(
          t('“{name}” already exists at the destination', { name: lastName(destKey) })
        )
      if (!key.endsWith('/')) {
        const head = await source.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal: signal
        })
        sizes.set(key, head.ContentLength ?? 0)
      }
    }
    const copyPage = async (pairs: { from: string; to: string; size: number }[]): Promise<void> => {
      const copied: string[] = []
      await mapLimit(pairs, this.env.requests, async (pair) => {
        if (this.stopped()) return
        try {
          await serverCopy(
            dest,
            { bucket, key: pair.from },
            { bucket: destBucket, key: pair.to },
            pair.size,
            signal
          )
          copied.push(pair.from)
          if (!move) this.progress.done++
        } catch (error) {
          if (!this.stopped()) this.fail(pair.from, error)
        }
      })
      // Move: chỉ xoá nguồn của object đã copy thành công.
      // deleteBatch cộng `done` cho object xoá được (= move xong).
      if (move && copied.length && !this.stopped()) await this.deleteBatch(source, bucket, copied)
    }
    for (const { key, destKey } of items) {
      if (this.stopped()) return
      if (!key.endsWith('/')) {
        this.progress.found++
        await copyPage([{ from: key, to: destKey, size: sizes.get(key) ?? 0 }])
        continue
      }
      await forEachPage(
        source,
        bucket,
        key,
        async (objects) => {
          this.progress.found += objects.length
          await copyPage(
            objects.map((o) => ({
              from: o.key,
              to: destKey + o.key.slice(key.length),
              size: o.size
            }))
          )
        },
        signal
      )
    }
  }
}
