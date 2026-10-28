// @vitest-environment jsdom
import './ds-dom'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ImportCandidate } from '@shared/hosts'
import type { ShellhouseApi } from '@shared/ipc'
import { buildGroupTree } from '../../src/shared/group-tree'
import { ImportDialog } from '../../src/renderer/src/components/ImportDialog'

const state = vi.hoisted(() => ({
  tree: {
    groups: [{ id: 'target', name: 'Target', parentId: null, sort: 0 }],
    hosts: [],
    keys: []
  },
  groupTree: null as unknown as ReturnType<typeof buildGroupTree>
}))
vi.mock('../../src/renderer/src/stores/hosts', () => ({
  useHosts: (selector: (s: typeof state) => unknown) => selector(state)
}))
vi.mock('../../src/renderer/src/components/accounts/ImportKeyDialog', () => ({
  importKey: vi.fn()
}))
afterEach(cleanup)
beforeEach(() => {
  state.groupTree = buildGroupTree(state.tree.groups)
})
function candidate(alias: string): ImportCandidate {
  return {
    alias,
    hostname: `${alias}.example.com`,
    port: 22,
    username: 'deploy',
    keyFile: null,
    proxyJump: null,
    duplicate: false,
    problem: null
  }
}
function api(patch: Partial<ShellhouseApi>) {
  window.shellhouse = { scanSshConfig: () => Promise.resolve([]), ...patch } as ShellhouseApi
}
it('ignores a late successful scan from a previously selected source', async () => {
  let finish: ((candidates: ImportCandidate[]) => void) | undefined
  api({
    scanSshConfig: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    scanCsv: () =>
      Promise.resolve({ file: 'hosts.csv', candidates: [candidate('csv')], ignored: {} })
  })
  const view = render(<ImportDialog onClose={() => undefined} />)
  fireEvent.change(view.getByTestId('import-source'), { target: { value: 'csv' } })
  fireEvent.click(view.getByTestId('import-choose-file'))
  await view.findByTestId('import-row-csv')
  await act(async () => {
    finish?.([candidate('ssh')])
    await Promise.resolve()
  })
  expect(view.queryByTestId('import-row-ssh')).toBeNull()
  expect(view.getByTestId('import-row-csv')).toBeTruthy()
})
it('ignores a late scan error and clears selection when changing sources', async () => {
  let fail: ((error: Error) => void) | undefined
  api({
    scanSshConfig: () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
  })
  const view = render(<ImportDialog onClose={() => undefined} />)
  fireEvent.change(view.getByTestId('import-source'), { target: { value: 'csv' } })
  await act(async () => {
    fail?.(new Error('stale error'))
    await Promise.resolve()
  })
  expect(view.queryByTestId('import-error')).toBeNull()
  expect((view.getByTestId('import-run') as HTMLButtonElement).disabled).toBe(true)
})
it('prevents duplicate submissions and defaults to No group', async () => {
  let finish: ((result: { imported: number; skipped: string[] }) => void) | undefined
  const submit = vi.fn(
    () =>
      new Promise<{ imported: number; skipped: string[] }>((resolve) => {
        finish = resolve
      })
  )
  api({ scanSshConfig: () => Promise.resolve([candidate('ssh')]), importSshConfig: submit })
  const view = render(<ImportDialog onClose={() => undefined} />)
  await view.findByTestId('import-row-ssh')
  expect(
    (view.getByTestId('import-option-group') as HTMLSelectElement).selectedOptions[0]?.textContent
  ).toBe('No group')
  fireEvent.click(view.getByTestId('import-run'))
  fireEvent.click(view.getByTestId('import-run'))
  fireEvent.change(view.getByTestId('import-source'), { target: { value: 'csv' } })
  expect((view.getByTestId('import-source') as HTMLSelectElement).value).toBe('ssh-config')
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit).toHaveBeenCalledWith(['ssh'], {})
  await act(async () => {
    finish?.({ imported: 1, skipped: [] })
    await Promise.resolve()
  })
  expect(view.getByTestId('import-result').textContent).toContain('Imported 1 host')
})
it('RDP imports use the existing destination group without SSH-only validation', async () => {
  const submit = vi.fn(() => Promise.resolve({ imported: 1, skipped: [] }))
  api({
    scanSshConfig: () => Promise.resolve([candidate('ssh')]),
    scanRdpFiles: () =>
      Promise.resolve({ file: 'desktop.rdp', candidates: [candidate('desktop')], ignored: {} }),
    importRdpFiles: submit
  })
  const view = render(<ImportDialog onClose={() => undefined} />)
  await view.findByTestId('import-row-ssh')
  fireEvent.change(view.getByTestId('import-option-user'), { target: { value: 'bad ssh user' } })
  fireEvent.change(view.getByTestId('import-source'), { target: { value: 'rdp' } })
  fireEvent.click(view.getByTestId('import-choose-file'))
  await view.findByTestId('import-row-desktop')
  expect(view.queryByTestId('import-option-user')).toBeNull()
  fireEvent.change(view.getByTestId('import-option-group'), { target: { value: 'target' } })
  fireEvent.click(view.getByTestId('import-run'))
  await view.findByTestId('import-result')
  expect(submit).toHaveBeenCalledWith(['desktop'], { groupId: 'target' })
})

