// @vitest-environment jsdom
import './ds-dom'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTraffic } from '../../src/modules/k8s/renderer/useTraffic'
import type { TrafficSample } from '../../src/modules/k8s/shared/traffic'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
it('requires a new baseline after a failed poll instead of averaging across an unobserved gap', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  let count = 0
  const request = <T,>(): Promise<T> => {
    count++
    if (count === 3) return Promise.reject(new Error('network down'))
    const bytes = count === 1 ? 0 : count === 2 ? 20 : count === 4 ? 1000 : 1020
    const sample: TrafficSample = {
      status: 'ok',
      at: Date.now(),
      agents: 1,
      links: [
        {
          client: { ns: 'shop', name: 'web', kind: 'Deployment' },
          server: { ns: '', name: 'example.com', kind: 'external' },
          port: '443',
          bytes
        }
      ]
    }
    return Promise.resolve(sample as T)
  }
  const { result } = renderHook(() => useTraffic(request, true))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(result.current.status).toBe('live')
  expect(result.current.rates[0]?.rate).toBe(10)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(result.current.status).toBe('unavailable')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(result.current.status).toBe('connecting')
  expect(result.current.rates).toEqual([])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(result.current.status).toBe('live')
  expect(result.current.rates[0]?.rate).toBe(10)
})
