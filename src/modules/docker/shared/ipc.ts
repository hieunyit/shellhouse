import { z } from 'zod'

/** Nguồn Docker: máy này (`local`) hoặc host SSH đã lưu. */
export const DockerEndpoint = z.object({
  id: z.string(),
  /** null = máy này. */
  hostId: z.string().nullable(),
  readOnly: z.boolean()
})
export type DockerEndpoint = z.infer<typeof DockerEndpoint>

const HostId = z.string().min(1).max(64)

/** Tham số IPC `module:docker:*`. */
export const DockerIpc = {
  endpoints: z.tuple([]),
  /** Thêm host SSH (null = máy này) vào danh sách Docker. */
  add: z.tuple([HostId.nullable()]),
  remove: z.tuple([HostId.nullable()]),
  setReadOnly: z.tuple([HostId.nullable(), z.boolean()])
} as const

export const endpointId = (hostId: string | null): string => hostId ?? 'local'