it('selects the calling group before scanning and keeps it when changing source', async () => {
  const submit = vi.fn(() => Promise.resolve({ imported: 1, skipped: [] }))
  api({
    scanCsv: () =>
      Promise.resolve({ file: 'hosts.csv', candidates: [candidate('csv')], ignored: {} }),
    importCsv: submit
  })
  const view = render(<ImportDialog initialGroupId="target" onClose={() => undefined} />)
  expect((view.getByTestId('import-option-group') as HTMLSelectElement).value).toBe('target')
  fireEvent.change(view.getByTestId('import-source'), { target: { value: 'csv' } })
  fireEvent.click(view.getByTestId('import-choose-file'))
  await view.findByTestId('import-row-csv')
  expect((view.getByTestId('import-option-group') as HTMLSelectElement).value).toBe('target')
  fireEvent.click(view.getByTestId('import-run'))
  await view.findByTestId('import-result')
  expect(submit).toHaveBeenCalledWith(['csv'], { groupId: 'target' })
})
it('blocks import for a missing destination until the user explicitly chooses another', async () => {
  api({ scanSshConfig: () => Promise.resolve([candidate('ssh')]) })
  const view = render(<ImportDialog initialGroupId="removed" onClose={() => undefined} />)
  await view.findByTestId('import-row-ssh')
  expect(view.getByText('The selected group no longer exists. Choose another group.')).toBeTruthy()
  expect((view.getByTestId('import-run') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(view.getByTestId('import-option-group'), { target: { value: 'target' } })
  expect((view.getByTestId('import-run') as HTMLButtonElement).disabled).toBe(false)
})
it('keeps selection across pagination and search without rendering all preview rows', async () => {
  const submit = vi.fn<ShellhouseApi['importSshConfig']>(() =>
    Promise.resolve({ imported: 205, skipped: [] })
  )
  api({
    scanSshConfig: () =>
      Promise.resolve(Array.from({ length: 205 }, (_, i) => candidate(`host${i}`))),
    importSshConfig: submit
  })
  const view = render(<ImportDialog onClose={() => undefined} />)
  await view.findByTestId('import-row-host0')
  expect(view.getByTestId('import-preview').querySelectorAll('tbody tr')).toHaveLength(100)
  expect(view.getByTestId('import-summary').textContent).toContain('205 hosts selected')
  fireEvent.click(view.getByLabelText('Select host0'))
  expect((view.getByTestId('import-select-all') as HTMLInputElement).indeterminate).toBe(true)
  view.getByTestId('import-preview').scrollTop = 400
  fireEvent.click(view.getByTestId('import-next'))
  expect(view.getByTestId('import-preview').scrollTop).toBe(0)
  expect(view.getByTestId('import-row-host100')).toBeTruthy()
  expect(view.queryByTestId('import-row-host0')).toBeNull()
  fireEvent.click(view.getByTestId('import-next'))
  expect(view.getByTestId('import-preview').querySelectorAll('tbody tr')).toHaveLength(5)
  fireEvent.change(view.getByTestId('import-search'), { target: { value: 'host0.example.com' } })
  expect(view.getByTestId('import-preview').querySelectorAll('tbody tr')).toHaveLength(1)
  expect((view.getByLabelText('Select host0') as HTMLInputElement).checked).toBe(false)
  fireEvent.click(view.getByLabelText('Select host0'))
  fireEvent.change(view.getByTestId('import-search'), { target: { value: 'no such host' } })
  expect(view.getByText('No matching hosts.')).toBeTruthy()
  fireEvent.click(view.getByTestId('import-run'))
  await view.findByTestId('import-result')
  expect(submit.mock.calls[0]?.[0]).toHaveLength(205)
})
