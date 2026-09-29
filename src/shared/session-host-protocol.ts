import { z } from 'zod'
import { ResolvedSessionSpec } from './stream-protocol'
import { ForwardSpec } from './forwards'

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
  legacyAlgorithms: z.boolean().optional()
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
        /** ProxyJump: các chặng trung gian theo thứ tự. */
        jumps: z.array(Hop).max(8).optional(),
        /** Forward tự bật ngay khi kết nối xong. */
        autoForwards: z.array(ForwardSpec).max(64).optional()
      })
      .optional()
  }),
  z.object({
    type: z.literal('hostkey:result'),
    requestId: z.number().int(),
    result: HostKeyCheck
  }),
  z.object({ type: z.literal('session:close'), sessionId: z.uuid() }),
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
  z.object({
    type: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string()
  })
])
export type HostEvent = z.infer<typeof HostEvent>
