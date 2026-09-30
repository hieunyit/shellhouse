import { z } from 'zod'

/**
 * Giao thức của module Docker (ADR-014 mục 6.5): renderer ↔ Session Host qua tin `module`. Mọi
 * thao tác validate bằng schema ở đây trước khi chạy.
 */

const Id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:/@-]+$/, 'Invalid id')
const Subscription = z.string().min(1).max(64)

export const ContainerAction = z.enum([
  'start',
  'stop',
  'restart',
  'pause',
  'unpause',
  'kill',
  'remove'
])
export type ContainerAction = z.infer<typeof ContainerAction>

export const PruneTarget = z.enum(['images', 'volumes', 'networks', 'containers'])
export type PruneTarget = z.infer<typeof PruneTarget>

export const ComposeAction = z.enum(['start', 'stop', 'restart', 'up', 'down', 'pull'])
export type ComposeAction = z.infer<typeof ComposeAction>

export const DockerOp = z.discriminatedUnion('op', [
  /** Chế độ chỉ đọc cho phiên này: thao tác thay đổi bị từ chối ở Session Host. */
  z.object({ op: z.literal('configure'), readOnly: z.boolean() }),
  z.object({ op: z.literal('info') }),
  z.object({ op: z.literal('containers'), all: z.boolean() }),
  z.object({
    op: z.literal('inspect'),
    kind: z.enum(['container', 'image', 'volume', 'network']),
    id: Id
  }),
  z.object({
    op: z.literal('action'),
    id: Id,
    action: ContainerAction,
    force: z.boolean().optional()
  }),
  z.object({
    op: z.literal('rename'),
    id: Id,
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'Letters, digits, "_", "." and "-" only')
  }),
  z.object({
    op: z.literal('logs.subscribe'),
    id: Id,
    tail: z.number().int().min(0).max(100_000),
    timestamps: z.boolean()
  }),
  z.object({ op: z.literal('stats.subscribe'), id: Id }),
  z.object({ op: z.literal('events.subscribe') }),
  z.object({ op: z.literal('unsubscribe'), subscription: Subscription }),
  z.object({ op: z.literal('images') }),
  z.object({ op: z.literal('image.remove'), id: Id, force: z.boolean().optional() }),
  z.object({
    op: z.literal('image.pull'),
    ref: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/, 'Looks like nginx:1.27 or ghcr.io/org/app:tag')
  }),
  z.object({ op: z.literal('volumes') }),
  z.object({ op: z.literal('volume.remove'), name: Id }),
  z.object({ op: z.literal('networks') }),
  z.object({ op: z.literal('network.remove'), id: Id }),
  /** dryRun = chỉ liệt kê những gì sẽ bị xoá. */
  z.object({ op: z.literal('prune'), what: PruneTarget, dryRun: z.boolean() }),
  z.object({
    op: z.literal('compose'),
    project: z.string().min(1).max(128),
    action: ComposeAction
  })
])
export type DockerOp = z.infer<typeof DockerOp>

/** Thao tác thay đổi (bị chặn ở chế độ chỉ đọc). */
export function isMutating(op: DockerOp): boolean {
  switch (op.op) {
    case 'action':
    case 'rename':
    case 'image.remove':
    case 'image.pull':
    case 'volume.remove':
    case 'network.remove':
    case 'compose':
      return true
    case 'prune':
      return !op.dryRun
    default:
      return false
  }
}

// ——— Kết quả ———

export interface EngineInfo {
  /** "Docker Engine 27.1 · linux/amd64" */
  version: string
  apiVersion: string
  os: string
  containers: number
  running: number
  images: number
  /** 'api' = Engine API qua socket; 'cli' = `docker` CLI (dự phòng). */
  via: 'api' | 'cli'
  /** Podman / rootless… */
  flavor: string
}

export interface PortMapping {
  ip: string
  privatePort: number
  publicPort: number | null
  type: string
}

export interface ContainerRow {
  id: string
  name: string
  image: string
  /** created | running | paused | restarting | exited | removing | dead */
  state: string
  status: string
  created: number
  ports: PortMapping[]
  /** Nhãn `com.docker.compose.project` (nếu có). */
  project: string | null
  service: string | null
  /** Thư mục + file compose (để chạy `docker compose up/down`). */
  composeDir: string | null
  composeFiles: string | null
}

export interface ImageRow {
  id: string
  tags: string[]
  size: number
  created: number
  /** Không có tag (dangling). */
  dangling: boolean
  containers: number
}

export interface VolumeRow {
  name: string
  driver: string
  mountpoint: string
  created: number | null
  project: string | null
}

export interface NetworkRow {
  id: string
  name: string
  driver: string
  scope: string
  /** bridge / host / none — không xoá được. */
  builtin: boolean
}

export interface PruneResult {
  /** Tên / id những gì bị xoá (hoặc sẽ bị xoá khi dryRun). */
  items: string[]
  reclaimed: number
}

/** Mẫu CPU / RAM / mạng từ /containers/{id}/stats. */
export interface StatsSample {
  at: number
  cpuPercent: number
  memUsage: number
  memLimit: number
  netRx: number
  netTx: number
}

// ——— Sự kiện (Session Host → tab) ———

export interface LogsEvent {
  subscription: string
  stream: 'stdout' | 'stderr'
  text: string
}

export interface PullEvent {
  subscription: string
  status: string
  /** Tiến độ theo layer (0–1), null = không rõ. */
  progress: number | null
  done: boolean
  error?: string
}

/** Tham số phiên / terminal. */
export const DockerEngineParams = z.object({
  /** 'local' = máy này; có hostId = qua SSH tới host đã lưu (tab tự mở kết nối). */
  hostId: z.string().min(1).max(64).optional(),
  /** Tên hiển thị (tiêu đề tab). */
  label: z.string().max(200)
})
export type DockerEngineParams = z.infer<typeof DockerEngineParams>

export const DockerLogsParams = z.object({
  hostId: z.string().min(1).max(64).optional(),
  label: z.string().max(200),
  container: Id,
  name: z.string().max(200)
})
export type DockerLogsParams = z.infer<typeof DockerLogsParams>

/** Shell vào container (tab terminal của module). */
export const DockerTerminalParams = z.object({
  container: Id,
  /** Lệnh thay cho shell mặc định (bash nếu có, không thì sh). */
  command: z.array(z.string().max(1024)).max(32).optional(),
  user: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_.:-]*$/)
    .optional()
})
export type DockerTerminalParams = z.infer<typeof DockerTerminalParams>

/** Config phiên trên máy này (main phân giải). */
export const DockerLocalConfig = z.object({
  /** Socket / named pipe của Engine; null = không có (chỉ dùng CLI). */
  socket: z.string().max(1024).nullable()
})
export type DockerLocalConfig = z.infer<typeof DockerLocalConfig>

/** Che giá trị biến môi trường có vẻ là bí mật (inspect). */
export function maskEnv(entry: string): string {
  const eq = entry.indexOf('=')
  if (eq < 0) return entry
  const name = entry.slice(0, eq)
  return /pass|secret|token|key|credential|auth|private|cert|dsn/i.test(name)
    ? `${name}=••••••`
    : entry
}
