import { createHash, randomBytes } from 'node:crypto'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addStats,
  S3_OBJECT_CHANGED,
  type S3JobProgress,
  type S3Listing,
  type S3StatsProgress,
  type S3TransferDelta,
  type S3UploadConflict
} from '../../shared/ops'
import type { TransferStatus } from '@shared/sftp'
import { S3Service } from '../../session-host/service'
import { tempDir } from '../../../../../test/unit/helpers'
import { startS3TestServer, type S3TestServer } from '../s3-test-server'

let server: S3TestServer | null = null
let service: S3Service | null = null
afterEach(async () => {
  service?.dispose()
  service = null
  await server?.close()
  server = null
})

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

async function setup(onTransfers: (delta: S3TransferDelta) => void = () => undefined) {
  server = await startS3TestServer(['demo'])
  const s = new S3Service(
    {
      endpoint: server.endpoint,
      region: 'us-east-1',
      accessKeyId: server.accessKeyId,
      secretAccessKey: server.secretAccessKey,
      forcePathStyle: true
    },
    onTransfers
  )
  service = s
  const settled = async (): Promise<TransferStatus[]> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const list = s.transfers()
      if (list.every((t) => t.state === 'done' || t.state === 'error' || t.state === 'cancelled'))
        return list
      if (Date.now() > deadline) throw new Error(`Hết giờ: ${JSON.stringify(list)}`)
      await new Promise((r) => setTimeout(r, 30))
    }
  }
  return { s, settled }
}

/** Client S3 thô (ngoài S3Service) để chuẩn bị dữ liệu / kiểm tra kết quả. */
function rawClient(): S3Client {
  const srv = server
  if (!srv) throw new Error('server')
  return new S3Client({
    endpoint: srv.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: srv.accessKeyId, secretAccessKey: srv.secretAccessKey }
  })
}

