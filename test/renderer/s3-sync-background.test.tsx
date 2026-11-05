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

const waiting = (round = 1): S3SyncProgress => ({
  ...copying(),
  phase: 'waiting',
  continuous: {
    intervalSeconds: 300,
    round,
    completedRounds: round,
    nextRunAt: Date.now() + 300000,
    totals: { copied: round * 1001, deleted: 0, bytes: round * 1001, failed: 0 }
  }
})

it('keeps one continuous operation active across hidden waiting rounds and stops from Transfers', async () => {
  vi.useFakeTimers()
  let view: ReturnType<typeof render> | undefined
  try {
    let progress = waiting()
    const run = vi.fn((op: S3Op) => {
      if (op.op === 'syncStart') return Promise.resolve('continuous-1')
      if (op.op === 'syncStop') progress = { ...progress, phase: 'stopped' }
      return Promise.resolve(progress)
    })
    const onProgress = vi.fn<Parameters<typeof SyncDialog>[0]['onProgress']>()
    const props = {
      accountId: 'a',
      accounts: [],
      buckets: [{ name: 'dst', region: null, createdAt: null }],
      source: { bucket: 'src', prefix: '' },
      run,
      onClose: vi.fn(),
      onFinished: vi.fn(),
      onBackground: vi.fn(),
      onProgress
    }
    view = render(<SyncDialog {...props} />)
    fireEvent.change(view.getByTestId('s3-sync-bucket'), { target: { value: 'dst' } })
    fireEvent.click(view.getByTestId('s3-sync-continuous'))
    expect(view.getByTestId('s3-sync-interval')).toHaveProperty('value', '300')
    await act(async () => {
      fireEvent.click(view?.getByTestId('s3-sync-start') as HTMLElement)
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'syncStart', intervalSeconds: 300 })
    )
    expect(view.getByTestId('s3-sync-progress').dataset.phase).toBe('waiting')
    expect(view.getByTestId('s3-sync-continuous-status').textContent).toContain('Next check at')
    expect(props.onFinished).toHaveBeenCalledOnce()
    fireEvent.click(view.getByTestId('s3-sync-background'))
    view.rerender(<SyncDialog {...props} hidden />)
    progress = waiting(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const operation = onProgress.mock.calls[0]?.[2]
    expect(onProgress.mock.lastCall?.[2]).toBe(operation)
    expect(onProgress.mock.lastCall?.[0].phase).toBe('waiting')
    expect(props.onFinished).toHaveBeenCalledTimes(2)
    expect(run.mock.calls.filter(([op]) => op.op === 'syncStart')).toHaveLength(1)
    await act(async () => {
      operation?.stop()
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(run).toHaveBeenCalledWith({ op: 'syncStop', id: 'continuous-1' })
    expect(onProgress.mock.lastCall?.[0].phase).toBe('stopped')
    const polls = run.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300000)
    })
    expect(run).toHaveBeenCalledTimes(polls)
    view.rerender(<SyncDialog {...props} />)
    expect(view.getByTestId('s3-sync-progress').dataset.phase).toBe('stopped')
  } finally {
    view?.unmount()
    vi.useRealTimers()
  }
})

it('can start continuous mirror sync after an unchanged preview and stops on unmount while waiting', async () => {
  vi.useFakeTimers()
  let view: ReturnType<typeof render> | undefined
  try {
    let dryRun = true
    const run = vi.fn((op: S3Op) => {
      if (op.op === 'syncStart') {
        dryRun = op.dryRun
        return Promise.resolve('sync-1')
      }
      return Promise.resolve(
        dryRun
          ? {
              ...copying(),
              dryRun: true,
              phase: 'planned',
              plan: { new: 0, update: 0, delete: 0, same: 1, bytes: 0 }
            }
          : { ...waiting(), error: 'Connection refused' }
      )
    })
    view = render(
      <SyncDialog
        accountId="a"
        accounts={[]}
        buckets={[{ name: 'dst', region: null, createdAt: null }]}
        source={{ bucket: 'src', prefix: '' }}
        run={run}
        onClose={vi.fn()}
        onFinished={vi.fn()}
        onBackground={vi.fn()}
        onProgress={vi.fn()}
      />
    )
    fireEvent.change(view.getByTestId('s3-sync-bucket'), { target: { value: 'dst' } })
    fireEvent.click(view.getByTestId('s3-sync-continuous'))
    fireEvent.change(view.getByTestId('s3-sync-interval'), { target: { value: '30' } })
    fireEvent.click(view.getByTestId('s3-sync-mode-mirror'))
    await act(async () => {
      fireEvent.click(view?.getByTestId('s3-sync-preview') as HTMLElement)
      await vi.advanceTimersByTimeAsync(100)
    })
    const preview = run.mock.calls.find(([op]) => op.op === 'syncStart')?.[0]
    expect(preview).toHaveProperty('dryRun', true)
    expect(preview).not.toHaveProperty('intervalSeconds')
    expect(view.getByTestId('s3-sync-run')).toHaveProperty('disabled', false)
    expect(view.getByTestId('s3-sync-run').textContent).toContain('Start continuous sync')
    await act(async () => {
      fireEvent.click(view?.getByTestId('s3-sync-run') as HTMLElement)
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'syncStart',
        dryRun: false,
        mirror: true,
        maxDelete: 0,
        intervalSeconds: 30
      })
    )
    expect(view.getByText('Connection refused')).toBeDefined()
    expect(view.getByText(/It will retry after the pause/)).toBeDefined()
    view.unmount()
    expect(run).toHaveBeenCalledWith({ op: 'syncStop', id: 'sync-1' })
  } finally {
    view?.unmount()
    vi.useRealTimers()
  }
})
