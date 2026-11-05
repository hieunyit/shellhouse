// @vitest-environment jsdom
import './ds-dom'
import { act, fireEvent, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { S3Op, S3SyncProgress } from '../../src/modules/s3/shared/ops'

vi.mock('../../src/modules/registry/renderer-kit', async () => ({
  ...(await import('../../src/shared/i18n')),
  ...(await import('../../src/shared/i18n/format')),
  confirmAction: () => Promise.resolve(true)
}))
import { SyncDialog } from '../../src/modules/s3/renderer/S3Sync'

const copying = (): S3SyncProgress => ({
  phase: 'copying',
  dryRun: false,
  serverSide: true,
  scanned: { source: 2000, dest: 0 },
  plan: { new: 2000, update: 0, same: 0, delete: 0, bytes: 2000 },
  done: { copied: 1001, deleted: 0, failed: 0, bytes: 1001 },
  active: [],
  sample: [],
  errors: [],
  error: null,
  bytesPerSecond: 0,
  concurrency: 4
})

it('keeps polling while minimized, reopens with progress and stops only when explicitly requested', async () => {
  vi.useFakeTimers()
  try {
    const run = vi.fn((op: S3Op) => Promise.resolve(op.op === 'syncStart' ? 'sync-1' : copying()))
    const onBackground = vi.fn()
    const onProgress = vi.fn<Parameters<typeof SyncDialog>[0]['onProgress']>()
    const props = {
      accountId: 'a',
      accounts: [],
      buckets: [{ name: 'dst', region: null, createdAt: null }],
      source: { bucket: 'src', prefix: '' },
      run,
      onClose: vi.fn(),
      onFinished: vi.fn(),
      onBackground,
      onProgress
    }
    const view = render(<SyncDialog {...props} />)
    fireEvent.change(view.getByTestId('s3-sync-bucket'), { target: { value: 'dst' } })
    await act(async () => {
      fireEvent.click(view.getByTestId('s3-sync-start'))
      await Promise.resolve()
    })
    fireEvent.click(view.getByTestId('s3-sync-background'))
    expect(onBackground).toHaveBeenCalledOnce()
    view.rerender(<SyncDialog {...props} hidden />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(view.queryByTestId('s3-sync-dialog')).toBeNull()
    expect(run).toHaveBeenCalledWith({ op: 'syncPoll', id: 'sync-1' })
    expect(run).not.toHaveBeenCalledWith({ op: 'syncStop', id: 'sync-1' })
    const operation = onProgress.mock.calls[0]?.[2]
    expect(operation?.id).toMatch(/^[\da-f-]{36}$/)
    expect(operation?.startedAt).toBeGreaterThan(0)
    expect(operation?.stop).toBeTypeOf('function')
    expect(onProgress).toHaveBeenCalledWith(copying(), 's3://dst/', operation)
    expect(onProgress.mock.lastCall?.[2]).toBe(operation)
    act(() => {
      operation?.stop()
    })
    expect(run).toHaveBeenCalledWith({ op: 'syncStop', id: 'sync-1' })
    view.rerender(<SyncDialog {...props} />)
    expect(view.getByTestId('s3-sync-done').textContent).toContain('1,001')
    fireEvent.click(view.getByTestId('s3-sync-stop'))
    expect(run).toHaveBeenCalledWith({ op: 'syncStop', id: 'sync-1' })
    view.unmount()
    const polls = run.mock.calls.filter(([op]) => op.op === 'syncPoll').length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(run.mock.calls.filter(([op]) => op.op === 'syncPoll')).toHaveLength(polls)
  } finally {
    vi.useRealTimers()
  }
})
