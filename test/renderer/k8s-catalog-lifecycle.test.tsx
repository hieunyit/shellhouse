// @vitest-environment jsdom
import './ds-dom'
import { renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { K8sOp } from '../../src/modules/k8s/shared/ops'
vi.mock('../../src/modules/registry/renderer-kit', async () => ({
  ...(await import('../../src/shared/i18n')),
  toast: { error: vi.fn() }
}))
import { useClusterCatalog } from '../../src/modules/k8s/renderer/useClusterData'

it('clears health, resource permissions and counts immediately when the session changes', async () => {
  const first = <T,>(op: K8sOp): Promise<T> =>
    Promise.resolve(
      (op.op === 'discover'
        ? [{ id: 'pods', forbidden: false }]
        : op.op === 'namespaces'
          ? { names: ['old'], canList: true }
          : op.op === 'counts'
            ? { pods: 3 }
            : { pods: { old: 2 }, deployments: {} }) as T
    )
  const pending = <T,>(): Promise<T> => new Promise(() => undefined)
  const view = renderHook(
    ({ request }) =>
      useClusterCatalog({
        ready: true,
        request,
        active: true,
        reloadKey: 0,
        refKey: 'same-context',
        initialNamespace: undefined,
        clusterNamespace: 'old'
      }),
    { initialProps: { request: first } }
  )
  await waitFor(() => {
    expect(view.result.current.health?.pods['old']).toBe(2)
  })
  view.rerender({ request: pending })
  expect(view.result.current.health).toBeNull()
  expect(view.result.current.kinds).toBeNull()
  expect(view.result.current.counts).toEqual({})
  expect(view.result.current.allNamespaces).toEqual([])
  view.unmount()
})
