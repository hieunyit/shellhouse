import { create } from 'zustand'
import type { ContextList } from '../shared/ipc'
import { k8sApi } from './api'

interface K8sStore extends ContextList {
  loaded: boolean
  reload: () => Promise<void>
}

export const useK8s = create<K8sStore>((set) => ({
  contexts: [],
  errors: [],
  imported: [],
  loaded: false,
  reload: async () => {
    set({ ...(await k8sApi.contexts()), loaded: true })
  }
}))

k8sApi.onChanged(() => {
  void useK8s.getState().reload()
})
