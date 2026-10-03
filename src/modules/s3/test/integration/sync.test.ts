import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it } from 'vitest'
import type { S3Bucket, S3BucketInfo, S3SyncProgress } from '../../shared/ops'
import { createS3Client, type S3Connection } from '../../session-host/client'
import { S3Service } from '../../session-host/service'
import { tempDir } from '../../../../../test/unit/helpers'
import { startS3TestServer, type S3TestServer } from '../s3-test-server'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})

function conn(server: S3TestServer): S3Connection {
  return {
    endpoint: server.endpoint,
    region: 'us-east-1',
    accessKeyId: server.accessKeyId,
    secretAccessKey: server.secretAccessKey,
    forcePathStyle: true
  }
}

async function server(buckets: string[]): Promise<{ server: S3TestServer; client: S3Client }> {
  const s = await startS3TestServer(buckets)
  const client = createS3Client(conn(s), 8)
  cleanup.push(() => s.close())
  cleanup.push(() => {
    client.destroy()
  })
  return { server: s, client }
}

function service(main: S3TestServer, others: Record<string, S3TestServer> = {}): S3Service {
  const s = new S3Service(
    conn(main),
    () => undefined,
    { requests: 8, transfers: 4 },
    (id) => {
      const other = others[id]
      return other ? Promise.resolve(conn(other)) : Promise.reject(new Error('No such account'))
    }
  )
  cleanup.push(() => {
    s.dispose()
  })
  return s
}

const put = (c: S3Client, bucket: string, key: string, body: string, type?: string) =>
  c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ...(type ? { ContentType: type } : {})
    })
  )
const get = async (c: S3Client, bucket: string, key: string) => {
  const out = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return { text: await out.Body?.transformToString(), type: out.ContentType }
}

