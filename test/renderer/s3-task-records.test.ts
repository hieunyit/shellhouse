import { describe, expect, it } from 'vitest'
import { bulkTask, syncTask } from '../../src/modules/s3/renderer/task-records'
import type { S3BulkJob, S3JobProgress, S3SyncProgress } from '../../src/modules/s3/shared/ops'

const identity = { id: 'task', accountId: 'account', accountName: 'MinIO', startedAt: 100 }
const files: S3BulkJob = {
  kind: 'copy',
  bucket: 'source',
  keys: Array.from({ length: 5000 }, (_, i) => `data/f${i}`),
  destBucket: 'destination',
  destPrefix: 'backup/',
  move: true,
  overwrite: false
}
const progress: S3JobProgress = {
  phase: 'running',
  found: 0,
  done: 0,
  failed: 0,
  scanning: true,
  errors: [],
  error: null,
  checking: { done: 123, total: 5000 }
}

describe('S3 operation history records', () => {
  it('preserves known totals during preflight and partial progress after stop or object failures', () => {
    expect(bulkTask(identity, files, 'Move 5,000 files', progress)).toMatchObject({
      kind: 'move',
      state: 'running',
      completed: 0,
      total: 5000,
      checking: { done: 123 },
      source: 's3://source/data/',
      destination: 's3://destination/backup/',
      finishedAt: null
    })
    expect(
      bulkTask(identity, files, 'Move', {
        ...progress,
        phase: 'stopped',
        done: 1200,
        scanning: false
      })
    ).toMatchObject({ state: 'cancelled', completed: 1200, total: 5000 })
    expect(
      bulkTask(identity, files, 'Move', {
        ...progress,
        phase: 'done',
        done: 4999,
        failed: 1,
        errors: [{ key: 'data/f4', message: 'Denied' }]
      })
    ).toMatchObject({
      state: 'error',
      completed: 4999,
      total: 5000,
      failed: 1,
      error: 'data/f4: Denied'
    })
    expect(bulkTask(identity, { ...files, keys: ['data/'] }, 'Move', progress).total).toBeNull()
  })

  it('records sync copies and deletions by object count and retains partial errors', () => {
    const p: S3SyncProgress = {
      phase: 'copying',
      dryRun: false,
      serverSide: true,
      scanned: { source: 20, dest: 30 },
      plan: { new: 3, update: 2, delete: 7, same: 10, bytes: 10000 },
      done: { copied: 2, deleted: 1, bytes: 7000, failed: 0 },
      bytesPerSecond: 500,
      concurrency: 16,
      active: [],
      sample: [],
      errors: [],
      error: null
    }
    expect(syncTask(identity, 's3://source/', 's3://destination/', p)).toMatchObject({
      kind: 'sync',
      state: 'running',
      completed: 3,
      total: 12,
      finishedAt: null
    })
    expect(
      syncTask(identity, 's3://source/', 's3://destination/', {
        ...p,
        phase: 'error',
        error: 'Connection closed'
      })
    ).toMatchObject({ state: 'error', completed: 3, total: 12, error: 'Connection closed' })
    expect(
      syncTask(identity, 's3://source/', 's3://destination/', { ...p, phase: 'scanning' }).total
    ).toBeNull()
    expect(
      syncTask(identity, 's3://source/', 's3://destination/', {
        ...p,
        strategy: 'lookup',
        listing: true
      })
    ).toMatchObject({ state: 'running', completed: 3, total: null })
    expect(
      syncTask(identity, 's3://source/', 's3://destination/', {
        ...p,
        strategy: 'lookup',
        listing: true,
        phase: 'stopped'
      })
    ).toMatchObject({ state: 'cancelled', completed: 3, total: null })
    const continuous: S3SyncProgress = {
      ...p,
      phase: 'waiting',
      continuous: {
        round: 2,
        completedRounds: 2,
        intervalSeconds: 300,
        nextRunAt: 12345,
        totals: { copied: 100, deleted: 20, bytes: 10000, failed: 2 }
      }
    }
    expect(syncTask(identity, 's3://source/', 's3://destination/', continuous)).toMatchObject({
      label: 'Continuous sync · waiting',
      state: 'running',
      completed: 120,
      total: null,
      failed: 2,
      finishedAt: null
    })
    expect(
      syncTask(identity, 's3://source/', 's3://destination/', { ...continuous, phase: 'stopped' })
    ).toMatchObject({ state: 'cancelled', completed: 120, total: null })
  })
})
