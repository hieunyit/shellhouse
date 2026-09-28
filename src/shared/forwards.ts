import { z } from 'zod'
import { Hostname } from './hosts'

export const ForwardKind = z.enum(['L', 'R', 'D'])
export type ForwardKind = z.infer<typeof ForwardKind>

/** Địa chỉ bind: IP hoặc tên (localhost, 0.0.0.0, ::1...). */
const BindAddr = Hostname

/**
 * - L (-L): mở cổng trên máy này → đi qua SSH tới dest (nhìn từ server)
 * - R (-R): server mở cổng → đi ngược về dest (nhìn từ máy này)
 * - D (-D): SOCKS5 proxy trên máy này, đích do ứng dụng chọn
 */
export const ForwardSpec = z
  .object({
    id: z.string().min(1).max(64),
    kind: ForwardKind,
    bindAddr: BindAddr,
    /** 0 = để hệ điều hành / server tự chọn. */
    bindPort: z.number().int().min(0).max(65535),
    destHost: Hostname.nullable(),
    destPort: z.number().int().min(1).max(65535).nullable()
  })
  .refine((f) => f.kind === 'D' || (f.destHost !== null && f.destPort !== null), {
    message: 'Local and remote forwards need a destination host and port'
  })
export type ForwardSpec = z.infer<typeof ForwardSpec>

export const ForwardState = z.enum(['starting', 'active', 'error', 'stopped'])
export type ForwardState = z.infer<typeof ForwardState>

export interface ForwardStatus {
  spec: ForwardSpec
  state: ForwardState
  /** Cổng thực sự đang nghe (khác bindPort khi bindPort = 0). */
  actualPort: number | null
  activeConnections: number
  totalConnections: number
  bytesIn: number
  bytesOut: number
  error: string | null
}

/** Forward lưu trong DB, gắn với một host. */
export const SavedForward = z.object({
  id: z.string(),
  hostId: z.string(),
  kind: ForwardKind,
  bindAddr: z.string(),
  bindPort: z.number().int(),
  destHost: z.string().nullable(),
  destPort: z.number().int().nullable(),
  autoStart: z.boolean()
})
export type SavedForward = z.infer<typeof SavedForward>

export const SavedForwardInput = z
  .object({
    id: z.string().max(64).optional(),
    hostId: z.string().max(64),
    kind: ForwardKind,
    bindAddr: Hostname,
    bindPort: z.number().int().min(0).max(65535),
    destHost: Hostname.nullable(),
    destPort: z.number().int().min(1).max(65535).nullable(),
    autoStart: z.boolean()
  })
  .refine((f) => f.kind === 'D' || (f.destHost !== null && f.destPort !== null), {
    message: 'Local and remote forwards need a destination host and port'
  })
export type SavedForwardInput = z.infer<typeof SavedForwardInput>

export function toForwardSpec(f: SavedForward): ForwardSpec {
  return {
    id: f.id,
    kind: f.kind,
    bindAddr: f.bindAddr,
    bindPort: f.bindPort,
    destHost: f.destHost,
    destPort: f.destPort
  }
}

export function isLoopback(addr: string): boolean {
  return addr === 'localhost' || addr === '::1' || /^127\./.test(addr)
}

export function describeForward(
  f: Pick<ForwardSpec, 'kind' | 'bindAddr' | 'bindPort' | 'destHost' | 'destPort'>,
  actualPort?: number | null
): string {
  const port = actualPort ?? f.bindPort
  const bind = `${f.bindAddr.includes(':') ? `[${f.bindAddr}]` : f.bindAddr}:${port}`
  if (f.kind === 'D') return `SOCKS5 ${bind}`
  const dest = `${f.destHost ?? '?'}:${f.destPort ?? '?'}`
  return f.kind === 'L' ? `${bind} → ${dest}` : `server ${bind} → ${dest}`
}
