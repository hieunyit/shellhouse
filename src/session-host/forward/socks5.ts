/**
 * Phân tích SOCKS5 (RFC 1928) — chỉ CONNECT, không xác thực (proxy chỉ nghe loopback mặc định).
 * Hàm thuần: nhận buffer đã gom, trả về "cần thêm dữ liệu" / kết quả / lỗi. Không bao giờ throw.
 */

export const SOCKS_VERSION = 0x05
export const METHOD_NO_AUTH = 0x00
export const METHOD_NONE_ACCEPTABLE = 0xff

export const REPLY = {
  succeeded: 0x00,
  generalFailure: 0x01,
  networkUnreachable: 0x03,
  hostUnreachable: 0x04,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08
} as const

/** Không có yêu cầu hợp lệ nào dài hơn thế này (domain tối đa 255 byte). */
export const MAX_HANDSHAKE_BYTES = 4 + 1 + 255 + 2 + 257

export type GreetingResult =
  | { status: 'more' }
  | { status: 'ok'; consumed: number; noAuthOffered: boolean }
  | { status: 'error'; reason: string }

export function parseGreeting(buf: Uint8Array): GreetingResult {
  if (buf.length < 2) return { status: 'more' }
  if (buf[0] !== SOCKS_VERSION)
    return { status: 'error', reason: `Not SOCKS5 (version ${buf[0] ?? '?'})` }
  const count = buf[1] ?? 0
  if (count === 0) return { status: 'error', reason: 'No authentication methods offered' }
  if (buf.length < 2 + count) return { status: 'more' }
  const methods = buf.subarray(2, 2 + count)
  return { status: 'ok', consumed: 2 + count, noAuthOffered: methods.includes(METHOD_NO_AUTH) }
}

export type RequestResult =
  | { status: 'more' }
  | { status: 'ok'; consumed: number; host: string; port: number }
  | { status: 'error'; reason: string; reply: number }

function ipv6ToString(bytes: Uint8Array): string {
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2)
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16))
  return groups.join(':')
}

export function parseRequest(buf: Uint8Array): RequestResult {
  if (buf.length < 4) return { status: 'more' }
  if (buf[0] !== SOCKS_VERSION) {
    return { status: 'error', reason: 'Wrong version in request', reply: REPLY.generalFailure }
  }
  if (buf[1] !== 0x01) {
    return {
      status: 'error',
      reason: `Command ${buf[1] ?? '?'} is not supported (CONNECT only)`,
      reply: REPLY.commandNotSupported
    }
  }
  const atyp = buf[3]
  let host: string
  let offset: number
  if (atyp === 0x01) {
    if (buf.length < 4 + 4 + 2) return { status: 'more' }
    host = Array.from(buf.subarray(4, 8)).join('.')
    offset = 8
  } else if (atyp === 0x03) {
    if (buf.length < 5) return { status: 'more' }
    const len = buf[4] ?? 0
    if (len === 0)
      return { status: 'error', reason: 'Empty domain name', reply: REPLY.generalFailure }
    if (buf.length < 5 + len + 2) return { status: 'more' }
    host = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(5, 5 + len))
    // Chỉ chấp nhận ký tự hợp lệ của hostname — không để rác đi tiếp.
    if (!/^[A-Za-z0-9.-]+$/.test(host)) {
      return { status: 'error', reason: 'Invalid domain name', reply: REPLY.hostUnreachable }
    }
    offset = 5 + len
  } else if (atyp === 0x04) {
    if (buf.length < 4 + 16 + 2) return { status: 'more' }
    host = ipv6ToString(buf.subarray(4, 20))
    offset = 20
  } else {
    return {
      status: 'error',
      reason: `Address type ${atyp ?? '?'} is not supported`,
      reply: REPLY.addressTypeNotSupported
    }
  }
  const port = ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0)
  if (port === 0) return { status: 'error', reason: 'Port 0', reply: REPLY.generalFailure }
  return { status: 'ok', consumed: offset + 2, host, port }
}

/** Trả lời yêu cầu: BND.ADDR = 0.0.0.0:0 (client không cần). */
export function replyBytes(code: number): Uint8Array {
  return Uint8Array.from([SOCKS_VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}
