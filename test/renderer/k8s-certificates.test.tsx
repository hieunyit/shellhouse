// @vitest-environment jsdom
import './ds-dom'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { CertificatesResult } from '../../src/modules/k8s/shared/ops'
const publish = vi.hoisted(() => vi.fn())
vi.mock('../../src/modules/registry/renderer-kit', async () => ({
  ...(await import('../../src/shared/i18n')),
  activateTab: vi.fn(),
  usePublishAttention: publish,
  useHomeAttentionEnabled: () => true,
  useFleetMonitored: () => false
}))
import { Certificates } from '../../src/modules/k8s/renderer/Certificates'

it('shows certificate warnings, publishes Home attention and preserves RBAC failures as partial checks', async () => {
  const data: CertificatesResult = {
    items: [
      {
        id: 'client',
        source: 'client',
        name: 'client',
        expiresAt: new Date(Date.now() - 1000).toISOString()
      }
    ],
    secretsError: 'Forbidden'
  }
  const request = <T,>(): Promise<T> => Promise.resolve(data as T)
  const props = { ready: true, request, tabId: 'tab', contextKey: 'ctx', cluster: 'Production' }
  const view = render(<Certificates {...props} />)
  await waitFor(() => {
    expect(view.getByTestId('k8s-certificates').textContent).toContain('expired')
  })
  expect(view.getByText('Some certificates could not be checked')).toBeTruthy()
  expect(publish).toHaveBeenLastCalledWith('k8s-certificates:tab', [
    expect.objectContaining({ severity: 'danger', source: 'Production' })
  ])
  fireEvent.click(view.getByTestId('k8s-certificates-open'))
  expect(view.getByTestId('k8s-certificate').getAttribute('data-state')).toBe('danger')
  expect(view.getByTestId('k8s-certificates-dialog').textContent).toContain('Forbidden')
  const next = <T,>(): Promise<T> => new Promise(() => undefined)
  view.rerender(<Certificates {...props} request={next} contextKey="other" />)
  expect(view.queryByTestId('k8s-certificate')).toBeNull()
  expect(view.getByTestId('k8s-certificates').textContent).not.toContain('expired')
  view.unmount()
})
