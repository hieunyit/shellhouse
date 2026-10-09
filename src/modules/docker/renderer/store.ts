import { create } from 'zustand'
import type {
  DockerEndpoint,
  DockerRegistry,
  DockerTcpEndpoint,
  WslDistroInfo
} from '../shared/ipc'
import { dockerApi, rememberTcpNames } from './api'

interface DockerStore {
  endpoints: DockerEndpoint[]
  /** Windows: bản phân phối WSL (Docker có thể chạy trong đó); máy khác: []. */
  wsl: WslDistroInfo[]
  /** Registry đã lưu (không có mật khẩu). */
  registries: DockerRegistry[]
  /** Engine TCP + TLS đã lưu (không có chứng chỉ). */
  tcp: DockerTcpEndpoint[]
  loaded: boolean
  reload: () => Promise<void>
}

export const useDocker = create<DockerStore>((set) => ({
  endpoints: [],
  wsl: [],
  registries: [],
  tcp: [],
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
    // Tên engine TCP phải có trước khi danh sách hiện (nhãn tab / thanh bên).
    const tcp = await dockerApi.tcpEndpoints().catch(() => [])
    rememberTcpNames(tcp)
    set({ tcp, endpoints: await dockerApi.endpoints(), loaded: true })
  }
}))

dockerApi.onChanged(() => {
  void useDocker.getState().reload()
})

export function isReadOnly(hostId: string | null | undefined): boolean {
  return useDocker.getState().endpoints.some((e) => e.hostId === (hostId ?? null) && e.readOnly)
}