async function sync(
  s: S3Service,
  op: Omit<Parameters<S3Service['run']>[0] & { op: 'syncStart' }, 'op'>
): Promise<S3SyncProgress> {
  const id = (await s.run({ op: 'syncStart', ...op })) as string
  for (;;) {
    const p = (await s.run({ op: 'syncPoll', id })) as S3SyncProgress
    if (!['scanning', 'copying', 'deleting'].includes(p.phase)) return p
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('S3: đồng bộ', () => {
  it(
    'cùng tài khoản: xem trước → copy trên server; lần hai không còn gì; mirror xoá thừa, cập nhật thay đổi',
    { timeout: 60_000 },
    async () => {
      const { server: a, client } = await server(['src', 'dst'])
      for (let i = 0; i < 30; i++) await put(client, 'src', `data/f${i}.txt`, `file ${i}`)
      await put(client, 'src', 'data/sub/deep.txt', 'deep')
      const s = service(a)
      const base = {
        bucket: 'src',
        prefix: 'data',
        dest: { bucket: 'dst', prefix: 'backup/' },
        mirror: false,
        compare: 'etag' as const,
        createBucket: false
      }

      const preview = await sync(s, { ...base, dryRun: true })
      expect(preview.phase).toBe('planned')
      expect(preview.serverSide).toBe(true)
      expect(preview.plan).toMatchObject({ new: 31, update: 0, delete: 0, same: 0 })
      expect(preview.sample[0]).toMatchObject({ key: 'f0.txt', action: 'new' })
      // Xem trước không ghi gì.
      expect(
        (await s.run({ op: 'list', bucket: 'dst', prefix: '' })) as { entries: [] }
      ).toMatchObject({
        entries: []
      })

      const first = await sync(s, { ...base, dryRun: false })
      expect(first.phase).toBe('done')
      expect(first.done).toMatchObject({ copied: 31, failed: 0 })
      expect((await get(client, 'dst', 'backup/sub/deep.txt')).text).toBe('deep')

      const again = await sync(s, { ...base, dryRun: true })
      expect(again.plan).toMatchObject({ new: 0, update: 0, same: 31 })

      // Đổi nội dung (cùng dung lượng → nhận ra nhờ ETag), thêm file thừa ở đích.
      await put(client, 'src', 'data/f1.txt', 'FILE 1')
      await put(client, 'dst', 'backup/extra.txt', 'x')
      const bySize = await sync(s, { ...base, compare: 'size', dryRun: true })
      expect(bySize.plan.update).toBe(0)
      // Xem trước thấy xoá 1; lúc chạy thật đích có thêm object thừa → nhiều hơn số đã xem → dừng,
      // không chép / xoá gì.
      await put(client, 'dst', 'backup/extra2.txt', 'y')
      const guarded = await sync(s, { ...base, mirror: true, dryRun: false, maxDelete: 1 })
      expect(guarded.phase).toBe('error')
      expect(guarded.error).toMatch(/preview again/)
      expect(guarded.done).toMatchObject({ copied: 0, deleted: 0 })
      expect((await get(client, 'dst', 'backup/extra2.txt')).text).toBe('y')
      await s.run({ op: 'delete', bucket: 'dst', keys: ['backup/extra2.txt'] })
      const mirror = await sync(s, { ...base, mirror: true, dryRun: false, maxDelete: 1 })
      expect(mirror.plan).toMatchObject({ new: 0, update: 1, delete: 1 })
      expect(mirror.done).toMatchObject({ copied: 1, deleted: 1, failed: 0 })
      expect((await get(client, 'dst', 'backup/f1.txt')).text).toBe('FILE 1')
      await expect(get(client, 'dst', 'backup/extra.txt')).rejects.toThrow()
    }
  )

  it(
    'khác tài khoản: truyền qua máy (giữ Content-Type), tạo bucket đích khi cần, chặn chồng lấn',
    { timeout: 60_000 },
    async () => {
      const { server: a, client: ca } = await server(['photos'])
      const { server: b, client: cb } = await server(['other'])
      await put(ca, 'photos', '2024/a.json', '{"a":1}', 'application/json')
      await put(ca, 'photos', '2024/b.bin', 'x'.repeat(20_000))
      const s = service(a, { acc2: b })

      expect(
        ((await s.run({ op: 'listBucketsOf', accountId: 'acc2' })) as S3Bucket[]).map((x) => x.name)
      ).toEqual(['other'])

      const base = {
        bucket: 'photos',
        prefix: '',
        dest: { accountId: 'acc2', bucket: 'photos-copy', prefix: '' },
        mirror: false,
        compare: 'etag' as const,
        dryRun: false
      }
      const missing = await sync(s, { ...base, createBucket: false })
      expect(missing.phase).toBe('error')
      expect(missing.error).toContain('does not exist')

      const done = await sync(s, { ...base, createBucket: true, concurrency: 2 })
      expect(done.phase).toBe('done')
      expect(done.concurrency).toBe(2)
      expect(done.active).toEqual([])
      expect(done.serverSide).toBe(false)
      expect(done.done).toMatchObject({ copied: 2, failed: 0, bytes: 20_007 })
      expect(await get(cb, 'photos-copy', '2024/a.json')).toEqual({
        text: '{"a":1}',
        type: 'application/json'
      })

      const overlap = await sync(s, {
        ...base,
        dest: { bucket: 'photos', prefix: '2024/x/' },
        createBucket: false
      })
      expect(overlap.error).toContain('overlap')
    }
  )

  it('thông tin bucket (dịch vụ không hỗ trợ → null, không lỗi) và ghi file export', async () => {
    const { server: a } = await server(['demo'])
    const s = service(a)
    const info = (await s.run({ op: 'bucketInfo', bucket: 'demo' })) as S3BucketInfo
    expect(info).toHaveProperty('versioning')
    expect(info).toHaveProperty('encryption')
    const dir = tempDir()
    const file = join(dir, 'buckets.csv')
    await s.run({ op: 'writeFile', localPath: file, content: 'a,b\r\n' })
    expect(readFileSync(file, 'utf8')).toBe('a,b\r\n')
  })
})
