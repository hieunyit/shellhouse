import { create } from 'zustand'
import type { DockerEndpoint, WslDistroInfo } from '../shared/ipc'
import { dockerApi } from './api'

interface DockerStore {
  endpoints: DockerEndpoint[]
  /** Windows: bản phân phối WSL (Docker có thể chạy trong đó); máy khác: []. */
  wsl: WslDistroInfo[]
  loaded: boolean
  reload: () => Promise<void>
}

export const useDocker = create<DockerStore>((set) => ({
  endpoints: [],
  wsl: [],
  loaded: false,
  reload: async () => {
    // Danh sách WSL (wsl.exe, có thể mất vài giây trên máy chưa cài WSL) không giữ chân thanh bên.
    void dockerApi.wslDistros().then(
      (wsl) => {
        set({ wsl })
      },
      () => undefined
    )
    set({ endpoints: await dockerApi.endpoints(), loaded: true })
  }
}))

dockerApi.onChanged(() => {
  void useDocker.getState().reload()
})

export function isReadOnly(hostId: string | null | undefined): boolean {
  return useDocker.getState().endpoints.some((e) => e.hostId === (hostId ?? null) && e.readOnly)
}
