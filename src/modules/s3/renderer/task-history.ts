import { t } from '@shared/i18n'
import type { TransferStatus } from '@shared/sftp'
import { publishTransfers, removeTransferSource } from '../../registry/renderer-kit'
import { MAX_S3_TASK_HISTORY, type S3TaskRecord } from '../shared/task-history'
import { s3Api } from './api'

interface Controls {
  tabId: string
  cancel: () => void
  reveal: () => void
}

const records = new Map<string, S3TaskRecord>()
const controls = new Map<string, Controls>()
const pending = new Map<string, S3TaskRecord>()
const sourceId = 's3:operations'
let enabled = false
let generation = 0
let warning: string | undefined
let writes = Promise.resolve()
let restoring: Set<string> | null = null

export function taskTransfer(record: S3TaskRecord): TransferStatus {
  return {
    id: record.id,
    direction: 'upload',
    localPath: record.source,
    remotePath: record.destination,
    size: 0,
    transferred: 0,
    resumedFrom: 0,
    state: record.state,
    error: record.error,
    bytesPerSecond: 0,
    operation: record
  }
}

function publish(): void {
  if (!enabled) return
  publishTransfers({
    id: sourceId,
    label: t('S3 operations'),
    kind: 's3',
    transfers: [...records.values()].sort((a, b) => b.startedAt - a.startedAt).map(taskTransfer),
    cancel: (id) => {
      controls.get(id)?.cancel()
    },
    clear: () => {
      taskHistory.remove(
        [...records.values()].filter((r) => r.state !== 'running').map((r) => r.id)
      )
    },
    discard: (id) => {
      taskHistory.remove([id])
    },
    revealTransfer: (id) => {
      controls.get(id)?.reveal()
    },
    canRevealTransfer: (id) => controls.has(id),
    warning
  })
}

function enqueue(work: () => Promise<void>): void {
  writes = writes.then(work).catch((error: unknown) => {
    warning = t('Could not save S3 task history: {error}', {
      error: error instanceof Error ? error.message : String(error)
    })
    publish()
  })
}

function save(record: S3TaskRecord): void {
  pending.set(record.id, record)
  if (!enabled) return
  enqueue(async () => {
    // Clear/remove may have been requested while a previous write was in flight.
    if (pending.get(record.id) !== record) return
    await s3Api.saveTask(record)
    if (pending.get(record.id) === record) pending.delete(record.id)
    if (!pending.size) warning = undefined
    publish()
  })
}

export const taskHistory = {
  update(record: S3TaskRecord, actions: Controls): void {
    if (records.get(record.id)?.state !== undefined && records.get(record.id)?.state !== 'running')
      return
    restoring?.add(record.id)
    const safe = { ...record, error: record.error?.slice(0, 16 * 1024) ?? null }
    records.set(record.id, safe)
    controls.set(record.id, actions)
    if (record.state !== 'running') save(safe)
    const finished = [...records.values()]
      .filter((r) => r.state !== 'running')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    for (const old of finished.slice(MAX_S3_TASK_HISTORY)) {
      records.delete(old.id)
      controls.delete(old.id)
      pending.delete(old.id)
    }
    publish()
  },

  remove(ids: string[]): void {
    const finished = ids.filter((id) => records.get(id)?.state !== 'running')
    for (const id of finished) {
      restoring?.add(id)
      records.delete(id)
      controls.delete(id)
      pending.delete(id)
    }
    if (finished.length) enqueue(() => s3Api.removeTasks(finished))
    publish()
  },

  detach(tabId: string): void {
    for (const [id, actions] of controls) {
      if (actions.tabId !== tabId) continue
      const record = records.get(id)
      if (record?.state === 'running') {
        restoring?.add(id)
        const stopped: S3TaskRecord = {
          ...record,
          state: 'cancelled',
          finishedAt: Date.now(),
          error: t('The S3 connection closed before the operation finished')
        }
        records.set(id, stopped)
        save(stopped)
      }
      controls.delete(id)
    }
    publish()
  },

  start(): () => void {
    enabled = true
    const current = ++generation
    const changes = new Set<string>()
    restoring = changes
    for (const record of pending.values()) save(record)
    publish()
    void writes
      .then(() => s3Api.taskHistory())
      .then(
        (history) => {
          if (!enabled || current !== generation) return
          const stored = new Set(history.map((r) => r.id))
          for (const [id, record] of records)
            if (
              !changes.has(id) &&
              record.state !== 'running' &&
              !pending.has(id) &&
              !stored.has(id)
            )
              records.delete(id)
          for (const record of history)
            if (!changes.has(record.id) && !records.has(record.id)) records.set(record.id, record)
          restoring = null
          if (!pending.size) warning = undefined
          publish()
        },
        (error: unknown) => {
          if (!enabled || current !== generation) return
          warning = t('Could not load S3 task history: {error}', {
            error: error instanceof Error ? error.message : String(error)
          })
          publish()
        }
      )
    return () => {
      if (current !== generation) return
      enabled = false
      restoring = null
      removeTransferSource(sourceId)
    }
  }
}
