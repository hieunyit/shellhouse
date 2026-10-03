import { DeleteObjectsCommand, HeadBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { BulkJob, type BulkEnv } from '../../session-host/bulk'
import { bucketRegionHeader, S3Service } from '../../session-host/service'

/** Service AWS (không endpoint) với `send` của client chính bị thay bằng hàm giả. */
function awsService(send: (command: unknown) => Promise<unknown>) {
  const s = new S3Service(
    { endpoint: '', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b' } as never,
    () => undefined
  )
  const inner = s as unknown as { client: { send: unknown } }
  inner.client.send = send
  return s
}

function awsError(statusCode: number, region?: string): Error {
  return Object.assign(new Error('fail'), {
    $response: {
      statusCode,
      headers: region ? { 'x-amz-bucket-region': region } : {}
    }
  })
}

describe('S3 lookupRegion', () => {
  it('đọc x-amz-bucket-region từ lỗi 301/400/403', () => {
    expect(bucketRegionHeader(awsError(301, 'eu-west-1'))).toBe('eu-west-1')
    expect(bucketRegionHeader(awsError(403, 'ap-southeast-1'))).toBe('ap-southeast-1')
    expect(bucketRegionHeader(awsError(404, 'eu-west-1'))).toBeNull()
    expect(bucketRegionHeader(awsError(403))).toBeNull()
    expect(bucketRegionHeader(new Error('x'))).toBeNull()
  })

  it('HeadBucket lỗi có header → nhớ region, không hỏi lại', async () => {
    let heads = 0
    const s = awsService((c) => {
      if (c instanceof HeadBucketCommand) heads++
      return Promise.reject(awsError(403, 'eu-west-1'))
    })
    const a = await s.clientFor('b')
    const b = await s.clientFor('b')
    expect(a).toBe(b)
    expect(heads).toBe(1)
    s.dispose()
  })

  it('HeadBucket lỗi không header → dùng region tài khoản, không hỏi lại ngay', async () => {
    let heads = 0
    const s = awsService((c) => {
      if (c instanceof HeadBucketCommand) heads++
      return Promise.reject(awsError(500))
    })
    await s.clientFor('b')
    await s.clientFor('b')
    await s.clientFor('b')
    expect(heads).toBe(1)
    s.dispose()
  })
})

describe('S3 bulk', () => {
  it('lỗi liệt kê: chờ các lô xoá đang chạy xong rồi mới chốt phase', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    let deleted = 0
    const client = {
      send: async (command: unknown) => {
        if (command instanceof ListObjectsV2Command) throw new Error('list failed')
        if (command instanceof DeleteObjectsCommand) {
          await gate
          deleted += command.input.Delete?.Objects?.length ?? 0
          return {}
        }
        throw new Error('unexpected')
      }
    }
    const env: BulkEnv = {
      clientFor: () => Promise.resolve(client as never),
      requests: 4,
      deleteParallel: 4
    }
    const job = new BulkJob(env, { kind: 'delete', bucket: 'b', keys: ['x', 'y', 'dir/'] })
    await new Promise((r) => setTimeout(r, 20))
    // Liệt kê đã lỗi nhưng lô xoá còn bay → chưa được chốt.
    expect(job.done).toBe(false)
    release()
    await job.finished
    const p = job.snapshot()
    expect(p.phase).toBe('error')
    expect(p.done).toBe(2)
    expect(deleted).toBe(2)
  })

  it('op delete cũ (runBulk) được dispose dừng', async () => {
    let calls = 0
    const s = new S3Service(
      {
        endpoint: 'http://127.0.0.1:1',
        region: 'us-east-1',
        accessKeyId: 'a',
        secretAccessKey: 'b'
      } as never,
      () => undefined
    )
    const inner = s as unknown as { client: { send: unknown }; bulkJobs: Map<string, unknown> }
    inner.client.send = (_c: unknown, opts?: { abortSignal?: AbortSignal }) => {
      calls++
      return new Promise((_resolve, reject) => {
        opts?.abortSignal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }
    const run = s.run({ op: 'delete', bucket: 'b', keys: ['k'] } as never)
    await new Promise((r) => setTimeout(r, 10))
    expect(inner.bulkJobs.size).toBe(1)
    s.dispose()
    await expect(run).resolves.toBe(0)
    expect(calls).toBe(1)
    expect(inner.bulkJobs.size).toBe(0)
  })
})
