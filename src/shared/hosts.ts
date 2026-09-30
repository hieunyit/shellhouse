import { z } from 'zod'
import { SerialSettings } from './serial'

// Không import từ file khác ngoài zod: dùng chung cho main, renderer và test.

export const Hostname = z
  .string()
  .min(1, 'Enter a hostname or IP address')
  .max(255, 'The hostname is too long')
  .regex(/^[A-Za-z0-9._:[\]%-]+$/, 'Invalid hostname')
  .refine((v) => !v.startsWith('-'), 'Hostname must not start with "-"')
export const Username = z
  .string()
  .min(1, 'Enter a username')
  .max(128, 'The username is too long')
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

export const Port = z
  .number({ error: 'The port must be a number' })
  .int('The port must be a whole number')
  .min(1, 'The port must be between 1 and 65535')
  .max(65535, 'The port must be between 1 and 65535')

export const HostColor = z.enum(HOST_COLORS)
export type HostColor = z.infer<typeof HostColor>

/**
 * Giá trị mặc định của một nhóm cho mọi host bên trong (kể cả nhóm con cháu). Host kế thừa từ nhóm
 * GẦN NHẤT có đặt giá trị đó, trừ khi host tự ghi đè (ADR-010).
 * - keyId: key được thử khi host dùng xác thực Automatic
 * - color: màu môi trường (tab + viền terminal), ví dụ Production = đỏ
 */
export const GroupDefaults = z.object({
  username: Username.optional(),
  port: Port.optional(),
  keyId: z.string().max(64).optional(),
  jumpHostIds: z.array(z.string().max(64)).min(1).max(MAX_JUMPS).optional(),
  color: HostColor.optional()
})
export type GroupDefaults = z.infer<typeof GroupDefaults>

/** Thông tin host gửi cho renderer — KHÔNG có secret. */
/** SSH (mặc định), Telnet hoặc cổng Serial (console thiết bị mạng). */
export const HostProtocol = z.enum(['ssh', 'telnet', 'serial'])
export type HostProtocol = z.infer<typeof HostProtocol>

export const HostSummary = z.object({
  id: z.string(),
  groupId: z.string().nullable(),
  label: z.string(),
  hostname: z.string(),
  /** null = kế thừa từ nhóm (không có thì 22). */
  port: z.number().int().nullable(),
  /** '' = kế thừa từ nhóm. */
  username: z.string(),
  auth: AuthKind,
  hasPassword: z.boolean(),
  keyId: z.string().nullable(),
  /** IdentityFile lấy từ ~/.ssh/config (đường dẫn, key không nằm trong vault). */
  keyFile: z.string().nullable(),
  proxyJump: z.string().nullable(),
  jumpHostIds: z.array(z.string()),
  mode: HostMode,
  /** true = kết nối thẳng, bỏ qua jump host của nhóm. */
  direct: z.boolean(),
  /** Cho phép thuật toán cũ (thiết bị đời cũ). */
  legacyAlgorithms: z.boolean(),
  protocol: HostProtocol,
  /** Chỉ có khi protocol = 'serial'. */
  serial: SerialSettings.nullable(),
  tags: z.array(z.string()),
  color: z.enum(HOST_COLORS).nullable(),
  lastUsedAt: z.number().nullable(),
  favorite: z.boolean(),
  /** Thứ tự thủ công trong nhóm; 0 = chưa sắp (theo tên). */
  sort: z.number().int()
})
export type HostSummary = z.infer<typeof HostSummary>

export const HostInput = z.object({
  /** Không có = tạo mới. */
  id: z.string().optional(),
  /** Không có = SSH. */
  protocol: HostProtocol.optional(),
  /** Bắt buộc khi protocol = 'serial' (hostname khi đó chỉ là giá trị giữ chỗ). */
  serial: SerialSettings.optional(),
  groupId: z.string().nullable(),
  label: z
    .string()
    .trim()
    .min(1, 'A label is required')
    .max(100, 'The label is too long (max 100)'),
  hostname: Hostname,
  /** null = kế thừa từ nhóm. */
  port: Port.nullable(),
  /** '' = kế thừa từ nhóm. */
  username: Username.or(z.literal('')),
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
  /** true = bỏ qua jump host kế thừa từ nhóm. */
  direct: z.boolean().optional(),
  /** Cho phép thuật toán cũ (ssh-rsa/SHA-1, DH-SHA1, CBC) — chỉ cho thiết bị đời cũ. */
  legacyAlgorithms: z.boolean().optional(),
  tags: z
    .array(z.string().trim().min(1).max(40, 'Each tag can be at most 40 characters'))
    .max(20, 'At most 20 tags'),
  color: z.enum(HOST_COLORS).nullable()
})
export type HostInput = z.infer<typeof HostInput>

export const GroupSummary = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  sort: z.number().int(),
  defaults: GroupDefaults
})
export type GroupSummary = z.infer<typeof GroupSummary>

export const GroupInput = z.object({
  id: z.string().optional(),
  parentId: z.string().nullable(),
  name: z
    .string()
    .trim()
    .min(1, 'Enter a group name')
    .max(100, 'The group name is too long (max 100)'),
  /** undefined = giữ nguyên. */
  defaults: GroupDefaults.optional()
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
  /** Khoá duy nhất trong lần quét (MobaXterm: thư mục + tên). */
  alias: z.string(),
  /** Tên hiển thị khi nhập; không có = `alias`. */
  label: z.string().optional(),
  /** Đường dẫn nhóm (MobaXterm: thư mục bookmark) — tạo nhóm lồng nhau khi nhập. */
  group: z.array(z.string()).optional(),
  /** Tag có sẵn trong nguồn (CSV). */
  tags: z.array(z.string()).optional(),
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

/** Kết quả quét file nhập (MobaXterm.ini, CSV). */
export const FileImportScan = z.object({
  /** File đã đọc; null = không tìm thấy / người dùng huỷ chọn. */
  file: z.string().nullable(),
  candidates: z.array(ImportCandidate),
  /** Phiên không phải SSH bị bỏ qua, theo kiểu ("RDP" → 2). */
  ignored: z.record(z.string(), z.number().int()),
  /** Cột chứa bí mật đã bị bỏ qua (CSV có cột Password…). */
  secretColumns: z.array(z.string()).optional()
})
export type FileImportScan = z.infer<typeof FileImportScan>

export const MutationResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), id: z.string() }),
  z.object({ ok: z.literal(false), message: z.string() })
])
export type MutationResult = z.infer<typeof MutationResult>
