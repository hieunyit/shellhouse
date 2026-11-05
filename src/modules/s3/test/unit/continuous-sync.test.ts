import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client
} from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { S3Op } from '../../shared/ops'
import { SyncJob } from '../../session-host/sync'
import { SyncIndex } from '../../session-host/sync-index'

const pauses = vi.hoisted(() => [] as { ms: number; resume: () => void }[])
vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: (ms: number, _value: undefined, { signal }: { signal: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        reject(new Error('Aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
      pauses.push({
        ms,
        resume: () => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
      })
    })
}))

const base = {
  op: 'syncStart' as const,
  bucket: 'src',
  prefix: '',
  dest: { bucket: 'dst', prefix: '' },
  mirror: false,
  compare: 'etag' as const,
  createBucket: false,
  dryRun: false,
  intervalSeconds: 30
}
const jobs: { job: SyncJob; finished: Promise<void> }[] = []
afterEach(async () => {
  for (const { job } of jobs) job.stop()
  await Promise.all(jobs.splice(0).map(({ finished }) => finished))
  pauses.splice(0)
  vi.restoreAllMocks()
})

function setup(overrides: Partial<Extract<S3Op, { op: 'syncStart' }>> = {}) {
  const source = new Map([['a', 'v1']])
  const dest = new Map<string, string>()
  const send = vi.fn((command: unknown): Promise<unknown> => {
    if (command instanceof HeadBucketCommand) return Promise.resolve({})
    if (command instanceof ListObjectsV2Command) {
      const items = command.input.Bucket === 'src' ? source : dest
      return Promise.resolve({
        Contents: [...items].map(([Key, body]) => ({ Key, Size: body.length, ETag: body }))
      })
    }
    if (command instanceof HeadObjectCommand) {
      const body = dest.get(command.input.Key ?? '')
      return body === undefined
        ? Promise.reject(Object.assign(new Error('Missing'), { name: 'NotFound' }))
        : Promise.resolve({ ContentLength: body.length, ETag: body })
    }
    if (command instanceof CopyObjectCommand) {
      const key = command.input.Key ?? ''
      dest.set(key, source.get(key) ?? '')
      return Promise.resolve({})
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const { Key } of command.input.Delete?.Objects ?? []) dest.delete(Key ?? '')
      return Promise.resolve({})
    }
    return Promise.reject(new Error('Unexpected S3 request'))
  })
  const client = { send } as unknown as S3Client
  const job = new SyncJob(
    { source: client, dest: client, destRegion: 'us-east-1', serverSide: true, concurrency: 4 },
    { ...base, ...overrides }
  )
  return { job, source, dest, send }
}

function start(job: SyncJob): Promise<void> {
  const finished = job.run()
  jobs.push({ job, finished })
  return finished
}

async function waiting(job: SyncJob, round: number): Promise<void> {
  await vi.waitFor(() => {
    expect(job.snapshot()).toMatchObject({ phase: 'waiting', continuous: { round } })
    expect(pauses).toHaveLength(round)
  })
}

