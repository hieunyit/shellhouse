// @vitest-environment jsdom
import './ds-dom'
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { buildGroupTree } from '../../src/shared/group-tree'
import { HostGroups } from '../../src/renderer/src/components/HostGroups'
import { tabHostId } from '../../src/renderer/src/lib/tab-host'

const state = vi.hoisted(() => ({
  tree: {
    hosts: [
      { id: 'a', groupId: 'db' },
      { id: 'b', groupId: 'stage' }
    ]
  },
  groupTree: null as unknown as ReturnType<typeof buildGroupTree>
}))
vi.mock('../../src/renderer/src/stores/hosts', () => ({
  useHosts: (selector: (s: typeof state) => unknown) => selector(state)
}))

describe('host source groups', () => {
  it('keeps nested groups, omits empty groups and follows host moves', () => {
    state.groupTree = buildGroupTree([
      { id: 'prod', parentId: null, name: 'Production', sort: 0 },
      { id: 'db', parentId: 'prod', name: 'Database', sort: 0 },
      { id: 'stage', parentId: null, name: 'Staging', sort: 1 },
      { id: 'empty', parentId: null, name: 'Empty', sort: 2 }
    ])
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'local' }]
    const view = () => (
      <HostGroups items={items} hostId={(x) => x.id} itemKey={(x) => x.id}>
        {(x) => <span data-source={x.id}>{x.id}</span>}
      </HostGroups>
    )
    const { container, rerender } = render(view())
    expect(
      container.querySelector('[data-host-group="prod"] [data-host-group="db"] [data-source="a"]')
    ).toBeTruthy()
    expect(container.querySelector('[data-host-group="stage"] [data-source="b"]')).toBeTruthy()
    expect(container.querySelector('[data-host-group="empty"]')).toBeNull()
    expect(container.querySelector('[data-source="local"]')?.closest('details')).toBeNull()
    state.tree.hosts = [
      { id: 'a', groupId: 'stage' },
      { id: 'b', groupId: 'stage' }
    ]
    rerender(view())
    expect(container.querySelector('[data-host-group="stage"] [data-source="a"]')).toBeTruthy()
    expect(container.querySelector('[data-host-group="prod"]')).toBeNull()
  })

  it('resolves the same source for SSH, SFTP, Docker logs and container shells', () => {
    expect(tabHostId({ kind: 'host', hostId: 'a' })).toBe('a')
    expect(
      tabHostId({ kind: 'module', module: 'docker', tab: 'logs', params: { hostId: 'a' } })
    ).toBe('a')
    expect(tabHostId({ kind: 'module-terminal', module: 'docker', hostId: 'a', params: {} })).toBe(
      'a'
    )
    expect(tabHostId({ kind: 'module', module: 'docker', tab: 'engine', params: {} })).toBeNull()
    expect(tabHostId({ kind: 'local' })).toBeNull()
  })
})
