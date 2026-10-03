import { create } from 'zustand'
import type { DockerEndpoint, DockerRegistry, WslDistroInfo } from '../shared/ipc'
import { dockerApi } from './api'

interface DockerStore {
  endpoints: DockerEndpoint[]
  /** Windows: bản phân phối WSL (Docker có thể chạy trong đó); máy khác: []. */
  wsl: WslDistroInfo[]
  /** Registry đã lưu (không có mật khẩu). */
  registries: DockerRegistry[]
  loaded: boolean
  reload: () => Promise<void>
}

export const useDocker = create<DockerStore>((set) => ({
  endpoints: [],
  wsl: [],
  registries: [],
  loaded: false,
  reload: async () => {
    // Danh sách WSL (wsl.exe, có thể mất vài giây trên máy chưa cài WSL) không giữ chân thanh bên.
    void dockerApi.wslDistros().then(
      (wsl) => {
        set({ wsl })
      },
      () => undefined
    )
    void dockerApi.registries().then(
      (registries) => {
        set({ registries })
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
