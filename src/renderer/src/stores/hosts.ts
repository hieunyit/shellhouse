import { create } from 'zustand'
import { buildGroupTree, type GroupTree } from '@shared/group-tree'
import type { GroupSummary, HostSummary, HostTree } from '@shared/hosts'
import { effectiveHost, inheritedDefaults, type EffectiveHost } from '@shared/inherit'

interface HostsStore {
  tree: HostTree
  /** Cây nhóm dựng sẵn (tính lại mỗi lần tải). */
  groupTree: GroupTree<GroupSummary>
  /** Giá trị thực tế của từng host sau khi áp kế thừa từ nhóm (ADR-010). */
  effective: ReadonlyMap<string, EffectiveHost>
  loaded: boolean
  reload: () => Promise<void>
}

function derive(tree: HostTree): Pick<HostsStore, 'groupTree' | 'effective'> {
  const groupTree = buildGroupTree(tree.groups)
  const effective = new Map<string, EffectiveHost>()
  for (const h of tree.hosts)
    effective.set(h.id, effectiveHost(h, inheritedDefaults(groupTree, h.groupId)))
  return { groupTree, effective }
}

const empty: HostTree = { groups: [], hosts: [], keys: [] }

export const useHosts = create<HostsStore>((set) => ({
  tree: empty,
  ...derive(empty),
  loaded: false,
  reload: async () => {
    const tree = await window.shellhouse.hostTree()
    set({ tree, ...derive(tree), loaded: true })
  }
}))

/** "user@host:port" thực tế của host (sau kế thừa); port 22 thì bỏ. */
export function hostAddress(host: HostSummary, effective: EffectiveHost | undefined): string {
  const user = effective?.username ?? (host.username || '?')
  const port = effective?.port ?? host.port ?? 22
  return `${user}@${host.hostname}${port === 22 ? '' : `:${port}`}`
}

window.shellhouse.onHostsChanged(() => {
  void useHosts.getState().reload()
})
