import { z } from 'zod'
import { ResolvedSessionSpec } from './stream-protocol'
import { ForwardSpec } from './forwards'
import { HostOs } from './host-os'
import { RdpViewTarget } from './rdp-viewer'

export const HostKeyCheck = z.discriminatedUnion('status', [
  z.object({ status: z.literal('match') }),
  z.object({ status: z.literal('unknown') }),
  z.object({
    status: z.literal('changed'),
    known: z.array(z.object({ keyType: z.string(), fingerprint: z.string() }))
  }),
  z.object({ status: z.literal('revoked') })
])
export type HostKeyCheck = z.infer<typeof HostKeyCheck>

const Credentials = z.object({
  password: z.string().optional(),
  privateKey: z
    .object({ data: z.string(), passphrase: z.string().optional(), label: z.string() })
    .optional()
})

/** Một jump host đã được main phân giải. */
export const Hop = z.object({
  target: z.object({ host: z.string(), port: z.number().int(), username: z.string() }),
  knownKeyTypes: z.array(z.string()),
  credentials: Credentials.optional(),
  keyFiles: z.array(z.string()).optional(),
  legacyAlgorithms: z.boolean().optional(),
  storedOnly: z.boolean().optional()
})
export type Hop = z.infer<typeof Hop>

/** Tin nhắn main → Session Host. */
export const HostRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), id: z.number().int() }),
  z.object({ type: z.literal('selfcheck'), id: z.number().int() }),
  /** Kèm đúng một MessagePort (transfer) để nối thẳng với renderer. */
  z.object({
    type: z.literal('session:open'),
    sessionId: z.uuid(),
    spec: ResolvedSessionSpec,
    /** Main bổ sung cho session SSH. */
    ssh: z
      .object({
        /** Loại host key đã biết — ưu tiên khi thương lượng. */
        knownKeyTypes: z.array(z.string()),
        /** Thông tin xác thực đã lưu (giải mã từ vault). */
        credentials: Credentials.optional(),
        /** IdentityFile từ ~/.ssh/config. */
        keyFiles: z.array(z.string()).optional(),
        /** Cho phép thuật toán cũ (thiết bị đời cũ) cho đích cuối. */
        legacyAlgorithms: z.boolean().optional(),
        /** Chỉ dùng thông tin đã lưu (host chọn Password / SSH key) — không thử agent, key mặc định. */
        storedOnly: z.boolean().optional(),
        /** ProxyJump: các chặng trung gian theo thứ tự. */
        jumps: z.array(Hop).max(8).optional(),
        /** Forward tự bật ngay khi kết nối xong. */
        autoForwards: z.array(ForwardSpec).max(64).optional(),
        /** Tên phiên tmux để gắn vào thay cho shell thường (server không có tmux → shell thường). */
        tmux: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .optional(),
        /** Dò hệ điều hành server sau khi kết nối (host đã lưu). */
        detectOs: z.boolean().optional()
      })
      .optional(),
    /** Ghi log phiên ra file — đường dẫn do main đặt theo cài đặt. */
    log: z
      .object({
        path: z.string().min(1).max(4096),
        stripAnsi: z.boolean(),
        header: z.string().max(2048)
      })
      .optional()
  }),
  z.object({
    type: z.literal('hostkey:result'),
    requestId: z.number().int(),
    result: HostKeyCheck
  }),
  z.object({ type: z.literal('session:close'), sessionId: z.uuid() }),
  /** Module đang bật (ADR-014) — gửi lúc khởi động và mỗi khi đổi. */
  z.object({
    type: z.literal('modules:enabled'),
    ids: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(100)
  }),
  /** Trả lời `module:request` của Session Host. */
  z.object({
    type: z.literal('module:response'),
    requestId: z.number().int(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional()
  }),
  z.object({
    type: z.literal('module:grant-result'),
    requestId: z.number().int(),
    allowed: z.boolean()
  }),
  /** Remote Desktop trong tab: dò chứng chỉ TLS của server (trả `rdp:result`). */
  z.object({ type: z.literal('rdp:probe'), id: z.number().int(), target: RdpViewTarget }),
  /** Remote Desktop trong tab: cấp token proxy RDCleanPath cho đích + dấu chứng chỉ đã tin. */
  z.object({
    type: z.literal('rdp:open'),
    id: z.number().int(),
    target: RdpViewTarget,
    pin: z.string().max(128)
  }),
  /** Chỉ dùng trong dev/E2E để kiểm tra cơ chế tự phục hồi. */
  z.object({ type: z.literal('crash') })
])
export type HostRequest = z.infer<typeof HostRequest>

export const NativeModuleStatus = z.object({
  name: z.string(),
  process: z.enum(['main', 'session-host']),
  ok: z.boolean(),
  detail: z.string()
})
export type NativeModuleStatus = z.infer<typeof NativeModuleStatus>

/** Tin nhắn Session Host → main. */
export const HostEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), pid: z.number().int() }),
  z.object({ type: z.literal('pong'), id: z.number().int() }),
  z.object({
    type: z.literal('selfcheck:result'),
    id: z.number().int(),
    modules: z.array(NativeModuleStatus)
  }),
  z.object({
    type: z.literal('hostkey:check'),
    requestId: z.number().int(),
    host: z.string(),
    port: z.number().int(),
    key: z.base64()
  }),
  /** Người dùng đã xác nhận tin host key này. */
  z.object({
    type: z.literal('hostkey:trust'),
    host: z.string(),
    port: z.number().int(),
    key: z.base64()
  }),
  /**
   * Phần Session Host của module hỏi phần main của CHÍNH module đó (`ctx.fromMain`) — ví dụ
   * kubeconfig đã import (mã hoá trong vault): đi thẳng main → Session Host, không qua renderer.
   */
  z.object({
    type: z.literal('module:request'),
    requestId: z.number().int(),
    module: z.string().max(40),
    name: z.string().max(64),
    params: z.unknown()
  }),
  /** Module muốn chạy chương trình trên máy → main hỏi người dùng (hoặc dùng lựa chọn đã nhớ). */
  z.object({
    type: z.literal('module:grant'),
    requestId: z.number().int(),
    module: z.string().max(40),
    binary: z.string().max(64),
    path: z.string().max(4096),
    sha256: z.string().regex(/^[0-9a-f]{64}$/)
  }),
  /** Đã nhận ra hệ điều hành server của phiên SSH (main lưu vào host của phiên). */
  z.object({ type: z.literal('session:os'), sessionId: z.uuid(), os: HostOs }),
  /** Trả lời `rdp:probe` / `rdp:open`. */
  z.object({
    type: z.literal('rdp:result'),
    id: z.number().int(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional()
  }),
  z.object({
    type: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string()
  })
])
export type HostEvent = z.infer<typeof HostEvent>
