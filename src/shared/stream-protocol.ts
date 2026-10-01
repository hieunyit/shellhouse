import { z } from 'zod'
import { Hostname, Username } from './hosts'
import { ForwardSpec, type ForwardStatus } from './forwards'
import type { ServerStats } from './server-stats'
import { SerialSettings } from './serial'
import { SftpOp, type TransferStatus } from './sftp'

/**
 * Giao thức trên MessagePort nối thẳng renderer ↔ Session Host, mỗi session một port.
 * Chi tiết và lý do: docs/adr/0003-stream-protocol.md
 */

export const STREAM_LIMITS = {
  // Giá trị chọn theo benchmark `cat` 100 MB (ADR-003): 64 KB/1 MB → 8,0 s; 256 KB/4 MB → 5,5 s;
  // 512 KB/8 MB → 5,2 s nhưng Ctrl+C phải chờ vẽ hết gấp đôi lượng output đang xếp hàng.
  /** Gửi ngay khi gom đủ số byte này. */
  maxBatchBytes: 256 * 1024,
  /** Hoặc sau khoảng thời gian này kể từ byte đầu tiên của batch. */
  flushIntervalMs: 8,
  /** Byte đã gửi mà renderer chưa ack vượt mức này → tạm dừng nguồn. */
  highWatermarkBytes: 4 * 1024 * 1024,
  /** Giảm xuống dưới mức này → chạy lại nguồn. */
  lowWatermarkBytes: 1024 * 1024,
  maxCols: 1000,
  maxRows: 500
} as const

/** Id module: chữ thường, số, '-'. */
export const ModuleId = z.string().regex(/^[a-z0-9-]{1,40}$/)

/** Renderer → Session Host. Tần suất thấp nên validate đầy đủ bằng zod. */
export const ClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), d: z.string().max(1024 * 1024) }),
  z.object({
    t: z.literal('resize'),
    cols: z.number().int().min(1).max(STREAM_LIMITS.maxCols),
    rows: z.number().int().min(1).max(STREAM_LIMITS.maxRows)
  }),
  z.object({ t: z.literal('ack'), n: z.number().int().nonnegative() }),
  /** Trả lời prompt. `ok: false` = huỷ / từ chối. */
  z.object({ t: z.literal('sftp'), id: z.number().int(), op: SftpOp }),
  /** Thao tác của module (ADR-014 mục 3.5); `op` do schema của module kiểm. */
  z.object({ t: z.literal('module'), id: z.number().int(), module: ModuleId, op: z.unknown() }),
  /** Huỷ thao tác dài đang chạy (AbortSignal). */
  z.object({ t: z.literal('module-cancel'), id: z.number().int() }),
  /** Gắn module vào kết nối SSH của tab (Docker / K8s qua SSH). */
  z.object({ t: z.literal('module-attach'), module: ModuleId }),
  /** Dò dấu hiệu của các module đang tắt trên server (gợi ý bật — ADR-014 mục 3.12.4). */
  z.object({ t: z.literal('module-probe') }),
  /** Thêm public key vào ~/.ssh/authorized_keys của server (như ssh-copy-id). */
  z.object({
    t: z.literal('deploy-key'),
    id: z.number().int(),
    publicKey: z
      .string()
      .min(20)
      .max(16 * 1024)
      .refine((k) => !/[\r\n]/.test(k), 'Must be a single line')
  }),
  /** Bật/tắt thanh theo dõi server (chỉ chạy khi tab đang hiện — không tốn tài nguyên server). */
  z.object({ t: z.literal('stats'), on: z.boolean() }),
  z.object({ t: z.literal('forward-start'), spec: ForwardSpec }),
  z.object({ t: z.literal('forward-stop'), id: z.string().max(64) }),
  z.object({ t: z.literal('forward-remove'), id: z.string().max(64) }),
  z.object({
    t: z.literal('prompt-reply'),
    id: z.number().int(),
    ok: z.boolean(),
    answers: z.array(z.string().max(4096)).max(32)
  })
])
export type ClientMessage = z.infer<typeof ClientMessage>

export type ConnectionPhase = 'connecting' | 'authenticating' | 'connected'

/**
 * Vì sao session kết thúc — renderer dựa vào đây để quyết định có tự kết nối lại không.
 * - normal: shell thoát bình thường
 * - network: mất kết nối / không tới được server → tự nối lại nếu trước đó đã kết nối được
 * - auth: xác thực thất bại hoặc người dùng huỷ → không tự thử lại
 * - hostkey: host key bị từ chối → không bao giờ tự thử lại
 * - failed: lỗi khác
 */
export type ExitReason = 'normal' | 'network' | 'auth' | 'hostkey' | 'failed'
const EXIT_REASONS: readonly string[] = ['normal', 'network', 'auth', 'hostkey', 'failed']

export interface HostKeyInfo {
  host: string
  port: number
  keyType: string
  /** "SHA256:..." như OpenSSH. */
  fingerprint: string
  randomart: string
}

