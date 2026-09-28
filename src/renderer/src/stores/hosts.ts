import { create } from 'zustand'
import type { HostTree } from '@shared/hosts'

interface HostsStore {
  tree: HostTree
  loaded: boolean
  reload: () => Promise<void>
}

export const useHosts = create<HostsStore>((set) => ({
  tree: { groups: [], hosts: [], keys: [] },
  loaded: false,
  reload: async () => {
    set({ tree: await window.shellhouse.hostTree(), loaded: true })
  }
}))

window.shellhouse.onHostsChanged(() => {
  void useHosts.getState().reload()
})
