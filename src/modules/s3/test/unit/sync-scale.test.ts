import { existsSync } from 'node:fs'
import { HeadBucketCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { SyncJob } from '../../session-host/sync'
import { MAX_SYNC_OBJECTS, SYNC_PAGE_SIZE, SyncIndex } from '../../session-host/sync-index'

describe('S3 disk-backed sync', () => {
  it('fails closed before copying or deleting when a truncated listing omits its continuation token', async () => {
    const client = {
      send: (command: unknown): Promise<unknown> => {
        if (command instanceof HeadBucketCommand) return Promise.resolve({})
        if (command instanceof ListObjectsV2Command)
          return Promise.resolve({
            Contents: [{ Key: 'file', Size: 1 }],
            IsTruncated: true
          })
        return Promise.reject(new Error('A mutation must not be issued'))
      }
    } as unknown as S3Client
    const job = new SyncJob(
      { source: client, dest: client, destRegion: 'us-east-1', serverSide: true, concurrency: 4 },
      {
        op: 'syncStart',
        bucket: 'src',
        prefix: '',
        dest: { bucket: 'dst', prefix: '' },
        mirror: true,
        compare: 'size',
        createBucket: false,
        dryRun: false,
        maxDelete: 1
      }
    )
    await job.run()
    expect(job.snapshot()).toMatchObject({
      phase: 'error',
      done: { copied: 0, deleted: 0, failed: 0 }
    })
    expect(job.snapshot().error).toContain('listing did not advance')
  })

  it('indexes bounded pages, deduplicates listings, preserves prefix markers and removes temporary files', () => {
    const index = new SyncIndex()
    const dir = index.directory
    try {
      index.add('source', 'src/', [
        { Key: 'src/', Size: 0 },
        { Key: 'src/a', Size: 2, ETag: 'aa' }
      ])
      index.add('source', 'src/', [{ Key: 'src/a', Size: 2, ETag: 'aa' }])
      index.add('dest', 'dst/', [
        { Key: 'dst/a', Size: 3 },
        { Key: 'dst/z', Size: 4 }
      ])
      expect(index.counts).toEqual({ source: 2, dest: 2 })
      expect(index.objects('source', null).map((r) => [r.rel, r.present])).toEqual([
        ['', null],
        ['a', 1]
      ])
      expect(index.objects('source', '').map((r) => r.rel)).toEqual(['a'])
      index.addPlan([
        { rel: '', action: 'new', size: 0 },
        { rel: 'a', action: 'update', size: 2 }
      ])
      expect(index.plan(null).map((r) => r.rel)).toEqual(['', 'a'])
      expect(index.plan('').map((r) => r.rel)).toEqual(['a'])
    } finally {
      index.close()
    }
    expect(existsSync(dir)).toBe(false)
  })

  it('accepts exactly 100M objects and rejects the next distinct object', () => {
    const index = new SyncIndex()
    try {
      index.counts.source = MAX_SYNC_OBJECTS - 1
      index.add('source', '', [{ Key: 'last' }])
      expect(index.counts.source).toBe(100_000_000)
      expect(() => {
        index.add('source', '', [{ Key: 'overflow' }])
      }).toThrow('100,000,000')
      expect(index.counts.source).toBe(MAX_SYNC_OBJECTS)
    } finally {
      index.close()
    }
  })

  it(
    'previews more than the old 1M limit without retaining the full inventory or plan in RAM',
    { timeout: 120_000 },
    async () => {
      const total = Number(process.env['S3_SCALE_OBJECTS'] ?? 1_000_001)
      let pages = 0
      const client = {
        send: async (command: unknown) => {
          await Promise.resolve()
          if (command instanceof HeadBucketCommand) return {}
          if (command instanceof ListObjectsV2Command) {
            const start = Number(command.input.ContinuationToken ?? 0)
            const count =
              command.input.Bucket === 'source' ? Math.min(SYNC_PAGE_SIZE, total - start) : 0
            pages++
            return {
              Contents: Array.from({ length: count }, (_, i) => ({
                Key: `key-${String(start + i).padStart(9, '0')}`,
                Size: 2
              })),
              IsTruncated: start + count < total && count > 0,
              NextContinuationToken: String(start + count)
            }
          }
          throw new Error('Unexpected request')
        }
      } as unknown as S3Client
      const close = vi.spyOn(SyncIndex.prototype, 'close')
      try {
        const job = new SyncJob(
          {
            source: client,
            dest: client,
            destRegion: 'us-east-1',
            serverSide: true,
            concurrency: 4
          },
          {
            op: 'syncStart',
            bucket: 'source',
            prefix: '',
            dest: { bucket: 'dest', prefix: '' },
            mirror: false,
            compare: 'etag',
            strategy: 'inventory',
            createBucket: false,
            dryRun: true
          }
        )
        await job.run()
        expect(job.snapshot()).toMatchObject({
          phase: 'planned',
          scanned: { source: total, dest: 0 },
          plan: { new: total, update: 0, delete: 0, same: 0, bytes: total * 2 }
        })
        expect(job.snapshot().sample).toHaveLength(300)
        expect(pages).toBe(Math.ceil(total / SYNC_PAGE_SIZE) + 1)
        expect(close).toHaveBeenCalledOnce()
        const index = close.mock.instances[0] as SyncIndex
        expect(existsSync(index.directory)).toBe(false)
      } finally {
        close.mockRestore()
      }
    }
  )
})
