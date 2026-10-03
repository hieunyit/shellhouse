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

/** Registry đã lưu (không có mật khẩu — mật khẩu / token nằm trong vault, chỉ Session Host thấy). */
export interface DockerRegistry {
  id: string
  name: string
  /** "docker.io", "ghcr.io", "registry.example.com:5000". */
  server: string
  username: string
  hasSecret: boolean
}

export const RegistryInput = z.object({
  /** Có = sửa. */
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(100),
  server: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^(https?:\/\/)?[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?(\/[\w./-]*)?$/, 'Invalid registry'),
  username: z.string().trim().min(1).max(256),
  /** undefined = giữ mật khẩu cũ (khi sửa). */
  secret: z.string().max(8192).optional()
})
export type RegistryInput = z.infer<typeof RegistryInput>

/** Tham số IPC `module:docker:*`. */
export const DockerIpc = {
  endpoints: z.tuple([]),
  /** Thêm host SSH (null = máy này) vào danh sách Docker. */
  add: z.tuple([HostId.nullable()]),
  remove: z.tuple([HostId.nullable()]),
  hide: z.tuple([HostId]),
  setReadOnly: z.tuple([HostId.nullable(), z.boolean()]),
  /** Windows: bản phân phối WSL (Docker chạy trong đó). */
  wslDistros: z.tuple([]),
  registries: z.tuple([]),
  saveRegistry: z.tuple([RegistryInput]),
  deleteRegistry: z.tuple([z.string().min(1).max(64)]),
  /** Session Host → main (`fromMain('registryAuth', id)`): thông tin đăng nhập đã giải mã. */
  registryAuthQuery: z.string().min(1).max(64),
  /** Session Host → main (`fromMain('readOnly', hostId)`): cờ chỉ đọc đã lưu. */
  readOnlyQuery: HostId.nullable()
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

/**
 * Registry của một image: phần đầu trước "/" nếu giống tên máy ("ghcr.io", "localhost:5000"),
 * không thì Docker Hub ("nginx", "library/nginx", "org/app").
 */
export function registryOf(ref: string): string {
  const slash = ref.indexOf('/')
  if (slash < 0) return 'docker.io'
  const first = ref.slice(0, slash)
  return /[.:]/.test(first) || first === 'localhost' ? normalizeRegistry(first) : 'docker.io'
}

/** "https://index.docker.io/v1/" / "registry-1.docker.io" → "docker.io"; bỏ scheme, đường dẫn. */
export function normalizeRegistry(server: string): string {
  const host = server
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
  return [
    'index.docker.io',
    'registry-1.docker.io',
    'registry.hub.docker.com',
    'hub.docker.com'
  ].includes(host)
    ? 'docker.io'
    : host
}

/** Registry đã lưu phù hợp với image (đúng máy chủ) — null = không có. */
export function registryFor<T extends { server: string }>(
  ref: string,
  registries: readonly T[]
): T | null {
  const host = registryOf(ref)
  return registries.find((r) => normalizeRegistry(r.server) === host) ?? null
}