/** Session Host cần người dùng trả lời. */
export type PromptRequest =
  | { kind: 'password'; username: string; host: string }
  | { kind: 'passphrase'; keyPath: string }
  | {
      kind: 'keyboard-interactive'
      name: string
      instructions: string
      fields: { prompt: string; echo: boolean }[]
    }
  | {
      kind: 'hostkey'
      key: HostKeyInfo
      /** null = host mới; có giá trị = KEY ĐÃ ĐỔI (có thể bị tấn công MITM). */
      changedFrom: { keyType: string; fingerprint: string }[] | null
    }

/** Session Host → renderer. `data` là đường nóng nên chỉ kiểm tra kiểu thủ công. */
export type ServerMessage =
  | { t: 'data'; d: Uint8Array }
  | { t: 'exit'; code: number | null; signal: number | null; reason: ExitReason }
  | { t: 'error'; message: string }
  | { t: 'status'; phase: ConnectionPhase; detail: string }
  | { t: 'prompt'; id: number; prompt: PromptRequest }
  | { t: 'prompt-cancel'; id: number }
  | { t: 'forwards'; list: ForwardStatus[] }
  | { t: 'sftp-result'; id: number; ok: true; result: unknown }
  | { t: 'sftp-result'; id: number; ok: false; error: string }
  | { t: 'transfers'; list: TransferStatus[] }
  | { t: 'module-result'; id: number; ok: true; result: unknown }
  | { t: 'module-result'; id: number; ok: false; error: string }
  | { t: 'module-event'; module: string; event: string; data: unknown }
  /** Module đang tắt có dấu hiệu trên server này. */
  | { t: 'module-suggest'; modules: string[] }
  | { t: 'stats'; stats: ServerStats }
  | { t: 'stats-unsupported'; reason: string }
  /** Độ trễ khứ hồi tới server (ms); null = không đo được. */
  | { t: 'latency'; ms: number | null }
  | {
      t: 'deploy-key-result'
      id: number
      status: 'added' | 'exists' | 'error'
      message: string | null
    }

export function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  switch (m['t']) {
    case 'data':
      return m['d'] instanceof Uint8Array
    case 'exit':
      return (
        (typeof m['code'] === 'number' || m['code'] === null) &&
        (typeof m['signal'] === 'number' || m['signal'] === null) &&
        typeof m['reason'] === 'string' &&
        EXIT_REASONS.includes(m['reason'])
      )
    case 'error':
      return typeof m['message'] === 'string'
    case 'status':
      return typeof m['phase'] === 'string' && typeof m['detail'] === 'string'
    case 'prompt':
      return typeof m['id'] === 'number' && typeof m['prompt'] === 'object' && m['prompt'] !== null
    case 'prompt-cancel':
      return typeof m['id'] === 'number'
    case 'forwards':
    case 'transfers':
      return Array.isArray(m['list'])
    case 'deploy-key-result':
      return typeof m['id'] === 'number' && typeof m['status'] === 'string'
    case 'latency':
      return m['ms'] === null || typeof m['ms'] === 'number'
    case 'stats':
      return typeof m['stats'] === 'object' && m['stats'] !== null
    case 'stats-unsupported':
      return typeof m['reason'] === 'string'
    case 'sftp-result':
    case 'module-result':
      return typeof m['id'] === 'number' && typeof m['ok'] === 'boolean'
    case 'module-event':
      return typeof m['module'] === 'string' && typeof m['event'] === 'string'
    case 'module-suggest':
      return Array.isArray(m['modules'])
    default:
      return false
  }
}

export const LocalSessionSpec = z.object({
  kind: z.literal('local'),
  cols: z.number().int().min(1).max(STREAM_LIMITS.maxCols),
  rows: z.number().int().min(1).max(STREAM_LIMITS.maxRows),
  /** Shell đã dò được (PowerShell, cmd, WSL…); không có = shell mặc định. */
  shellId: z.string().max(80).optional()
})
export type LocalSessionSpec = z.infer<typeof LocalSessionSpec>

/**
 * Main → Session Host: main tra `shellId` ra chương trình cụ thể. Chỉ có ở spec đã phân giải —
 * renderer không gửi được đường dẫn file để chạy.
 */
export const ResolvedLocalSessionSpec = LocalSessionSpec.extend({
  shell: z
    .object({ file: z.string().max(1024), args: z.array(z.string().max(1024)).max(16) })
    .optional()
})

/** Mức song song (từ cài đặt): số request cùng lúc và số file truyền cùng lúc. */
export const ParallelLimits = z.object({
  requests: z.number().int().min(1).max(64),
  transfers: z.number().int().min(1).max(16)
})
export type ParallelLimits = z.infer<typeof ParallelLimits>

/**
 * Tab terminal của module chạy trên kết nối SSH (shell vào container / pod — ADR-014 mục 3.7): thay
 * cho shell, Session Host gắn module rồi mở terminal module cấp.
 */
export const ModuleTerminal = z.object({ module: ModuleId, params: z.unknown() })
export type ModuleTerminal = z.infer<typeof ModuleTerminal>

