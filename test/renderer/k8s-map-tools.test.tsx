// @vitest-environment jsdom
import './ds-dom'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MapData } from '../../src/modules/k8s/shared/map'
import type { K8sOp } from '../../src/modules/k8s/shared/ops'
import { SNAPSHOTS_KEY } from '../../src/modules/k8s/shared/topologySnapshots'

vi.mock('../../src/modules/registry/renderer-kit', async () => ({
  ...(await import('../../src/shared/i18n')),
  ...(await import('../../src/shared/i18n/format'))
}))
import { MapTools } from '../../src/modules/k8s/renderer/MapTools'

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function data(): MapData {
  return {
    scope: ['shop'],
    coverage: [],
    namespaces: [{ name: 'shop', active: true }],
    workloads: [
      {
        kind: 'deployments.apps',
        ns: 'shop',
        name: 'web',
        labels: { app: 'web' },
        images: ['nginx:1'],
        ready: 1,
        desired: 1,
        status: '1/1',
        tone: 'ok',
        pvcs: []
      }
    ],
    pods: [],
    services: [
      {
        ns: 'shop',
        name: 'web',
        selector: { app: 'web' },
        type: 'ClusterIP',
        ports: '80/TCP',
        portList: [{ port: 80, targetPort: 'http' }]
      }
    ],
    routes: [],
    pvcs: [],
    policies: [],
    hpas: [],
    nodes: { total: 0, ready: 0 },
    truncated: false
  }
}
const props = {
  cluster: 'cluster-a',
  namespaces: ['shop'],
  data: data(),
  onOpen: () => undefined,
  onClose: () => undefined
}

it('reads fresh data for diagnosis, shows evidence links and handles incomplete lists', async () => {
  const fresh = data()
  fresh.coverage = [{ kind: 'pods', namespace: 'shop', reason: 'forbidden' }]
  const calls: K8sOp[] = []
  const request = <T,>(op: K8sOp): Promise<T> => {
    calls.push(op)
    return Promise.resolve(fresh as T)
  }
  const onOpen = vi.fn()
  const view = render(<MapTools {...props} mode="diagnose" request={request} onOpen={onOpen} />)
  fireEvent.change(view.getByLabelText('Diagnostic target'), {
    target: { value: 'service:shop/web' }
  })
  fireEvent.click(view.getByRole('button', { name: 'Run diagnosis' }))
  const result = await view.findByTestId('k8s-map-diagnosis')
  expect(calls).toEqual([{ op: 'map', namespaces: ['shop'] }])
  expect(result.textContent).toContain('Pod data is incomplete')
  expect(result.textContent).toContain('Network reachability · Unknown')
  fireEvent.click(view.getAllByRole('button', { name: 'web' })[0] as HTMLElement)
  expect(onOpen).toHaveBeenCalledWith({ kind: 'services', ns: 'shop', name: 'web' })
})

it('saves a persistent baseline and compares it with a new read after deployment', async () => {
  const d = data()
  const request = <T,>(): Promise<T> => Promise.resolve(structuredClone(d) as T)
  const view = render(<MapTools {...props} mode="snapshots" request={request} />)
  fireEvent.change(view.getByLabelText('Snapshot name'), { target: { value: 'before release' } })
  fireEvent.click(view.getByRole('button', { name: 'Save baseline' }))
  await waitFor(() => {
    expect(window.localStorage.getItem(SNAPSHOTS_KEY)).toContain('before release')
  })
  expect((view.getByLabelText('Baseline') as HTMLSelectElement).value).not.toBe('')
  const w = d.workloads[0]
  if (!w) throw new Error('fixture')
  w.images = ['nginx:2']
  fireEvent.click(view.getByRole('button', { name: 'Compare with current' }))
  const diff = await view.findByTestId('k8s-map-comparison')
  expect(diff.textContent).toContain('images')
  expect(diff.textContent).toContain('nginx:1')
  expect(diff.textContent).toContain('nginx:2')
  view.unmount()
  const reopened = render(<MapTools {...props} mode="snapshots" request={request} />)
  expect(reopened.getByRole('option', { name: /before release/ })).toBeTruthy()
  reopened.unmount()
  const different = render(
    <MapTools {...props} cluster="cluster-b" mode="snapshots" request={request} />
  )
  expect(different.queryByRole('option', { name: /before release/ })).toBeNull()
})

it('does not save a pending snapshot after leaving its cluster', async () => {
  let complete: ((data: MapData) => void) | undefined
  const pending = new Promise<MapData>((resolve) => {
    complete = resolve
  })
  const request = <T,>(): Promise<T> => pending as Promise<T>
  const view = render(<MapTools {...props} mode="snapshots" request={request} />)
  fireEvent.click(view.getByRole('button', { name: 'Save baseline' }))
  view.unmount()
  await act(async () => {
    complete?.(data())
    await pending
  })
  expect(window.localStorage.getItem(SNAPSHOTS_KEY)).toBeNull()
})

it('shows storage failures without claiming that the baseline was saved', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota exceeded')
  })
  const request = <T,>(): Promise<T> => Promise.resolve(data() as T)
  const view = render(<MapTools {...props} mode="snapshots" request={request} />)
  fireEvent.click(view.getByRole('button', { name: 'Save baseline' }))
  expect((await view.findByRole('alert')).textContent).toContain('quota exceeded')
  expect((view.getByLabelText('Baseline') as HTMLSelectElement).value).toBe('')
})
