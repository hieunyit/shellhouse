import { describe, expect, it, vi } from 'vitest'
import type { S3TaskRecord } from '../../src/modules/s3/shared/task-history'
import { taskHistory } from '../../src/modules/s3/renderer/task-history'
import { useTransfers, transferSummary } from '../../src/renderer/src/stores/transfers'
import { s3Api } from '../../src/modules/s3/renderer/api'

const saved = vi.hoisted(() => new Map<string, S3TaskRecord>())
vi.mock('../../src/modules/registry/renderer-kit', async () => {
  const { useTransfers: store } = await import('../../src/renderer/src/stores/transfers')
  return {
    publishTransfers: (source: Parameters<ReturnType<typeof store.getState>['publish']>[0]) => {
      store.getState().publish(source)
    },
    removeTransferSource: (id: string) => {
      store.getState().remove(id)
    }
  }
})
vi.mock('../../src/modules/s3/renderer/api', () => ({
  s3Api: {
    taskHistory: vi.fn(() => Promise.resolve([...saved.values()])),
    saveTask: vi.fn((record: S3TaskRecord) => {
      saved.set(record.id, structuredClone(record))
      return Promise.resolve()
    }),
    removeTasks: vi.fn((ids: string[]) => {
      for (const id of ids) saved.delete(id)
      return Promise.resolve()
    })
  }
}))

describe('S3 task publication and history', () => {
  it('publishes live object counts, retains completed/stopped history after tab close, clears and retries failed persistence', async () => {
    let stop = taskHistory.start()
    const cancel = vi.fn()
    const reveal = vi.fn()
    const actions = { tabId: 'tab', cancel, reveal }
    const running: S3TaskRecord = {
      id: 'copy',
      accountId: 'account',
      accountName: 'MinIO',
      kind: 'copy',
      label: 'Copy 5,000 files',
      source: 's3://source/',
      destination: 's3://destination/',
      state: 'running',
      completed: 1234,
      total: 5000,
      failed: 0,
      error: null,
      startedAt: 100,
      finishedAt: null
    }
    const source = () => useTransfers.getState().sources['s3:operations']
    taskHistory.update(running, actions)
    expect(source()?.transfers[0]).toMatchObject({
      state: 'running',
      size: 0,
      operation: { completed: 1234, total: 5000 }
    })
    expect(transferSummary(useTransfers.getState().sources)).toMatchObject({
      active: 1,
      progress: null
    })
    source()?.cancel('copy')
    source()?.revealTransfer?.('copy')
    expect(cancel).toHaveBeenCalledOnce()
    expect(reveal).toHaveBeenCalledOnce()
    taskHistory.update({ ...running, state: 'done', completed: 5000, finishedAt: 200 }, actions)
    await vi.waitFor(() => {
      expect(saved.get('copy')?.state).toBe('done')
    })
    taskHistory.detach('tab')
    expect(source()?.transfers[0]?.state).toBe('done')
    expect(source()?.canRevealTransfer?.('copy')).toBe(false)
    expect(transferSummary(useTransfers.getState().sources).active).toBe(0)

    taskHistory.update({ ...running, id: 'stopped' }, actions)
    taskHistory.detach('tab')
    await vi.waitFor(() => {
      expect(saved.get('stopped')).toMatchObject({ state: 'cancelled', completed: 1234 })
    })
    stop()
    expect(source()).toBeUndefined()
    stop = taskHistory.start()
    await vi.waitFor(() => {
      expect(source()?.transfers).toHaveLength(2)
    })
    source()?.clear()
    await vi.waitFor(() => {
      expect(saved.size).toBe(0)
    })
    expect(source()).toBeUndefined()

    vi.mocked(s3Api.saveTask).mockRejectedValueOnce(new Error('disk offline'))
    taskHistory.update(
      { ...running, id: 'retry-save', state: 'error', failed: 1, error: 'Denied', finishedAt: 300 },
      actions
    )
    await vi.waitFor(() => {
      expect(source()?.warning).toContain('disk offline')
    })
    taskHistory.update(
      { ...running, id: 'later-save', state: 'done', completed: 5000, finishedAt: 400 },
      actions
    )
    await vi.waitFor(() => {
      expect(saved.has('later-save')).toBe(true)
    })
    expect(source()?.warning).toContain('disk offline')
    stop()
    stop = taskHistory.start()
    await vi.waitFor(() => {
      expect(saved.get('retry-save')?.error).toBe('Denied')
    })
    await vi.waitFor(() => {
      expect(source()?.warning).toBeUndefined()
    })
    expect(source()?.transfers[0]?.state).toBe('error')
    source()?.clear()
    await vi.waitFor(() => {
      expect(saved.size).toBe(0)
    })
    stop()
  })
})