/** Kết nối SSH tới một đích (kết nối nhanh). Host đã lưu dùng `hostId` (tuần 6). */
export const SshSessionSpec = z.object({
  kind: z.literal('ssh'),
  cols: z.number().int().min(1).max(STREAM_LIMITS.maxCols),
  rows: z.number().int().min(1).max(STREAM_LIMITS.maxRows),
  target: z.object({
    host: Hostname,
    port: z.number().int().min(1).max(65535),
    username: Username
  }),
  /** true = chỉ SFTP, không mở shell trên server. */
  noShell: z.boolean().optional(),
  /** Mức song song của SFTP — main điền từ cài đặt. */
  sftpLimits: ParallelLimits.optional(),
  moduleTerminal: ModuleTerminal.optional()
})
export type SshSessionSpec = z.infer<typeof SshSessionSpec>

/** Host đã lưu — main tra DB, giải mã thông tin xác thực rồi chuyển thành SshSessionSpec. */
export const SavedHostSessionSpec = z.object({
  kind: z.literal('host'),
  cols: z.number().int().min(1).max(STREAM_LIMITS.maxCols),
  rows: z.number().int().min(1).max(STREAM_LIMITS.maxRows),
  hostId: z.string().min(1).max(64),
  noShell: z.boolean().optional(),
  moduleTerminal: ModuleTerminal.optional()
})
export type SavedHostSessionSpec = z.infer<typeof SavedHostSessionSpec>

/**
 * Phiên riêng của module (tab S3, Docker trên máy này…). `params` do module kiểm; main phân giải
 * thành `config` (có thể chứa secret) — config chỉ đi thẳng sang Session Host.
 */
export const ModuleSessionSpec = z.object({
  kind: z.literal('module'),
  module: ModuleId,
  sessionKind: z.string().regex(/^[a-z0-9-]{1,40}$/),
  cols: z.number().int().min(1).max(STREAM_LIMITS.maxCols),
  rows: z.number().int().min(1).max(STREAM_LIMITS.maxRows),
  params: z.unknown(),
  /** Có = tab terminal của module (3.7): mở terminal với tham số này. */
  terminal: z.unknown().optional()
})
export type ModuleSessionSpec = z.infer<typeof ModuleSessionSpec>

export const ResolvedModuleSessionSpec = ModuleSessionSpec.omit({ params: true }).extend({
  config: z.unknown()
})

export const SessionSpec = z.discriminatedUnion('kind', [
  LocalSessionSpec,
  SshSessionSpec,
  SavedHostSessionSpec,
  ModuleSessionSpec
])

const SshTargetSchema = z.object({
  host: Hostname,
  port: z.number().int().min(1).max(65535),
  username: Username
})

/**
 * Chế độ tương thích: chạy `ssh` của hệ thống trong PTY. Host key, xác thực do OpenSSH lo
 * (dùng ~/.ssh/known_hosts, agent, ssh_config); không có SFTP/forwarding tích hợp.
 */
export const SystemSshSessionSpec = z.object({
  kind: z.literal('system-ssh'),
  cols: z.number().int().min(1).max(STREAM_LIMITS.maxCols),
  rows: z.number().int().min(1).max(STREAM_LIMITS.maxRows),
  target: SshTargetSchema,
  jumps: z.array(SshTargetSchema).max(8),
  keyFile: z.string().max(4096).nullable(),
  /** Chỉ main gán, chỉ khi chạy test (ví dụ UserKnownHostsFile tạm). */
  testOptions: z.array(z.string().max(1024)).max(8).optional()
})
export type SystemSshSessionSpec = z.infer<typeof SystemSshSessionSpec>

/** Telnet (thiết bị mạng) — không mã hoá. */
export const TelnetSessionSpec = z.object({
  kind: z.literal('telnet'),
  cols: z.number().int().min(1).max(STREAM_LIMITS.maxCols),
  rows: z.number().int().min(1).max(STREAM_LIMITS.maxRows),
  target: z.object({ host: Hostname, port: z.number().int().min(1).max(65535) })
})
export type TelnetSessionSpec = z.infer<typeof TelnetSessionSpec>

/** Cổng serial — chỉ main tạo (từ host đã lưu). */
export const SerialSessionSpec = z.object({
  kind: z.literal('serial'),
  cols: z.number().int().min(1).max(STREAM_LIMITS.maxCols),
  rows: z.number().int().min(1).max(STREAM_LIMITS.maxRows),
  serial: SerialSettings
})

/** Spec Session Host thực sự nhận (host đã lưu đã được main phân giải). */
export const ResolvedSessionSpec = z.discriminatedUnion('kind', [
  ResolvedLocalSessionSpec,
  SshSessionSpec,
  SystemSshSessionSpec,
  TelnetSessionSpec,
  SerialSessionSpec,
  ResolvedModuleSessionSpec
])
export type ResolvedSessionSpec = z.infer<typeof ResolvedSessionSpec>
export type SessionSpec = z.infer<typeof SessionSpec>