describe('continuous S3 sync in the Session Host', () => {
  it('repeats without polling, copies new/changed objects only, totals across rounds and avoids destination inventories while resting', async () => {
    const close = vi.spyOn(SyncIndex.prototype, 'close')
    const { job, source, dest, send } = setup()
    const finished = start(job)
    await waiting(job, 1)
    expect(job.finished).toBe(false)
    expect(job.snapshot()).toMatchObject({
      done: { copied: 1 },
      continuous: { completedRounds: 1, intervalSeconds: 30, totals: { copied: 1, bytes: 2 } }
    })
    expect(job.snapshot().continuous?.nextRunAt).toBeGreaterThan(Date.now())
    expect(pauses[0]?.ms).toBe(30000)
    const requests = send.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(send).toHaveBeenCalledTimes(requests)
    expect(close).not.toHaveBeenCalled()
    source.set('a', 'v2')
    source.set('b', 'new')
    pauses[0]?.resume()
    await waiting(job, 2)
    expect(dest).toEqual(source)
    expect(job.snapshot()).toMatchObject({
      plan: { new: 1, update: 1 },
      done: { copied: 2 },
      continuous: { completedRounds: 2, totals: { copied: 3, bytes: 7 } }
    })
    pauses[1]?.resume()
    await waiting(job, 3)
    expect(job.snapshot()).toMatchObject({
      plan: { new: 0, update: 0, same: 2 },
      done: { copied: 0 },
      continuous: { totals: { copied: 3 } }
    })
    expect(send.mock.calls.filter(([op]) => op instanceof CopyObjectCommand)).toHaveLength(3)
    expect(close).not.toHaveBeenCalled()
    job.stop()
    expect(job.snapshot()).toMatchObject({ phase: 'stopped', continuous: { nextRunAt: null } })
    await finished
    expect(job.finished).toBe(true)
    expect(pauses).toHaveLength(3)
  })

  it('waits for an active copy, never overlaps rounds and aborts the request on Stop', async () => {
    const { job, send } = setup()
    let copySignal: AbortSignal | undefined
    send.mockImplementation((command: unknown, ...args: unknown[]) => {
      if (command instanceof CopyObjectCommand) {
        const options = args[0] as { abortSignal: AbortSignal }
        copySignal = options.abortSignal
        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => {
            reject(new Error('Stopped'))
          })
        })
      }
      if (command instanceof HeadBucketCommand) return Promise.resolve({})
      return Promise.resolve({
        Contents:
          command instanceof ListObjectsV2Command && command.input.Bucket === 'src'
            ? [{ Key: 'a', Size: 1 }]
            : []
      })
    })
    const finished = start(job)
    await vi.waitFor(() => {
      expect(copySignal).toBeDefined()
    })
    expect(job.snapshot().phase).toBe('copying')
    expect(pauses).toHaveLength(0)
    job.stop()
    await finished
    expect(copySignal?.aborted).toBe(true)
    expect(job.snapshot().phase).toBe('stopped')
    expect(pauses).toHaveLength(0)
  })

  it('retains errors while resting, retries after the configured pause and recovers', async () => {
    const { job, send } = setup()
    send.mockRejectedValueOnce(new Error('MinIO unavailable'))
    const finished = start(job)
    await waiting(job, 1)
    expect(job.snapshot()).toMatchObject({ phase: 'waiting', error: 'MinIO unavailable' })
    pauses[0]?.resume()
    await waiting(job, 2)
    expect(job.snapshot()).toMatchObject({ error: null, continuous: { totals: { copied: 1 } } })
    job.stop()
    await finished
  })

  it('keeps the preview deletion cap on every mirror round', async () => {
    const { job, source, dest } = setup({ mirror: true, maxDelete: 0 })
    void start(job)
    await waiting(job, 1)
    source.clear()
    pauses[0]?.resume()
    await waiting(job, 2)
    expect(dest.get('a')).toBe('v1')
    expect(job.snapshot().error).toContain('preview again')
    expect(job.snapshot().done.deleted).toBe(0)
  })

  it('previews once even if an interval is supplied and validates allowed intervals at the API boundary', async () => {
    const { job } = setup({ dryRun: true })
    await start(job)
    expect(job.snapshot().phase).toBe('planned')
    expect(job.snapshot().continuous).toBeUndefined()
    expect(job.finished).toBe(true)
    expect(pauses).toHaveLength(0)
    for (const intervalSeconds of [0, 29, 30.5, 86401])
      expect(S3Op.safeParse({ ...base, intervalSeconds }).success).toBe(false)
    expect(S3Op.safeParse(base).success).toBe(true)
    expect(S3Op.safeParse({ ...base, intervalSeconds: 86400 }).success).toBe(true)
  })
})