/** Chạy việc nền (xoá / copy / đổi tên) và hỏi tiến độ tới khi xong. */
async function jobOf(s: S3Service, id: string): Promise<S3JobProgress> {
  for (;;) {
    const p = (await s.run({ op: 'jobPoll', id })) as S3JobProgress
    if (p.phase !== 'running') return p
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Chạy thống kê nền và hỏi tiến độ tới khi xong. */
async function statsOf(s: S3Service, bucket: string, prefix: string): Promise<S3StatsProgress> {
  const id = (await s.run({ op: 'statsStart', bucket, prefix })) as string
  for (;;) {
    const p = (await s.run({ op: 'statsPoll', id })) as S3StatsProgress
    if (p.done) return p
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('S3', () => {
  it(
    'bucket, thư mục, tải lên/về file và cả thư mục (multipart cho file lớn), xoá đệ quy',
    { timeout: 60_000 },
    async () => {
      const { s, settled } = await setup()
      expect(await s.run({ op: 'listBuckets' })).toEqual([
        expect.objectContaining({ name: 'demo' })
      ])
      await s.run({ op: 'createBucket', bucket: 'backups' })
      expect(
        ((await s.run({ op: 'listBuckets' })) as { name: string }[]).map((b) => b.name)
      ).toEqual(['backups', 'demo'])

      await s.run({ op: 'mkdir', bucket: 'demo', key: 'logs' })
      const local = tempDir()
      const big = randomBytes(20 * 1024 * 1024) // > partSize → multipart
      writeFileSync(join(local, 'big.bin'), big)
      mkdirSync(join(local, 'site', 'css'), { recursive: true })
      writeFileSync(join(local, 'site', 'index.html'), '<h1>hi</h1>')
      writeFileSync(join(local, 'site', 'css', 'a.css'), 'body{}')
      expect(
        await s.run({
          op: 'upload',
          bucket: 'demo',
          prefix: 'logs/',
          localPath: join(local, 'big.bin')
        })
      ).toBe(1)
      expect(
        await s.run({ op: 'upload', bucket: 'demo', prefix: '', localPath: join(local, 'site') })
      ).toBe(2)
      expect((await settled()).map((t) => t.state)).toEqual(['done', 'done', 'done'])

      const root = (await s.run({ op: 'list', bucket: 'demo', prefix: '' })) as S3Listing
      expect(root.entries.map((e) => [e.name, e.isFolder])).toEqual([
        ['logs', true],
        ['site', true]
      ])
      const logs = (await s.run({ op: 'list', bucket: 'demo', prefix: 'logs/' })) as S3Listing
      expect(logs.entries).toEqual([
        expect.objectContaining({ name: 'big.bin', key: 'logs/big.bin', size: big.length })
      ])

      // Tải về: file + cả thư mục.
      const out = tempDir()
      await s.run({
        op: 'download',
        bucket: 'demo',
        key: 'logs/big.bin',
        localPath: join(out, 'big.bin'),
        overwrite: false
      })
      await s.run({
        op: 'download',
        bucket: 'demo',
        key: 'site/',
        localPath: out,
        overwrite: false
      })
      await settled()
      expect(sha(readFileSync(join(out, 'big.bin')))).toBe(sha(big))
      expect(readFileSync(join(out, 'site', 'css', 'a.css'), 'utf8')).toBe('body{}')
      await expect(
        s.run({ op: 'download', bucket: 'demo', key: 'site/', localPath: out, overwrite: false })
      ).rejects.toThrow(/already exists/)

      // Link có hạn tải được mà không cần khoá.
      const url = (await s.run({
        op: 'presign',
        bucket: 'demo',
        key: 'site/index.html',
        expiresSeconds: 600
      })) as string
      expect(await (await fetch(url)).text()).toBe('<h1>hi</h1>')

      // Xoá cả thư mục.
      expect(await s.run({ op: 'delete', bucket: 'demo', keys: ['site/'] })).toBeGreaterThanOrEqual(
        2
      )
      const after = (await s.run({ op: 'list', bucket: 'demo', prefix: '' })) as S3Listing
      expect(after.entries.map((e) => e.name)).toEqual(['logs'])
      expect(existsSync(join(out, 'site'))).toBe(true) // bản trên máy không bị đụng
    }
  )

  it('editor trong app: đọc / ghi object, giữ Content-Type + metadata, báo khi ETag đổi', async () => {
    const { s } = await setup()
    const srv = server
    if (!srv) throw new Error('server')
    const raw = new S3Client({
      endpoint: srv.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: srv.accessKeyId, secretAccessKey: srv.secretAccessKey }
    })
    await raw.send(
      new PutObjectCommand({
        Bucket: 'demo',
        Key: 'conf/app.yaml',
        Body: 'replicas: 1\n',
        ContentType: 'application/yaml',
        Metadata: { owner: 'ops' }
      })
    )
    const opened = (await s.run({ op: 'readText', bucket: 'demo', key: 'conf/app.yaml' })) as {
      data: string
      etag: string
    }
    expect(Buffer.from(opened.data, 'base64').toString()).toBe('replicas: 1\n')
    const saved = (await s.run({
      op: 'writeText',
      bucket: 'demo',
      key: 'conf/app.yaml',
      data: Buffer.from('replicas: 3\n').toString('base64'),
      expectEtag: opened.etag
    })) as { etag: string }
    const head = await raw.send(new HeadObjectCommand({ Bucket: 'demo', Key: 'conf/app.yaml' }))
    expect(head.ContentType).toBe('application/yaml')
    expect(head.Metadata).toEqual({ owner: 'ops' })
    expect(head.ETag).toBe(saved.etag)

    // Ai đó ghi đè object → lưu với ETag cũ bị từ chối.
    await raw.send(new PutObjectCommand({ Bucket: 'demo', Key: 'conf/app.yaml', Body: 'x: 1\n' }))
    await expect(
      s.run({
        op: 'writeText',
        bucket: 'demo',
        key: 'conf/app.yaml',
        data: Buffer.from('mine\n').toString('base64'),
        expectEtag: saved.etag
      })
    ).rejects.toThrow(S3_OBJECT_CHANGED)
    raw.destroy()
  })

  it('thống kê, copy / move / đổi tên file và thư mục', { timeout: 60_000 }, async () => {
    const { s, settled } = await setup()
    await s.run({ op: 'createBucket', bucket: 'other' })
    const local = tempDir()
    mkdirSync(join(local, 'site', 'css'), { recursive: true })
    writeFileSync(join(local, 'site', 'index.html'), '<h1>hi</h1>')
    writeFileSync(join(local, 'site', 'css', 'a.css'), 'body{}')
    writeFileSync(join(local, 'note.txt'), 'hello')
    await s.run({ op: 'upload', bucket: 'demo', prefix: '', localPath: join(local, 'site') })
    await s.run({ op: 'upload', bucket: 'demo', prefix: '', localPath: join(local, 'note.txt') })
    await s.run({ op: 'mkdir', bucket: 'demo', key: 'empty/' })
    await settled()
    const names = async (bucket: string, prefix: string): Promise<string[]> =>
      ((await s.run({ op: 'list', bucket, prefix })) as S3Listing).entries.map((e) => e.name)

    // Thống kê: bỏ qua object "thư mục" rỗng.
    const stats = await statsOf(s, 'demo', '')
    expect(stats).toMatchObject({ objects: 3, bytes: 11 + 6 + 5, done: true, error: null })
    expect(stats.byClass.STANDARD?.objects).toBe(3)
    const site = await statsOf(s, 'demo', 'site/')
    expect(addStats(stats, site)).toMatchObject({ objects: 5, bytes: 22 + 17 })

    // Đổi tên file + thư mục.
    await s.run({
      op: 'rename',
      bucket: 'demo',
      key: 'note.txt',
      name: 'readme.txt',
      overwrite: false
    })
    await s.run({ op: 'rename', bucket: 'demo', key: 'site/', name: 'www', overwrite: false })
    expect(await names('demo', '')).toEqual(['empty', 'www', 'readme.txt'])
    expect(await names('demo', 'www/css/')).toEqual(['a.css'])
    await expect(
      s.run({ op: 'rename', bucket: 'demo', key: 'www/', name: 'a/b', overwrite: false })
    ).rejects.toThrow(/cannot contain/)

    // Copy sang bucket khác, move vào thư mục; trùng tên → báo lỗi, không ghi đè.
    expect(
      await s.run({
        op: 'copy',
        bucket: 'demo',
        keys: ['www/', 'readme.txt'],
        destBucket: 'other',
        destPrefix: 'backup',
        move: false,
        overwrite: false
      })
    ).toBe(3)
    expect(await names('other', 'backup/www/')).toEqual(['css', 'index.html'])
    await expect(
      s.run({
        op: 'copy',
        bucket: 'demo',
        keys: ['readme.txt'],
        destBucket: 'other',
        destPrefix: 'backup/',
        move: false,
        overwrite: false
      })
    ).rejects.toThrow(/already exists/)
    await expect(
      s.run({
        op: 'copy',
        bucket: 'demo',
        keys: ['www/'],
        destBucket: 'demo',
        destPrefix: 'www/css/',
        move: true,
        overwrite: false
      })
    ).rejects.toThrow(/into itself/)
    await s.run({
      op: 'copy',
      bucket: 'demo',
      keys: ['readme.txt'],
      destBucket: 'demo',
      destPrefix: 'empty/',
      move: true,
      overwrite: false
    })
    expect(await names('demo', '')).toEqual(['empty', 'www'])
    expect(await names('demo', 'empty/')).toEqual(['readme.txt'])
  })

  it(
    'sửa object bằng editor: lưu → tải lên; object bị người khác sửa → không ghi đè',
    { timeout: 60_000 },
    async () => {
      const { s, settled } = await setup()
      const local = tempDir()
      writeFileSync(join(local, 'conf.json'), '{"a":1}')
      await s.run({ op: 'upload', bucket: 'demo', prefix: '', localPath: join(local, 'conf.json') })
      await settled()
      const editDir = tempDir()
      const editPath = join(editDir, 'conf.json')
      await s.run({ op: 'edit', bucket: 'demo', key: 'conf.json', localPath: editPath })
      expect(readFileSync(editPath, 'utf8')).toBe('{"a":1}')

      const remote = async (): Promise<string> => {
        const out = tempDir()
        await s.run({
          op: 'download',
          bucket: 'demo',
          key: 'conf.json',
          localPath: join(out, 'c'),
          overwrite: true
        })
        await settled()
        return readFileSync(join(out, 'c'), 'utf8')
      }
      writeFileSync(editPath, '{"a":2}')
      await expect.poll(remote, { timeout: 10_000 }).toBe('{"a":2}')

      // Người khác ghi đè object → lần lưu tiếp theo phải báo lỗi, không đè.
      writeFileSync(join(local, 'conf.json'), '{"other":true}')
      await s.run({ op: 'upload', bucket: 'demo', prefix: '', localPath: join(local, 'conf.json') })
      await settled()
      writeFileSync(editPath, '{"a":3}')
      await expect
        .poll(() => s.transfers().some((t) => t.edit && t.state === 'error'), { timeout: 10_000 })
        .toBe(true)
      // Chỉ xét lượt tải lên của tính năng sửa: lượt tải về kiểm tra ở trên có thể lỗi "aborted" khi
      // đọc đúng lúc object đang bị ghi đè (s3rver) — không liên quan.
      expect(s.transfers().find((t) => t.edit && t.state === 'error')?.error).toMatch(
        /changed on the server/
      )
      expect(await remote()).toBe('{"other":true}')
    }
  )

  it(
    'duyệt cây song song: cây sâu hơn mức chia việc, đếm đúng mỗi object một lần; xoá / tải về cả cây',
    { timeout: 60_000 },
    async () => {
      const { s, settled } = await setup()
      // 5 cấp, mỗi thư mục 3 nhánh + 1 file ở mọi cấp = 1 + 3 + 9 + 27 + 81 = 121 file.
      const local = tempDir()
      const tree = join(local, 'tree')
      let files = 0
      const make = (dir: string, depth: number): void => {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `f${depth}.txt`), 'x'.repeat(depth + 1))
        files++
        if (depth < 4) for (const b of ['a', 'b', 'c']) make(join(dir, b), depth + 1)
      }
      make(tree, 0)
      expect(files).toBe(1 + 3 + 9 + 27 + 81)
      await s.run({ op: 'upload', bucket: 'demo', prefix: '', localPath: tree })
      expect((await settled()).every((t) => t.state === 'done')).toBe(true)

      const all = await statsOf(s, 'demo', '')
      expect(all.objects).toBe(files)
      expect(all.bytes).toBe(1 * 1 + 3 * 2 + 9 * 3 + 27 * 4 + 81 * 5)
      expect((await statsOf(s, 'demo', 'tree/a/b/')).objects).toBe(1 + 3 + 9)

      // Dừng giữa chừng: poll sau khi dừng báo "đã dừng", không treo.
      const id = (await s.run({ op: 'statsStart', bucket: 'demo', prefix: '' })) as string
      const stopped = (await s.run({ op: 'statsStop', id })) as S3StatsProgress
      expect(stopped.done).toBe(true)
      await expect(s.run({ op: 'statsPoll', id })).rejects.toThrow(/stopped/)

      // Tải về cả cây (liệt kê song song) → đủ file, đúng nội dung.
      const out = tempDir()
      expect(
        await s.run({
          op: 'download',
          bucket: 'demo',
          key: 'tree/',
          localPath: out,
          overwrite: false
        })
      ).toBe(files)
      await settled()
      expect(readFileSync(join(out, 'tree', 'a', 'b', 'c', 'a', 'f4.txt'), 'utf8')).toBe('xxxxx')

      // Xoá cả cây (xoá theo lô song song).
      expect(await s.run({ op: 'delete', bucket: 'demo', keys: ['tree/'] })).toBe(files)
      expect((await statsOf(s, 'demo', '')).objects).toBe(0)
    }
  )

  it(
    'tải lên: kiểm tra trùng, bỏ qua file đã có; tải về thư mục với tên an toàn; Transfers chỉ gửi phần đổi',
    { timeout: 60_000 },
    async () => {
      const deltas: S3TransferDelta[] = []
      const { s, settled } = await setup((d) => deltas.push(d))
      const local = tempDir()
      mkdirSync(join(local, 'site'), { recursive: true })
      writeFileSync(join(local, 'site', 'index.html'), 'v1')
      writeFileSync(join(local, 'site', 'a.css'), 'a')
      writeFileSync(join(local, 'note.txt'), 'n1')
      await s.run({ op: 'upload', bucket: 'demo', prefix: '', localPath: join(local, 'site') })
      await s.run({ op: 'upload', bucket: 'demo', prefix: '', localPath: join(local, 'note.txt') })
      await settled()

      writeFileSync(join(local, 'site', 'index.html'), 'v2')
      writeFileSync(join(local, 'site', 'b.css'), 'b')
      writeFileSync(join(local, 'new.txt'), 'x')
      const check = (await s.run({
        op: 'uploadCheck',
        bucket: 'demo',
        prefix: '',
        localPaths: [join(local, 'site'), join(local, 'note.txt'), join(local, 'new.txt')]
      })) as S3UploadConflict[]
      expect(check.map((c) => [c.name, c.isFolder, c.files, c.existing])).toEqual([
        ['site', true, 3, 2],
        ['note.txt', false, 1, 1],
        ['new.txt', false, 1, 0]
      ])
      // Bỏ qua file đã có: chỉ b.css được tải lên, index.html trên bucket giữ bản cũ.
      expect(
        await s.run({
          op: 'upload',
          bucket: 'demo',
          prefix: '',
          localPath: join(local, 'site'),
          overwrite: false
        })
      ).toBe(1)
      await settled()
      const raw = rawClient()
      const text = async (key: string): Promise<string | undefined> =>
        (
          await raw.send(new GetObjectCommand({ Bucket: 'demo', Key: key }))
        ).Body?.transformToString()
      expect(await text('site/index.html')).toBe('v1')
      expect(await text('site/b.css')).toBe('b')

      // Tải nhiều file về một thư mục: Session Host tự đặt tên an toàn từ key.
      await raw.send(new PutObjectCommand({ Bucket: 'demo', Key: 'x/..\\..\\evil.txt', Body: 'e' }))
      const out = tempDir()
      for (const key of ['x/..\\..\\evil.txt', 'site/a.css'])
        await s.run({
          op: 'download',
          bucket: 'demo',
          key,
          localPath: out,
          overwrite: false,
          intoFolder: true
        })
      await settled()
      expect(readFileSync(join(out, '.._.._evil.txt'), 'utf8')).toBe('e')
      expect(readFileSync(join(out, 'a.css'), 'utf8')).toBe('a')

      // Hai key ra cùng tên an toàn, tải cùng lúc vào một thư mục → không ghi chung file (.part).
      await raw.send(new PutObjectCommand({ Bucket: 'demo', Key: 'same/r:1.txt', Body: 'colon' }))
      await raw.send(new PutObjectCommand({ Bucket: 'demo', Key: 'same/r_1.txt', Body: 'under' }))
      const both = tempDir()
      await Promise.all(
        ['same/r_1.txt', 'same/r:1.txt'].map((key) =>
          s.run({
            op: 'download',
            bucket: 'demo',
            key,
            localPath: both,
            overwrite: true,
            intoFolder: true
          })
        )
      )
      await settled()
      expect(
        [
          readFileSync(join(both, 'r_1.txt'), 'utf8'),
          readFileSync(join(both, 'r_1 (2).txt'), 'utf8')
        ].sort()
      ).toEqual(['colon', 'under'])
      raw.destroy()

      // Ghép các tin "phần thay đổi" lại = đúng danh sách đầy đủ; Clear finished gửi danh sách xoá.
      const rebuild = (): Map<string, TransferStatus> => {
        const m = new Map<string, TransferStatus>()
        for (const d of deltas) {
          for (const id of d.remove) m.delete(id)
          for (const t of d.upsert) m.set(t.id, t)
        }
        return m
      }
      await expect.poll(() => [...rebuild().values()]).toEqual(s.transfers())
      expect(deltas.length).toBeLessThan(s.transfers().length * 4)
      await s.run({ op: 'clearDone' })
      expect(s.transfers()).toEqual([])
      expect(rebuild().size).toBe(0)
    }
  )

  it(
    'việc nền: đếm, copy / đổi tên / xoá thư mục, trùng tên, dừng giữa chừng',
    { timeout: 120_000 },
    async () => {
      const { s } = await setup()
      const raw = rawClient()
      // s3rver hỏng khi danh sách bị cắt trang (token dùng DES — OpenSSL 3 không còn): ở đây dưới
      // 1000 object; phân trang + xoá trong lúc liệt kê kiểm tra ở test/unit/bulk.test.ts.
      const N = 600
      const keys = Array.from({ length: N }, (_, i) => `big/d${i % 3}/f${i}.txt`)
      for (let i = 0; i < keys.length; i += 50)
        await Promise.all(
          keys
            .slice(i, i + 50)
            .map((Key) => raw.send(new PutObjectCommand({ Bucket: 'demo', Key, Body: 'x' })))
        )
      raw.destroy()

      expect(
        await s.run({ op: 'countObjects', bucket: 'demo', keys: ['big/'], limit: 500 })
      ).toEqual({ count: 500, more: true })
      expect(
        await s.run({ op: 'countObjects', bucket: 'demo', keys: ['big/', 'x.txt'], limit: 5000 })
      ).toEqual({ count: N + 1, more: false })

      const copy = await jobOf(
        s,
        (await s.run({
          op: 'jobStart',
          job: {
            kind: 'copy',
            bucket: 'demo',
            keys: ['big/'],
            destBucket: 'demo',
            destPrefix: 'copy',
            move: false,
            overwrite: false
          }
        })) as string
      )
      expect(copy).toMatchObject({ phase: 'done', found: N, done: N, failed: 0, error: null })

      // Trùng tên → lỗi chặn trước khi làm gì (file: s3rver hỏng với MaxKeys khi kiểm tra thư mục).
      const dup = await jobOf(
        s,
        (await s.run({
          op: 'jobStart',
          job: {
            kind: 'copy',
            bucket: 'demo',
            keys: ['big/d0/f0.txt'],
            destBucket: 'demo',
            destPrefix: 'copy/big/d0',
            move: false,
            overwrite: false
          }
        })) as string
      )
      expect(dup).toMatchObject({ phase: 'error', done: 0 })
      expect(dup.error).toMatch(/already exists/)

      const renamed = await jobOf(
        s,
        (await s.run({
          op: 'jobStart',
          job: { kind: 'rename', bucket: 'demo', key: 'copy/big/', name: 'moved', overwrite: false }
        })) as string
      )
      expect(renamed).toMatchObject({ phase: 'done', done: N, failed: 0 })
      expect((await statsOf(s, 'demo', 'copy/moved/')).objects).toBe(N)
      expect((await statsOf(s, 'demo', 'copy/big/')).objects).toBe(0)

      // Dừng ngay: không treo, báo "stopped".
      const stopId = (await s.run({
        op: 'jobStart',
        job: {
          kind: 'copy',
          bucket: 'demo',
          keys: ['big/'],
          destBucket: 'demo',
          destPrefix: 'c2',
          move: false,
          overwrite: false
        }
      })) as string
      await s.run({ op: 'jobStop', id: stopId })
      const stopped = await jobOf(s, stopId)
      expect(stopped.phase).toBe('stopped')
      expect(stopped.done).toBeLessThan(N)

      const removed = await jobOf(
        s,
        (await s.run({
          op: 'jobStart',
          job: { kind: 'delete', bucket: 'demo', keys: ['big/', 'copy/', 'c2/'] }
        })) as string
      )
      expect(removed).toMatchObject({ phase: 'done', failed: 0 })
      expect(removed.done).toBeGreaterThanOrEqual(2 * N)
      expect((await statsOf(s, 'demo', '')).objects).toBe(0)
      await expect(s.run({ op: 'jobPoll', id: stopId })).rejects.toThrow(/stopped/)
      // s3rver không có versioning: không lỗi, trả về trạng thái hoặc null.
      expect([null, 'Off', 'Enabled', 'Suspended']).toContain(
        await s.run({ op: 'versioning', bucket: 'demo' })
      )
    }
  )

  it(
    'sửa bằng editor trên máy: tải lên đè giữ Content-Type + metadata',
    { timeout: 60_000 },
    async () => {
      const { s } = await setup()
      const raw = rawClient()
      await raw.send(
        new PutObjectCommand({
          Bucket: 'demo',
          Key: 'conf/app.yaml',
          Body: 'a: 1\n',
          ContentType: 'application/yaml',
          CacheControl: 'no-cache',
          Metadata: { owner: 'ops' }
        })
      )
      const editPath = join(tempDir(), 'app.yaml')
      await s.run({ op: 'edit', bucket: 'demo', key: 'conf/app.yaml', localPath: editPath })
      writeFileSync(editPath, 'a: 2\n')
      await expect
        .poll(
          async () =>
            (
              await raw.send(new GetObjectCommand({ Bucket: 'demo', Key: 'conf/app.yaml' }))
            ).Body?.transformToString(),
          { timeout: 10_000 }
        )
        .toBe('a: 2\n')
      const head = await raw.send(new HeadObjectCommand({ Bucket: 'demo', Key: 'conf/app.yaml' }))
      expect(head.ContentType).toBe('application/yaml')
      expect(head.CacheControl).toBe('no-cache')
      expect(head.Metadata).toEqual({ owner: 'ops' })
      raw.destroy()
    }
  )

  it('gốc bucket chỉ có thư mục lồng nhau (không có object ở gốc) vẫn liệt kê được', async () => {
    const { s } = await setup()
    const raw = rawClient()
    await raw.send(
      new PutObjectCommand({ Bucket: 'demo', Key: 'a/b/c/d/e/report.txt', Body: 'hello' })
    )
    raw.destroy()
    // Hỏi vùng của bucket trước (như khi mở bucket trong app) rồi mới liệt kê.
    await s.run({ op: 'listBuckets' })
    const root = (await s.run({ op: 'list', bucket: 'demo', prefix: '' })) as S3Listing
    expect(root.entries.map((e) => [e.name, e.key, e.isFolder])).toEqual([['a', 'a/', true]])
    const deep = (await s.run({ op: 'list', bucket: 'demo', prefix: 'a/b/c/d/e/' })) as S3Listing
    expect(deep.entries.map((e) => e.name)).toEqual(['report.txt'])
  })

  it('access key sai → lỗi dễ hiểu', async () => {
    server = await startS3TestServer()
    service = new S3Service(
      {
        endpoint: server.endpoint,
        region: 'us-east-1',
        accessKeyId: 'KHONG-CO',
        secretAccessKey: 'S3RVER',
        forcePathStyle: true
      },
      () => undefined
    )
    await expect(service.run({ op: 'listBuckets' })).rejects.toThrow(/access key ID is not valid/)
  })

  it(
    '`search` hỏi server theo prefix trong thư mục: tên tính theo thư mục, phân biệt hoa thường, có cả thư mục con',
    { timeout: 60_000 },
    async () => {
      const { s } = await setup()
      const raw = rawClient()
      const keys = [
        ...Array.from({ length: 12 }, (_, i) => `many/f${String(i).padStart(5, '0')}.txt`),
        'many/zeta.txt',
        'many/sub/inner.txt'
      ]
      await Promise.all(
        keys.map((Key) => raw.send(new PutObjectCommand({ Bucket: 'demo', Key, Body: 'x' })))
      )
      const found = (await s.run({
        op: 'list',
        bucket: 'demo',
        prefix: 'many/',
        search: 'f0000'
      })) as S3Listing
      expect(found.search).toBe('f0000')
      expect(found.prefix).toBe('many/')
      expect(found.entries.map((e) => e.name)).toEqual(
        Array.from({ length: 10 }, (_, i) => `f0000${String(i)}.txt`)
      )
      expect(found.entries[0]?.key).toBe('many/f00000.txt')

      const folder = (await s.run({
        op: 'list',
        bucket: 'demo',
        prefix: 'many/',
        search: 'su'
      })) as S3Listing
      expect(folder.entries).toEqual([
        expect.objectContaining({ name: 'sub', isFolder: true, key: 'many/sub/' })
      ])
      // Phân biệt hoa thường (prefix của S3) và không khớp → rỗng, không lỗi.
      expect(
        (
          (await s.run({
            op: 'list',
            bucket: 'demo',
            prefix: 'many/',
            search: 'ZETA'
          })) as S3Listing
        ).entries
      ).toEqual([])
      // Không `search` → như cũ (không có trường search).
      const plain = (await s.run({ op: 'list', bucket: 'demo', prefix: 'many/' })) as S3Listing
      expect(plain.search).toBeUndefined()
      expect(plain.entries).toHaveLength(14)
    }
  )
})
