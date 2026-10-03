import { z } from 'zod'

/**
 * Trình xem Remote Desktop nhúng trong tab (IronRDP WASM trong renderer + proxy RDCleanPath trong
 * Session Host). Hợp đồng IPC renderer ↔ main ↔ Session Host.
 *
 * Luồng: prepare (thông tin host) → [mở phiên SSH nếu host đi qua SSH host] → probe (chứng chỉ TLS
 * của server, TOFU như known_hosts) → [người dùng tin chứng chỉ] → open (token dùng một lần cho
 * proxy) → WASM kết nối ws://127.0.0.1:<cổng>.
 */

export const RdpViewTarget = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  /** Đi qua kết nối SSH của phiên này (direct-tcpip); không có = TCP thẳng. */
  viaSessionId: z.uuid().optional()
})
export type RdpViewTarget = z.infer<typeof RdpViewTarget>

export const RdpCertInfo = z.object({
  /** SHA-256 của chứng chỉ (DER) — dạng AA:BB:… */
  fingerprint: z.string().regex(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/),
  subject: z.string().max(2048),
  issuer: z.string().max(2048),
  validFrom: z.string().max(64),
  validTo: z.string().max(64),
  selfSigned: z.boolean()
})
export type RdpCertInfo = z.infer<typeof RdpCertInfo>

export const RdpViewPrepare = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    label: z.string(),
    /** host:port để hiển thị. */
    address: z.string(),
    username: z.string(),
    domain: z.string(),
    /** Có mật khẩu lưu trong vault. */
    hasPassword: z.boolean(),
    /** SSH host trung gian. */
    via: z.object({ id: z.string(), label: z.string() }).nullable(),
    clipboard: z.boolean(),
    dynamicResolution: z.boolean(),
    width: z.number().int(),
    height: z.number().int()
  }),
  z.object({
    ok: z.literal(false),
    message: z.string(),
    /** Host dùng tính năng trình xem nhúng không hỗ trợ (RD Gateway) → gợi ý mở bằng client ngoài. */
    external: z.boolean()
  })
])
export type RdpViewPrepare = z.infer<typeof RdpViewPrepare>

export const RdpViewProbeRequest = z.object({
  hostId: z.string().min(1).max(64),
  viaSessionId: z.uuid().optional()
})
export type RdpViewProbeRequest = z.infer<typeof RdpViewProbeRequest>

export const RdpViewProbeResult = z.object({
  cert: RdpCertInfo,
  /** trusted = khớp chứng chỉ đã tin; unknown = lần đầu; changed = khác chứng chỉ đã tin. */
  status: z.enum(['trusted', 'unknown', 'changed']),
  known: z.string().nullable()
})
export type RdpViewProbeResult = z.infer<typeof RdpViewProbeResult>

export const RdpViewOpenRequest = z.object({
  hostId: z.string().min(1).max(64),
  viaSessionId: z.uuid().optional(),
  /** Gõ lúc kết nối (host chưa lưu). Không có = dùng thông tin đã lưu. */
  username: z.string().max(256).optional(),
  domain: z.string().max(255).optional(),
  password: z.string().max(1024).optional()
})
export type RdpViewOpenRequest = z.infer<typeof RdpViewOpenRequest>

export const RdpViewOpenResult = z.object({
  /** ws://127.0.0.1:<cổng>/… — proxy RDCleanPath trong Session Host. */
  proxyAddress: z.string(),
  /** Token dùng một lần, hết hạn sau vài chục giây. */
  authToken: z.string(),
  /** host:port của server (IronRDP dùng làm tên server cho CredSSP). */
  destination: z.string(),
  username: z.string(),
  domain: z.string(),
  password: z.string()
})
export type RdpViewOpenResult = z.infer<typeof RdpViewOpenResult>
