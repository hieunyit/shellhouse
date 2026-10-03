import type { Duplex } from 'node:stream'

/**
 * X.224 (ISO 8073 lớp 0) bọc trong TPKT (RFC 1006) — chỉ phần bắt tay đầu phiên RDP
 * ([MS-RDPBCGR] 2.2.1.1 / 2.2.1.2): Connection Request từ client, Connection Confirm từ server.
 */

const TPKT_VERSION = 3
const X224_CR = 0xe0
const X224_CC = 0xd0
const NEG_REQ = 0x01
const NEG_RSP = 0x02
const NEG_FAILURE = 0x03

export const PROTOCOL_RDP = 0
export const PROTOCOL_SSL = 0x1
export const PROTOCOL_HYBRID = 0x2
export const PROTOCOL_HYBRID_EX = 0x8

/** TPKT dài nhất chấp nhận trong bắt tay (Connection Confirm thật chỉ 19 byte). */
const MAX_HANDSHAKE_TPKT = 4096

/** Độ dài TPKT đầu `buf` (null = chưa đủ 4 byte). Ném lỗi khi không phải TPKT. */
export function tpktLength(buf: Uint8Array): number | null {
  if (buf.length < 4) return null
  if (buf[0] !== TPKT_VERSION) throw new Error('not a TPKT packet')
  const length = ((buf[2] ?? 0) << 8) | (buf[3] ?? 0)
  if (length < 7 || length > MAX_HANDSHAKE_TPKT) throw new Error('bad TPKT length')
  return length
}

/** Connection Request hợp lệ: đúng một TPKT, mã CR. Proxy không chuyển gì khác lên server. */
export function isConnectionRequest(buf: Uint8Array): boolean {
  try {
    const length = tpktLength(buf)
    if (length !== buf.length) return false
    const li = buf[4] ?? 0
    return li + 5 === length && ((buf[5] ?? 0) & 0xf0) === X224_CR
  } catch {
    return false
  }
}

/** Connection Request chuẩn (không cookie): xin TLS / CredSSP — dùng khi dò chứng chỉ server. */
export function connectionRequest(
  protocols = PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX
): Buffer {
  const buf = Buffer.alloc(19)
  buf.writeUInt8(TPKT_VERSION, 0)
  buf.writeUInt16BE(19, 2)
  buf.writeUInt8(14, 4) // LI: số byte sau trường này
  buf.writeUInt8(X224_CR, 5)
  // dst-ref, src-ref, class = 0
  buf.writeUInt8(NEG_REQ, 11)
  buf.writeUInt8(0, 12)
  buf.writeUInt16LE(8, 13)
  buf.writeUInt32LE(protocols, 15)
  return buf
}

export type ConfirmResult =
  | { kind: 'selected'; protocol: number }
  | { kind: 'failure'; code: number }
  /** Server cũ không gửi RDP_NEG_RSP = chỉ có RDP security chuẩn. */
  | { kind: 'legacy' }

export function parseConnectionConfirm(buf: Uint8Array): ConfirmResult {
  const length = tpktLength(buf)
  if (length === null || length !== buf.length) throw new Error('truncated X.224 packet')
  const li = buf[4] ?? 0
  if (li + 5 !== length || ((buf[5] ?? 0) & 0xf0) !== X224_CC)
    throw new Error('not an X.224 Connection Confirm')
  if (length < 19) return { kind: 'legacy' }
  const type = buf[11]
  const value = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).readUInt32LE(15)
  if (type === NEG_RSP) return { kind: 'selected', protocol: value }
  if (type === NEG_FAILURE) return { kind: 'failure', code: value }
  throw new Error('unknown negotiation response')
}

/**
 * Đọc đúng một TPKT từ socket (bắt tay — trước TLS). Byte thừa sau TPKT (server không gửi gì trước
 * khi client bắt đầu TLS) coi là lỗi giao thức.
 */
export function readTpkt(socket: Duplex, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const done = (error: Error | null, value?: Buffer): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (error) reject(error)
      else {
        // Dừng đọc: TLS sẽ gắn vào socket ngay sau đây, không để mất byte nào.
        socket.pause()
        resolve(value ?? Buffer.alloc(0))
      }
    }
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      try {
        const length = tpktLength(buf)
        if (length === null || buf.length < length) return
        if (buf.length > length) {
          done(new Error('unexpected data after the X.224 Connection Confirm'))
          return
        }
        done(null, buf)
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const onError = (error: Error): void => {
      done(error)
    }
    const onClose = (): void => {
      done(new Error('the server closed the connection'))
    }
    const timer = setTimeout(() => {
      done(new Error('timed out waiting for the X.224 Connection Confirm'))
    }, timeoutMs)
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.resume()
  })
}
