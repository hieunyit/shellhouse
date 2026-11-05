import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client
} from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { S3BulkJob, S3Op, type S3JobProgress } from '../../shared/ops'
import { BulkJob, countObjects, type BulkEnv } from '../../session-host/bulk'

/**
 * S3 giả trong bộ nhớ (một bucket): đủ ListObjectsV2 (StartAfter / MaxKeys, cắt trang như S3),
 * DeleteObjects (key chứa "locked" thì lỗi), HeadObject, CopyObject. s3rver không cắt trang được
 * (token dùng DES) nên phân trang kiểm tra ở đây.
 */
function fakeS3(keys: string[]) {
  const objects = new Map(keys.map((k) => [k, 1]))
  const buckets = new Map<string, Map<string, number>>([['b', objects]])
  const bucketObjects = (bucket: string | undefined): Map<string, number> => {
    const name = bucket ?? 'b'
    let found = buckets.get(name)
    if (!found) {
      found = new Map()
      buckets.set(name, found)
    }
    return found
  }
  const calls = { list: 0, delete: 0, maxDeleteBatch: 0 }
  const send = (command: unknown): Promise<unknown> => {
    if (command instanceof ListObjectsV2Command) {
      calls.list++
      const { Prefix = '', StartAfter = '', MaxKeys = 1000 } = command.input
      const objects = bucketObjects(command.input.Bucket)
      const all = [...objects.keys()].filter((k) => k.startsWith(Prefix) && k > StartAfter).sort()
      const page = all.slice(0, MaxKeys)
      return Promise.resolve({
        Contents: page.map((Key) => ({ Key, Size: objects.get(Key) })),
        KeyCount: page.length,
        IsTruncated: all.length > page.length
      })
    }
    if (command instanceof DeleteObjectsCommand) {
      calls.delete++
      const objects = bucketObjects(command.input.Bucket)
      const batch = command.input.Delete?.Objects ?? []
      calls.maxDeleteBatch = Math.max(calls.maxDeleteBatch, batch.length)
      const Errors: { Key: string; Code: string; Message: string }[] = []
      for (const { Key = '' } of batch)
        if (Key.includes('locked')) Errors.push({ Key, Code: 'AccessDenied', Message: 'Denied' })
        else objects.delete(Key)
      return Promise.resolve({ Errors })
    }
    if (command instanceof HeadObjectCommand) {
      const size = bucketObjects(command.input.Bucket).get(command.input.Key ?? '')
      return size === undefined
        ? Promise.reject(Object.assign(new Error('NotFound'), { name: 'NotFound' }))
        : Promise.resolve({ ContentLength: size })
    }
    if (command instanceof CopyObjectCommand) {
      const from = decodeURIComponent((command.input.CopySource ?? '').replace(/^[^/]+\//, ''))
      const sourceBucket = (command.input.CopySource ?? '').split('/')[0]
      const source = bucketObjects(sourceBucket)
      if (!source.has(from)) return Promise.reject(new Error(`no ${from}`))
      bucketObjects(command.input.Bucket).set(command.input.Key ?? '', source.get(from) ?? 0)
      return Promise.resolve({})
    }
    return Promise.reject(new Error('unexpected command'))
  }
  const client = { send } as unknown as S3Client
  const env: BulkEnv = { clientFor: () => Promise.resolve(client), requests: 8, deleteParallel: 3 }
  return { objects, calls, env, buckets }
}

const range = (n: number, f: (i: number) => string): string[] =>
  Array.from({ length: n }, (_, i) => f(i))

async function finish(env: BulkEnv, spec: S3BulkJob): Promise<S3JobProgress> {
  const job = new BulkJob(env, spec)
  await job.finished
  return job.snapshot()
}

describe('S3: việc nền theo trang', () => {
  it('accepts explicit selections beyond 1000 and streams an entire bucket to another bucket', async () => {
    const keys = range(2501, (i) => `f${String(i).padStart(5, '0')}`)
    const spec = {
      kind: 'copy',
      bucket: 'b',
      keys,
      destBucket: 'd',
      destPrefix: '',
      move: true,
      overwrite: false
    } as const
    expect(S3BulkJob.safeParse(spec).success).toBe(true)
    expect(S3Op.safeParse({ ...spec, op: 'copy' }).success).toBe(true)
    const s3 = fakeS3(keys)
    const result = await finish(s3.env, { ...spec, keys: [''] })
    expect(result).toMatchObject({ phase: 'done', found: 2501, done: 2501, failed: 0 })
    expect(s3.objects.size).toBe(0)
    expect(s3.buckets.get('d')?.size).toBe(2501)
    expect(s3.buckets.get('d')?.has('f00000')).toBe(true)
    expect(s3.calls.maxDeleteBatch).toBeLessThanOrEqual(1000)
  })

  it('xoá thư mục 2 500 object: lô ≤ 1000, xoá trong lúc liệt kê, không sót object nào', async () => {
    const s3 = fakeS3([...range(2500, (i) => `logs/${String(i).padStart(5, '0')}.txt`), 'keep.txt'])
    const p = await finish(s3.env, { kind: 'delete', bucket: 'b', keys: ['logs/'] })
    expect(p).toMatchObject({ phase: 'done', found: 2500, done: 2500, failed: 0, scanning: false })
    expect([...s3.objects.keys()]).toEqual(['keep.txt'])
    expect(s3.calls.maxDeleteBatch).toBeLessThanOrEqual(1000)
    expect(s3.calls.delete).toBe(3)
  })

  it('lỗi từng object được đếm, việc vẫn chạy hết', async () => {
    const s3 = fakeS3([...range(1500, (i) => `d/f${i}`), ...range(5, (i) => `d/locked${i}`)])
    const p = await finish(s3.env, { kind: 'delete', bucket: 'b', keys: ['d/'] })
    expect(p).toMatchObject({ phase: 'done', done: 1500, failed: 5 })
    expect(p.errors.map((e) => e.key).sort()).toEqual(range(5, (i) => `d/locked${i}`))
    expect(s3.objects.size).toBe(5)
  })

  it('move thư mục 1 200 object: copy rồi xoá nguồn theo từng trang', async () => {
    const s3 = fakeS3(range(1200, (i) => `src/${String(i).padStart(4, '0')}`))
    const p = await finish(s3.env, {
      kind: 'copy',
      bucket: 'b',
      keys: ['src/'],
      destBucket: 'b',
      destPrefix: 'dst/',
      move: true,
      overwrite: false
    })
    expect(p).toMatchObject({ phase: 'done', found: 1200, done: 1200, failed: 0 })
    const keys = [...s3.objects.keys()]
    expect(keys.filter((k) => k.startsWith('src/'))).toEqual([])
    expect(keys.filter((k) => k.startsWith('dst/src/'))).toHaveLength(1200)
  })

  it('kiểm tra trước khi làm: copy vào chính nó, trùng tên, tên mới không hợp lệ', async () => {
    const s3 = fakeS3(['a/x', 'b/a/x'])
    const into = await finish(s3.env, {
      kind: 'copy',
      bucket: 'b',
      keys: ['a/'],
      destBucket: 'b',
      destPrefix: 'a/sub',
      move: false,
      overwrite: false
    })
    expect(into.error).toMatch(/into itself/)
    const dup = await finish(s3.env, {
      kind: 'copy',
      bucket: 'b',
      keys: ['a/'],
      destBucket: 'b',
      destPrefix: 'b',
      move: false,
      overwrite: false
    })
    expect(dup.error).toMatch(/already exists/)
    const bad = await finish(s3.env, {
      kind: 'rename',
      bucket: 'b',
      key: 'a/',
      name: 'x/y',
      overwrite: false
    })
    expect(bad.error).toMatch(/cannot contain/)
    expect([...s3.objects.keys()].sort()).toEqual(['a/x', 'b/a/x'])
  })

  it('dừng giữa chừng → stopped, không chạy tiếp', async () => {
    const s3 = fakeS3(range(3000, (i) => `z/${String(i).padStart(4, '0')}`))
    const job = new BulkJob(s3.env, { kind: 'delete', bucket: 'b', keys: ['z/'] })
    job.stop()
    await job.finished
    const p = job.snapshot()
    expect(p.phase).toBe('stopped')
    expect(p.error).toBeNull()
    expect(s3.objects.size).toBeGreaterThan(0)
  })

  it('đếm object (dừng ở giới hạn)', async () => {
    const s3 = fakeS3([...range(2300, (i) => `c/${i}`), 'one'])
    expect(await countObjects(s3.env, 'b', ['c/'], 1000)).toEqual({ count: 1000, more: true })
    expect(await countObjects(s3.env, 'b', ['c/', 'one'], 10_000)).toEqual({
      count: 2301,
      more: false
    })
  })
})
