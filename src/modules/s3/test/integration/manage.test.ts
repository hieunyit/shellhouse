import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it } from 'vitest'
import type { S3Feature, S3ObjectDetails, S3Tag } from '../../shared/manage'
import { S3Service } from '../../session-host/service'
import { startS3TestServer, type S3TestServer } from '../s3-test-server'

let server: S3TestServer | null = null
let service: S3Service | null = null
let raw: S3Client | null = null
afterEach(async () => {
  service?.dispose()
  service = null
  raw?.destroy()
  raw = null
  await server?.close()
  server = null
})

/** S3Service thật nối s3rver (s3rver có tag object + CORS; không có versioning / lifecycle). */
async function setup(): Promise<{ s: S3Service; client: S3Client }> {
  server = await startS3TestServer(['demo'])
  const connection = {
    endpoint: server.endpoint,
    region: 'us-east-1',
    accessKeyId: server.accessKeyId,
    secretAccessKey: server.secretAccessKey,
    forcePathStyle: true
  }
  service = new S3Service(connection, () => undefined)
  raw = new S3Client({
    endpoint: server.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: server.accessKeyId, secretAccessKey: server.secretAccessKey }
  })
  return { s: service, client: raw }
}

describe('S3 quản lý trên server tương thích S3 (s3rver)', () => {
  it('versioning / lifecycle: dịch vụ không hỗ trợ → trạng thái, không ném lỗi', async () => {
    const { s } = await setup()
    // s3rver trả versioning rỗng (như MinIO một ổ đĩa) — tuỳ bản là "Off" hoặc không hỗ trợ.
    expect([{ state: 'ok', value: 'Off' }, { state: 'unsupported' }]).toContainEqual(
      await s.run({ op: 'getVersioning', bucket: 'demo' })
    )
    expect(await s.run({ op: 'getLifecycle', bucket: 'demo' })).toEqual({ state: 'unsupported' })
  })

  it('CORS: chưa có → [], ghi rồi đọc lại, xoá', async () => {
    const { s } = await setup()
    expect(await s.run({ op: 'getCors', bucket: 'demo' })).toEqual({ state: 'ok', value: [] })
    const rules = [
      {
        AllowedMethods: ['GET' as const, 'HEAD' as const],
        AllowedOrigins: ['https://app.example.com'],
        AllowedHeaders: ['*'],
        MaxAgeSeconds: 600
      }
    ]
    await s.run({ op: 'putCors', bucket: 'demo', rules })
    expect(await s.run({ op: 'getCors', bucket: 'demo' })).toEqual({ state: 'ok', value: rules })
    await s.run({ op: 'putCors', bucket: 'demo', rules: [] })
    expect(await s.run({ op: 'getCors', bucket: 'demo' })).toEqual({ state: 'ok', value: [] })
  })

  it('chi tiết object, tag, sửa metadata (giữ nội dung, ETag mới)', async () => {
    const { s, client } = await setup()
    await client.send(
      new PutObjectCommand({
        Bucket: 'demo',
        Key: 'docs/report.txt',
        Body: 'hello',
        ContentType: 'text/plain',
        Metadata: { owner: 'ops' }
      })
    )
    const d = (await s.run({
      op: 'objectDetails',
      bucket: 'demo',
      key: 'docs/report.txt'
    })) as S3ObjectDetails
    expect(d).toMatchObject({
      key: 'docs/report.txt',
      size: 5,
      contentType: 'text/plain',
      storageClass: 'STANDARD',
      metadata: { owner: 'ops' },
      tags: { state: 'ok', value: [] }
    })
    expect(d.etag).toBeTruthy()

    const tags: S3Tag[] = [
      { key: 'project', value: 'shellhouse' },
      { key: 'env', value: 'prod' }
    ]
    await s.run({ op: 'putTags', bucket: 'demo', key: 'docs/report.txt', tags })
    const tagged = (await s.run({
      op: 'objectDetails',
      bucket: 'demo',
      key: 'docs/report.txt'
    })) as S3ObjectDetails
    expect((tagged.tags as Extract<S3Feature<S3Tag[]>, { state: 'ok' }>).value).toEqual(
      expect.arrayContaining(tags)
    )

    const updated = (await s.run({
      op: 'updateObject',
      bucket: 'demo',
      key: 'docs/report.txt',
      edit: {
        contentType: 'text/markdown',
        cacheControl: 'max-age=60',
        contentDisposition: 'attachment',
        metadata: [{ key: 'Reviewed-By', value: 'an' }]
      },
      ...(d.etag ? { expectEtag: d.etag } : {})
    })) as S3ObjectDetails
    expect(updated).toMatchObject({
      contentType: 'text/markdown',
      cacheControl: 'max-age=60',
      contentDisposition: 'attachment',
      metadata: { 'reviewed-by': 'an' },
      size: 5
    })
    const head = await client.send(
      new HeadObjectCommand({ Bucket: 'demo', Key: 'docs/report.txt' })
    )
    expect(head.Metadata).toEqual({ 'reviewed-by': 'an' })

    // ETag cũ (người khác vừa sửa) → không ghi đè.
    await expect(
      s.run({
        op: 'updateObject',
        bucket: 'demo',
        key: 'docs/report.txt',
        edit: { contentType: 'text/plain', cacheControl: '', contentDisposition: '', metadata: [] },
        expectEtag: '"not-the-etag"'
      })
    ).rejects.toThrow(/changed/)
  })
})
