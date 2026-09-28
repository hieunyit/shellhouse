import { z } from 'zod'

// Không import từ file khác ngoài zod: dùng chung cho main, renderer và test.

export const Hostname = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._:[\]%-]+$/, 'Invalid hostname')
  .refine((v) => !v.startsWith('-'), 'Hostname must not start with "-"')
export const Username = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\s@:/\\]+$/, 'Invalid username')
  .refine((v) => !v.startsWith('-'), 'Username must not start with "-"')

export const HOST_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'gray'
] as const

/**
 * Cách xác thực của host:
 * - auto: như OpenSSH — agent, key mặc định (~/.ssh/id_*), rồi hỏi mật khẩu
 * - password: mật khẩu lưu trong vault
 * - key: key đã nhập vào vault (+ passphrase tuỳ chọn)
 */
export const AuthKind = z.enum(['auto', 'password', 'key'])
export type AuthKind = z.infer<typeof AuthKind>

/** builtin = SSH tích hợp (có SFTP, forwarding); system = chạy `ssh` của hệ thống (tương thích). */
export const HostMode = z.enum(['builtin', 'system'])
export type HostMode = z.infer<typeof HostMode>

export const MAX_JUMPS = 8

/** Thông tin host gửi cho renderer — KHÔNG có secret. */
export const HostSummary = z.object({
  id: z.string(),
  groupId: z.string().nullable(),
  label: z.string(),
  hostname: z.string(),
  port: z.number().int(),
  username: z.string(),
  auth: AuthKind,
  hasPassword: z.boolean(),
  keyId: z.string().nullable(),
  /** IdentityFile lấy từ ~/.ssh/config (đường dẫn, key không nằm trong vault). */
  keyFile: z.string().nullable(),
  proxyJump: z.string().nullable(),
  jumpHostIds: z.array(z.string()),
  mode: HostMode,
  tags: z.array(z.string()),
  color: z.enum(HOST_COLORS).nullable(),
  lastUsedAt: z.number().nullable()
})
export type HostSummary = z.infer<typeof HostSummary>

export const HostInput = z.object({
  /** Không có = tạo mới. */
  id: z.string().optional(),
  groupId: z.string().nullable(),
  label: z.string().trim().min(1, 'A label is required').max(100),
  hostname: Hostname,
  port: z.number().int().min(1).max(65535),
  username: Username,
  auth: AuthKind,
  /** undefined = giữ mật khẩu đã lưu; '' = xoá. */
  password: z.string().max(1024).optional(),
  keyId: z.string().nullable(),
  /** undefined = giữ passphrase đã lưu; '' = xoá. */
  passphrase: z.string().max(1024).optional(),
  keyFile: z.string().max(4096).nullable(),
  proxyJump: z.string().max(1024).nullable(),
  /** Jump host (host đã lưu) theo thứ tự; ưu tiên hơn `proxyJump`. */
  jumpHostIds: z.array(z.string().max(64)).max(MAX_JUMPS),
  mode: HostMode,
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  color: z.enum(HOST_COLORS).nullable()
})
export type HostInput = z.infer<typeof HostInput>

export const GroupSummary = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  sort: z.number().int()
})
export type GroupSummary = z.infer<typeof GroupSummary>

export const GroupInput = z.object({
  id: z.string().optional(),
  parentId: z.string().nullable(),
  name: z.string().trim().min(1).max(100)
})
export type GroupInput = z.infer<typeof GroupInput>

export const KeySummary = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  fingerprint: z.string(),
  encrypted: z.boolean()
})
export type KeySummary = z.infer<typeof KeySummary>

export const HostTree = z.object({
  groups: z.array(GroupSummary),
  hosts: z.array(HostSummary),
  keys: z.array(KeySummary)
})
export type HostTree = z.infer<typeof HostTree>

/** Một mục đọc được từ ~/.ssh/config, chờ người dùng chọn để nhập. */
export const ImportCandidate = z.object({
  alias: z.string(),
  hostname: z.string(),
  port: z.number().int(),
  username: z.string().nullable(),
  keyFile: z.string().nullable(),
  proxyJump: z.string().nullable(),
  /** Đã có host cùng tên hiển thị → mặc định không chọn. */
  duplicate: z.boolean(),
  /** Lý do không nhập được (hostname không hợp lệ...). */
  problem: z.string().nullable()
})
export type ImportCandidate = z.infer<typeof ImportCandidate>

export const MutationResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), id: z.string() }),
  z.object({ ok: z.literal(false), message: z.string() })
])
export type MutationResult = z.infer<typeof MutationResult>
