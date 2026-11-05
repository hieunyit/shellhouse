import { t } from '@shared/i18n'
import {
  parentPrefix,
  type S3BulkJob,
  type S3JobProgress,
  type S3SyncProgress
} from '../shared/ops'
import type { S3TaskRecord } from '../shared/task-history'

interface Identity {
  id: string
  accountId: string
  accountName: string
  startedAt: number
}

/** Created by a user action, once for each execution (preview and run have different IDs). */
export function newTaskRun(): { id: string; startedAt: number } {
  return { id: crypto.randomUUID(), startedAt: Date.now() }
}

function state(phase: string | undefined, failed: number): S3TaskRecord['state'] {
  if (phase === 'stopped') return 'cancelled'
  if (phase === 'error' || (phase === 'done' && failed > 0)) return 'error'
  return phase === 'done' ? 'done' : 'running'
}

export function bulkTask(
  identity: Identity,
  job: S3BulkJob,
  label: string,
  progress: S3JobProgress | null
): S3TaskRecord {
  const key =
    job.kind === 'rename'
      ? job.key
      : job.keys.length === 1
        ? (job.keys[0] ?? '')
        : parentPrefix(job.keys[0] ?? '')
  const kind = job.kind === 'copy' ? (job.move ? 'move' : 'copy') : job.kind
  const status = state(progress?.phase, progress?.failed ?? 0)
  const knownTotal =
    job.kind === 'rename'
      ? job.key.endsWith('/')
        ? null
        : 1
      : job.keys.every((item) => item !== '' && !item.endsWith('/'))
        ? job.keys.length
        : null
  const destination =
    job.kind === 'copy'
      ? `s3://${job.destBucket}/${job.destPrefix}`
      : job.kind === 'rename'
        ? `s3://${job.bucket}/${parentPrefix(job.key)}${job.name}`
        : ''
  return {
    ...identity,
    kind,
    label,
    source: `s3://${job.bucket}/${key}`,
    destination,
    state: status,
    completed: progress?.done ?? 0,
    total: knownTotal ?? (progress && !progress.scanning ? progress.found : null),
    failed: progress?.failed ?? 0,
    ...(progress?.checking ? { checking: progress.checking } : {}),
    error:
      progress?.error ||
      progress?.errors
        .slice(0, 3)
        .map((e) => `${e.key}: ${e.message}`)
        .join('; ') ||
      null,
    finishedAt: status === 'running' ? null : Date.now()
  }
}

export function syncTask(
  identity: Identity,
  source: string,
  destination: string,
  progress: S3SyncProgress
): S3TaskRecord {
  const status = state(progress.phase, progress.done.failed)
  const done = progress.continuous?.totals ?? progress.done
  return {
    ...identity,
    kind: 'sync',
    label: progress.continuous
      ? progress.phase === 'waiting'
        ? t('Continuous sync · waiting')
        : t('Continuous sync')
      : t('Sync'),
    source,
    destination,
    state: status,
    completed: done.copied + done.deleted,
    total:
      progress.continuous || progress.phase === 'scanning'
        ? null
        : progress.plan.new + progress.plan.update + progress.plan.delete,
    failed: done.failed,
    error:
      progress.error ||
      progress.errors
        .slice(0, 3)
        .map((e) => `${e.key}: ${e.message}`)
        .join('; ') ||
      null,
    finishedAt: status === 'running' ? null : Date.now()
  }
}
