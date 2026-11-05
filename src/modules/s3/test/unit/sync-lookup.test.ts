import {
  CopyObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client
} from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { SyncJob } from '../../session-host/sync'
import type { S3Op } from '../../shared/ops'

const notFound = () => Object.assign(new Error('Missing'), { name: 'NotFound' })
const base: Extract<S3Op, { op: 'syncStart' }> = {
  op: 'syncStart',
  bucket: 'src',
  prefix: 'data/',
  dest: { bucket: 'dst', prefix: 'backup/' },
  mirror: false,
  compare: 'etag',
  dryRun: false,
  createBucket: false
}

function job(
  send: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>,
  op = base
): SyncJob {
  const client = { send } as unknown as S3Client
  return new SyncJob(
    { source: client, dest: client, destRegion: 'us-east-1', serverSide: true, concurrency: 3 },
    op
  )
}

describe('source-driven S3 sync', () => {
  it('copies before the next source page or remaining checks, never lists the destination and bounds parallel work', async () => {
    const events: string[] = []
    let inFlight = 0
    let peak = 0
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      if (command instanceof HeadBucketCommand) return {}
      if (command instanceof ListObjectsV2Command) {
        expect(command.input.Bucket).toBe('src')
        expect(command.input.Prefix).toBe('data/')
        events.push(command.input.ContinuationToken ? 'page2' : 'page1')
        if (command.input.ContinuationToken) {
          expect(events).toContain('copy:backup/0')
          return { Contents: [{ Key: 'data/last', Size: 1 }] }
        }
        return {
          Contents: Array.from({ length: 6 }, (_, i) => ({ Key: `data/${i}`, Size: 1 })),
          IsTruncated: true,
          NextContinuationToken: 'next'
        }
      }
      inFlight++
      peak = Math.max(peak, inFlight)
      try {
        await Promise.resolve()
        if (command instanceof HeadObjectCommand) {
          events.push(`head:${command.input.Key ?? ''}`)
          throw notFound()
        }
        if (command instanceof CopyObjectCommand) {
          events.push(`copy:${command.input.Key ?? ''}`)
          return {}
        }
        throw new Error('Unexpected request')
      } finally {
        inFlight--
      }
    })
    const sync = job(send)
    await sync.run()
    expect(sync.snapshot()).toMatchObject({
      phase: 'done',
      strategy: 'lookup',
      listing: false,
      scanned: { source: 7, dest: 7 },
      plan: { new: 7 },
      done: { copied: 7, failed: 0 }
    })
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
    expect(events.indexOf('copy:backup/0')).toBeLessThan(events.indexOf('head:backup/5'))
    expect(events.indexOf('copy:backup/0')).toBeLessThan(events.indexOf('page2'))
    expect(
      send.mock.calls.filter(([command]) => command instanceof HeadObjectCommand)
    ).toHaveLength(7)
  })

  it('compares size and ETag, skips unchanged objects and never overwrites a destination whose HEAD is denied', async () => {
    const copied: string[] = []
    const send = async (command: unknown): Promise<unknown> => {
      await Promise.resolve()
      if (command instanceof HeadBucketCommand) return {}
      if (command instanceof ListObjectsV2Command) {
        expect(command.input.Bucket).toBe('src')
        return {
          Contents: ['same', 'changed', 'new', 'denied'].map((key) => ({
            Key: `data/${key}`,
            Size: 2,
            ETag: 'aa'
          }))
        }
      }
      if (command instanceof HeadObjectCommand) {
        if (command.input.Key === 'backup/new') throw notFound()
        if (command.input.Key === 'backup/denied') throw new Error('Access denied')
        return { ContentLength: 2, ETag: command.input.Key === 'backup/same' ? 'aa' : 'bb' }
      }
      if (command instanceof CopyObjectCommand) {
        copied.push(command.input.Key ?? '')
        return {}
      }
      throw new Error('Unexpected request')
    }
    const sync = job(send)
    await sync.run()
    expect(copied.sort()).toEqual(['backup/changed', 'backup/new'])
    expect(sync.snapshot()).toMatchObject({
      phase: 'done',
      plan: { new: 1, update: 1, same: 1 },
      done: { copied: 2, failed: 1 },
      errors: [{ key: 'denied', message: 'Access denied' }]
    })
    copied.splice(0)
    const sizeOnly = job(send, { ...base, compare: 'size' })
    await sizeOnly.run()
    expect(copied).toEqual(['backup/new'])
    copied.splice(0)
    const preview = job(send, { ...base, dryRun: true })
    await preview.run()
    expect(copied).toEqual([])
    expect(preview.snapshot().phase).toBe('error')
    expect(preview.snapshot().error).toContain('preview again')
  })

  it('Stop aborts in-flight destination checks and starts no copies', async () => {
    const send = vi.fn(
      (command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> => {
        if (command instanceof HeadBucketCommand) return Promise.resolve({})
        if (command instanceof ListObjectsV2Command)
          return Promise.resolve({ Contents: [{ Key: 'data/a', Size: 1 }] })
        if (command instanceof HeadObjectCommand)
          return new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener('abort', () => {
              reject(new Error('Aborted'))
            })
          })
        return Promise.reject(new Error('Copy must not start'))
      }
    )
    const sync = job(send)
    const finished = sync.run()
    await vi.waitFor(() => {
      expect(send.mock.calls.some(([command]) => command instanceof HeadObjectCommand)).toBe(true)
    })
    expect(sync.snapshot()).toMatchObject({ phase: 'copying', listing: true })
    sync.stop()
    await finished
    expect(sync.snapshot()).toMatchObject({ phase: 'stopped', done: { copied: 0, failed: 0 } })
    expect(send.mock.calls.some(([command]) => command instanceof CopyObjectCommand)).toBe(false)
  })

  it('reports partial copies when a later source page is invalid', async () => {
    let copied = 0
    const sync = job((command: unknown): Promise<unknown> => {
      if (command instanceof HeadBucketCommand) return Promise.resolve({})
      if (command instanceof ListObjectsV2Command)
        return Promise.resolve({
          Contents: [{ Key: command.input.ContinuationToken ? 'data/b' : 'data/a', Size: 1 }],
          IsTruncated: true,
          NextContinuationToken: 'same-token'
        })
      if (command instanceof HeadObjectCommand) return Promise.reject(notFound())
      if (command instanceof CopyObjectCommand) {
        copied++
        return Promise.resolve({})
      }
      return Promise.reject(new Error('Unexpected request'))
    })
    await sync.run()
    expect(copied).toBe(1)
    expect(sync.snapshot()).toMatchObject({ phase: 'error', listing: true, done: { copied: 1 } })
    expect(sync.snapshot().error).toContain('completed copies are kept')
  })
})
