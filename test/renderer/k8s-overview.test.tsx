// @vitest-environment jsdom
import './ds-dom'
import { render, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { OverviewResult } from '../../src/modules/k8s/shared/ops'

vi.mock('../../src/modules/registry/renderer-kit', async () => ({
  ...(await import('../../src/shared/i18n')),
  ...(await import('../../src/shared/i18n/format'))
}))
import { ClusterOverview } from '../../src/modules/k8s/renderer/Overview'

function overview(): OverviewResult {
  const empty = { total: 0, items: [] }
  return {
    version: 'v1.37.0',
    nodes: { total: 1, ready: 1, cordoned: 0, known: true },
    capacity: { cpu: 1000, memory: 1024 },
    requests: { cpu: 10, memory: 10 },
    usage: null,
    pods: { running: 1, pending: 0, failed: 0, succeeded: 0, restarting: 0 },
    workloads: [
      { kind: 'Deployments', total: 0, ready: 0 },
      { kind: 'StatefulSets', total: 0, ready: 0 }
    ],
    warnings: [],
    problems: { nodes: empty, failing: empty, imagePull: empty, pending: empty, pvcs: empty }
  }
}
function show(data: OverviewResult) {
  const request = <T,>(): Promise<T> => Promise.resolve(data as T)
  return render(
    <ClusterOverview
      request={request}
      namespaces={['shop']}
      active
      onNavigate={() => undefined}
      onOpen={() => undefined}
    />
  )
}

it('partial Overview shows unavailable groups instead of empty or healthy claims', async () => {
  const data = overview()
  data.workloads = data.workloads.map((w, i) => (i === 0 ? { ...w, known: false } : w))
  data.unavailable = [
    { resource: 'deployments', reason: 'forbidden', message: 'Forbidden' },
    { resource: 'events', reason: 'error', message: 'server unavailable' },
    { resource: 'pvcs', reason: 'forbidden', message: 'Forbidden' }
  ]
  const view = show(data)
  const notice = await view.findByTestId('k8s-ov-unavailable')
  expect(notice.textContent).toContain('Deployments: no access')
  expect(notice.textContent).toContain('Events: Could not load data')
  expect(view.getByTestId('k8s-ov-empty-workloads').textContent).not.toContain('Deployments')
  expect(view.getByTestId('k8s-ov-empty-workloads').textContent).toContain('StatefulSets')
  expect(view.getByTestId('k8s-ov-problems').textContent).toContain('cluster health is incomplete')
  expect(view.queryByText('No warning events.')).toBeNull()
  expect(view.getByText('Warning events could not be loaded.')).toBeTruthy()
})

it('complete Overview still displays empty resource groups and checked health', async () => {
  const view = show(overview())
  await view.findByTestId('k8s-overview')
  expect(view.queryByTestId('k8s-ov-unavailable')).toBeNull()
  expect(view.getByTestId('k8s-ov-empty-workloads').textContent).toContain('Deployments')
  expect(
    within(view.getByTestId('k8s-ov-problems')).getByText(
      'No problems found — pods, nodes and volume claims look healthy.'
    )
  ).toBeTruthy()
  expect(view.getByText('No warning events.')).toBeTruthy()
})
