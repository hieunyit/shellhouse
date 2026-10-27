// @vitest-environment jsdom
import './ds-dom'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { S3Op } from '../../src/modules/s3/shared/ops'
vi.mock('../../src/modules/registry/renderer-kit', () => ({
  formatNumber: (n: number) => String(n),
  t: (text: string) => text,
  tn: (_n: number, text: string) => text
}))
import { useBulkJobs } from '../../src/modules/s3/renderer/S3Jobs'
it('không gửi jobPoll của phiên cũ tới phiên S3 mới', async () => {
  vi.useFakeTimers()
  try {
    const run = vi.fn((op: S3Op): Promise<unknown> =>
      Promise.resolve(op.op === 'jobStart' ? 'old-id' : null)
    )
    const finished = vi.fn()
    const view = renderHook(({ connection }) => useBulkJobs(run, finished, connection), {
      initialProps: { connection: 0 }
    })
    let pending = Promise.resolve()
    await act(async () => {
      pending = view.result.current.start(
        { kind: 'delete', bucket: 'demo', keys: ['logs/'] },
        'Deleting logs',
        'deleted'
      )
      await Promise.resolve()
    })
    expect(view.result.current.jobs).toHaveLength(1)
    view.rerender({ connection: 1 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
      await pending
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({
      op: 'jobStart',
      job: { kind: 'delete', bucket: 'demo', keys: ['logs/'] }
    })
    expect(finished).not.toHaveBeenCalled()
    expect(view.result.current.jobs).toHaveLength(0)
    view.unmount()
  } finally {
    vi.useRealTimers()
  }
})
