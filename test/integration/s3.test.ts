import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addStats, type S3Listing, type S3StatsPage } from '@shared/s3'
import type { TransferStatus } from '@shared/sftp'
import { S3Service } from '../../src/session-host/s3/service'
import { tempDir } from '../unit/helpers'
import { startS3TestServer, type S3TestServer } from './s3-test-server'

let server: S3TestServer | null = null
let service: S3Service | null = null
afterEach(async () => {
  service?.dispose()
  service = null
  await server?.close()
  server = null
})

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

async function setup() {
  server = await startS3TestServer(['demo'])
  const s = new S3Service(
    {
      endpoint: server.endpoint,
      region: 'us-east-1',
      accessKeyId: server.accessKeyId,
      secretAccessKey: server.secretAccessKey,
      forcePathStyle: true
    },
    () => undefined
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
    const stats = (await s.run({ op: 'stats', bucket: 'demo', prefix: '' })) as S3StatsPage
    expect(stats).toMatchObject({ objects: 3, bytes: 11 + 6 + 5, next: null })
    expect(stats.byClass.STANDARD?.objects).toBe(3)
    const site = (await s.run({ op: 'stats', bucket: 'demo', prefix: 'site/' })) as S3StatsPage
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

  it('sửa object bằng editor: lưu → tải lên; object bị người khác sửa → không ghi đè', async () => {
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
    expect(s.transfers().find((t) => t.state === 'error')?.error).toMatch(/changed on the server/)
    expect(await remote()).toBe('{"other":true}')
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
})
