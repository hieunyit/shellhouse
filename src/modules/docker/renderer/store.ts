import { create } from 'zustand'
import type { DockerEndpoint } from '../shared/ipc'
import { dockerApi } from './api'

interface DockerStore {
  endpoints: DockerEndpoint[]
  loaded: boolean
  reload: () => Promise<void>
}

export const useDocker = create<DockerStore>((set) => ({
  endpoints: [],
  loaded: false,
  reload: async () => {
    set({ endpoints: await dockerApi.endpoints(), loaded: true })
  }
}))

dockerApi.onChanged(() => {
  void useDocker.getState().reload()
})

export function isReadOnly(hostId: string | null | undefined): boolean {
  return useDocker.getState().endpoints.some((e) => e.hostId === (hostId ?? null) && e.readOnly)
}
