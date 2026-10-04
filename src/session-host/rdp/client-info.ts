/**
 * Client Info PDU ([MS-RDPBCGR] 2.2.1.11) đi từ IronRDP lên server qua proxy — proxy là đầu cuối TLS
 * nên thấy byte RDP gốc. Bản WASM của IronRDP không cho chỉnh cờ hiệu năng (hình nền, hiệu ứng, làm
 * mượt chữ…) hay cờ tự đăng nhập → proxy sửa tại chỗ hai trường 4 byte này. Không đổi độ dài PDU,
 * không đụng gì khác; cấu trúc không khớp đúng như mong đợi thì chuyển nguyên vẹn.
 */

/** TS_INFO_PACKET.flags */
export const INFO_AUTOLOGON = 0x0000_0008
export const INFO_UNICODE = 0x0000_0010

const TPKT_VERSION = 3
const X224_DATA = 0xf0
/** MCS Send Data Request (DomainMCSPDU 25 << 2, PER). */
const MCS_SEND_DATA_REQUEST = 0x64
const SEC_ENCRYPT = 0x0008
const SEC_INFO_PKT = 0x0040
/** clientTimeZone (TS_TIME_ZONE_INFORMATION) */
const TIME_ZONE_SIZE = 172

export interface ClientInfoPatch {
  /** Thay cờ hiệu năng (null = giữ của client). */
  performanceFlags: number | null
  /** Bật INFO_AUTOLOGON khi Client Info có mật khẩu (server không NLA như xrdp: khỏi hộp đăng nhập riêng). */
  autologon: boolean
}

export interface ClientInfoFields {
  /** Vị trí trường flags / performanceFlags trong buffer. */
  flagsAt: number
  flags: number
  hasPassword: boolean
  performanceAt: number | null
  performanceFlags: number | null
}

/** Tìm Client Info PDU đầu `buf` (một TPKT trọn vẹn). null = không phải. */
export function findClientInfo(buf: Uint8Array): ClientInfoFields | null {
  if (buf.length < 4 || buf[0] !== TPKT_VERSION) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const total = view.getUint16(2)
  if (total !== buf.length || total < 12) return null
  // X.224 Data TPDU: LI = 2, mã 0xF0, EOT.
  if (buf[4] !== 2 || buf[5] !== X224_DATA) return null
  let p = 7
  if (buf[p] !== MCS_SEND_DATA_REQUEST) return null
  p += 1 + 2 + 2 + 1 // initiator, channelId, dataPriority + segmentation
  if (p >= total) return null
  const first = buf[p] ?? 0
  let length: number
  if (first & 0x80) {
    if (p + 1 >= total) return null
    length = ((first & 0x3f) << 8) | (buf[p + 1] ?? 0)
    p += 2
  } else {
    length = first
    p += 1
  }
  if (p + length !== total || length < 4 + 18) return null
  const secFlags = view.getUint16(p, true)
  if (!(secFlags & SEC_INFO_PKT) || secFlags & SEC_ENCRYPT) return null
  p += 4
  const info = p
  const flags = view.getUint32(info + 4, true)
  const term = flags & INFO_UNICODE ? 2 : 1
  const cbDomain = view.getUint16(info + 8, true)
  const cbUserName = view.getUint16(info + 10, true)
  const cbPassword = view.getUint16(info + 12, true)
  const cbAlternateShell = view.getUint16(info + 14, true)
  const cbWorkingDir = view.getUint16(info + 16, true)
  p = info + 18
  for (const cb of [cbDomain, cbUserName, cbPassword, cbAlternateShell, cbWorkingDir])
    p += cb + term
  if (p > total) return null
  const fields: ClientInfoFields = {
    flagsAt: info + 4,
    flags,
    hasPassword: cbPassword > 0,
    performanceAt: null,
    performanceFlags: null
  }
  // TS_EXTENDED_INFO_PACKET (RDP 5.0+): address family, địa chỉ, thư mục, múi giờ, session id, cờ.
  if (p + 4 > total) return fields
  const cbAddress = view.getUint16(p + 2, true)
  p += 4 + cbAddress
  if (p + 2 > total) return fields
  const cbDir = view.getUint16(p, true)
  p += 2 + cbDir + TIME_ZONE_SIZE + 4
  if (p + 4 > total) return fields
  fields.performanceAt = p
  fields.performanceFlags = view.getUint32(p, true)
  return fields
}

/** Sửa Client Info tại chỗ (trên bản sao); trả buffer mới hoặc null khi không phải Client Info. */
export function patchClientInfo(buf: Buffer, patch: ClientInfoPatch): Buffer | null {
  const fields = findClientInfo(buf)
  if (!fields) return null
  const out = Buffer.from(buf)
  if (patch.autologon && fields.hasPassword)
    out.writeUInt32LE((fields.flags | INFO_AUTOLOGON) >>> 0, fields.flagsAt)
  if (patch.performanceFlags !== null && fields.performanceAt !== null)
    out.writeUInt32LE(patch.performanceFlags >>> 0, fields.performanceAt)
  return out
}

/**
 * Bộ lọc luồng client → server: sửa Client Info PDU đầu tiên rồi thôi. IronRDP gửi mỗi PDU trong
 * một message WebSocket nên xét từng message; quá số message bắt tay mà chưa thấy thì bỏ cuộc.
 */
export class ClientInfoRewriter {
  private remaining = 64
  /** Đã sửa (hoặc bỏ cuộc) — từ đây chỉ chuyển thẳng. */
  done = false
  found: ClientInfoFields | null = null

  constructor(private readonly patch: ClientInfoPatch) {}

  process(chunk: Buffer): Buffer {
    if (this.done) return chunk
    if (--this.remaining <= 0) this.done = true
    const out = patchClientInfo(chunk, this.patch)
    if (!out) return chunk
    this.found = findClientInfo(chunk)
    this.done = true
    return out
  }
}
