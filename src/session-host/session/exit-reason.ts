import type { ExitReason } from '@shared/stream-protocol'

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE'
])

/** Phân loại lỗi khi MỞ kết nối SSH thất bại. */
export function classifyConnectError(error: unknown): ExitReason {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return 'network'
  const message = error instanceof Error ? error.message : String(error)
  if (/authentication methods failed/i.test(message)) return 'auth'
  if (/host denied|verification failed|host key/i.test(message)) return 'hostkey'
  if (/timed? ?out|handshake|keepalive|closed the connection/i.test(message)) return 'network'
  return 'failed'
}
