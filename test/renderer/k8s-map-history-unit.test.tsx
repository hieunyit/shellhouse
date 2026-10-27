// @vitest-environment jsdom
import './ds-dom'
import { cleanup, render, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { MapData } from '../../src/modules/k8s/shared/map'
import { useTrafficUnit } from '../../src/modules/k8s/renderer/trafficUnit'

vi.mock('../../src/modules/registry/renderer-kit', async () => ({
  ...(await import('../../src/shared/i18n')),
  ...(await import('../../src/shared/i18n/format'))
}))
vi.mock('../../src/modules/k8s/renderer/TrafficMap', () => ({
  TrafficMap: () => <div data-testid="rendered-unit">{useTrafficUnit()}</div>
}))
vi.mock('../../src/modules/k8s/renderer/topology/TopologyMap', () => ({ TopologyMap: () => null }))
vi.mock('../../src/modules/k8s/renderer/useTraffic', () => ({
  useTraffic: () => ({ status: 'off', rates: [], history: [], agents: 0, updated: 0 })
}))
vi.mock('../../src/modules/k8s/renderer/useTrafficHistory', () => ({
  useHistoryProbe: () => null,
  useTrafficRange: (_request: unknown, window: string) =>
    window === 'live'
      ? null
      : {
          status: 'live',
          unit: 'syns',
          source: 'hubble',
          rates: [],
          history: [],
          agents: 0,
          updated: 1,
          historic: true
        },
  TrafficWindowPicker: ({ onChange }: { onChange: (value: '1h') => void }) => (
    <button
      type="button"
      onClick={() => {
        onChange('1h')
      }}
    >
      1 hour
    </button>
  )
}))
import { MapView } from '../../src/modules/k8s/renderer/MapView'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})
it('renders Hubble history with its own SYN unit while live polling is off', async () => {
  window.localStorage.setItem(
    'shellhouse.k8s.map',
    JSON.stringify({ view: 'traffic', topologyDefault: true })
  )
  const data: MapData = {
    namespaces: [],
    workloads: [],
    pods: [],
    services: [],
    routes: [],
    pvcs: [],
    hpas: [],
    policies: [],
    nodes: { total: 0, ready: 0 },
    truncated: false
  }
  const request = <T,>(): Promise<T> => Promise.resolve(data as T)
  const view = render(
    <MapView
      tabId="test"
      request={request}
      namespaces={[]}
      active
      onOpen={() => undefined}
      onLogs={() => undefined}
    />
  )
  expect((await view.findByTestId('rendered-unit')).textContent).toBe('bytes')
  fireEvent.click(view.getByRole('button', { name: '1 hour' }))
  expect(view.getByTestId('rendered-unit').textContent).toBe('syns')
})
