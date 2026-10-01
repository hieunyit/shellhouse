import { z } from 'zod'

/** Nguồn Docker: máy này (`local`) hoặc host SSH đã lưu. */
export const DockerEndpoint = z.object({
  id: z.string(),
  /** null = máy này. */
  hostId: z.string().nullable(),
  readOnly: z.boolean(),
  /** Ẩn khỏi thanh bên (distro WSL được liệt kê tự động). */
  hidden: z.boolean()
})
export type DockerEndpoint = z.infer<typeof DockerEndpoint>

const HostId = z.string().min(1).max(64)

/** Tham số IPC `module:docker:*`. */
export const DockerIpc = {
  endpoints: z.tuple([]),
  /** Thêm host SSH (null = máy này) vào danh sách Docker. */
  add: z.tuple([HostId.nullable()]),
  remove: z.tuple([HostId.nullable()]),
  hide: z.tuple([HostId]),
  setReadOnly: z.tuple([HostId.nullable(), z.boolean()]),
  /** Windows: bản phân phối WSL (Docker chạy trong đó). */
  wslDistros: z.tuple([])
} as const

export const endpointId = (hostId: string | null): string => hostId ?? 'local'

/**
 * "Nguồn" Docker trong renderer dùng chung chỗ của hostId: null = máy này, `wsl:<distro>` = Docker
 * trong WSL, còn lại = host SSH đã lưu.
 */
export const WSL_PREFIX = 'wsl:'
export const wslSource = (distro: string): string => `${WSL_PREFIX}${distro}`
export const wslDistroOf = (source: string | null | undefined): string | null =>
  source?.startsWith(WSL_PREFIX) ? source.slice(WSL_PREFIX.length) : null

export interface WslDistroInfo {
  name: string
  running: boolean
  version: number
}
