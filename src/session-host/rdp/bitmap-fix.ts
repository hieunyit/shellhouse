/**
 * Sửa bitmap update của server trước khi tới IronRDP (WASM).
 *
 * IronRDP 0.7 giải mã bitmap theo `width`×`height` của TS_BITMAP_DATA nhưng chép vào màn hình theo
 * kích thước khung đích (destLeft..destRight). Server được phép gửi bitmap rộng hơn khung (đệm cho
 * đủ bội số 4 pixel, cắt ở mép) — khi đó mỗi hàng lệch dần (hình vỡ thành sọc chéo) và các hàng
 * thừa ghi tràn xuống dưới; tràn khỏi đáy màn hình thì WASM panic → phiên đứng hình. xrdp gặp
 * thường xuyên (vùng thay đổi bất kỳ), Windows ở mép phải khi chiều rộng desktop không chia hết.
 *
 * Proxy (đầu cuối TLS, thấy byte RDP gốc) nới khung đích cho khớp kích thước bitmap: pixel đệm là
 * pixel thật cạnh khung trên màn hình server; khung vượt mép màn hình thì IronRDP bỏ qua (không
 * panic). Chỉ sửa tại chỗ các trường destRight / destBottom, không đổi độ dài; PDU nén hoặc chia
 * mảnh thì để nguyên. Không nhận ra cấu trúc → thôi sửa cho cả phiên, chuyển nguyên vẹn.
 */

const FASTPATH_UPDATE_BITMAP = 0x1
const FASTPATH_FRAGMENT_SINGLE = 0
const FASTPATH_COMPRESSION_USED = 0x2
const MCS_SEND_DATA_INDICATION = 0x68
const PDUTYPE_DATA = 0x7
const PDUTYPE2_UPDATE = 0x02
const UPDATETYPE_BITMAP = 0x0001
/** TS_SHAREDATAHEADER.compressedType: PACKET_COMPRESSED */
const PACKET_COMPRESSED = 0x20
/** PDU dài nhất có thể (TPKT / fast-path dùng 15–16 bit độ dài). */
const MAX_PDU = 0x10000

/** Nới khung đích các TS_BITMAP_DATA trong TS_UPDATE_BITMAP_DATA (bắt đầu từ updateType). */
export function fixBitmapUpdate(buf: Buffer, start: number, end: number): number {
  if (end - start < 4 || buf.readUInt16LE(start) !== UPDATETYPE_BITMAP) return 0
  const count = buf.readUInt16LE(start + 2)
  let p = start + 4
  let fixed = 0
  for (let i = 0; i < count; i++) {
    if (p + 18 > end) break
    const left = buf.readUInt16LE(p)
    const top = buf.readUInt16LE(p + 2)
    const right = buf.readUInt16LE(p + 4)
    const bottom = buf.readUInt16LE(p + 6)
    const width = buf.readUInt16LE(p + 8)
    const height = buf.readUInt16LE(p + 10)
    const length = buf.readUInt16LE(p + 16)
    if (right >= left && bottom >= top && width > 0 && height > 0) {
      if (right - left + 1 !== width && left + width - 1 <= 0xffff) {
        buf.writeUInt16LE(left + width - 1, p + 4)
        fixed++
      }
      if (bottom - top + 1 !== height && top + height - 1 <= 0xffff) {
        buf.writeUInt16LE(top + height - 1, p + 6)
        fixed++
      }
    }
    p += 18 + length
  }
  return fixed
}

type Header = { length: number; fastpath: boolean } | 'short' | null

function pduHeader(buf: Buffer, at: number): Header {
  if (buf.length - at < 2) return 'short'
  const b0 = buf[at] ?? 0
  if (b0 === 0x03) {
    if (buf.length - at < 4) return 'short'
    if (buf[at + 1] !== 0) return null
    const length = buf.readUInt16BE(at + 2)
    return length >= 7 ? { length, fastpath: false } : null
  }
  // fpOutputHeader: action = 0, 4 bit dành riêng = 0, không mã hoá (TLS).
  if ((b0 & 0xbf) !== 0) return null
  const b1 = buf[at + 1] ?? 0
  if (b1 & 0x80) {
    if (buf.length - at < 3) return 'short'
    const length = ((b1 & 0x7f) << 8) | (buf[at + 2] ?? 0)
    return length >= 4 ? { length, fastpath: true } : null
  }
  return b1 >= 3 ? { length: b1, fastpath: true } : null
}

function fixFastPath(buf: Buffer, start: number, end: number): number {
  let p = start + ((buf[start + 1] ?? 0) & 0x80 ? 3 : 2)
  let fixed = 0
  while (p + 3 <= end) {
    const h = buf[p] ?? 0
    p += 1
    const compressed = ((h >> 6) & 0x3) === FASTPATH_COMPRESSION_USED
    if (compressed) p += 1
    if (p + 2 > end) break
    const size = buf.readUInt16LE(p)
    p += 2
    if (p + size > end) break
    if (
      (h & 0x0f) === FASTPATH_UPDATE_BITMAP &&
      ((h >> 4) & 0x3) === FASTPATH_FRAGMENT_SINGLE &&
      !compressed
    )
      fixed += fixBitmapUpdate(buf, p, p + size)
    p += size
  }
  return fixed
}

function fixSlowPath(buf: Buffer, start: number, end: number): number {
  // TPKT (4) → X.224 Data (3) → MCS Send Data Indication → Share Control → Share Data header.
  let p = start + 4
  if (buf[p] !== 0x02 || buf[p + 1] !== 0xf0 || buf[p + 3] !== MCS_SEND_DATA_INDICATION) return 0
  p += 3 + 1 + 2 + 2 + 1
  if (p >= end) return 0
  p += (buf[p] ?? 0) & 0x80 ? 2 : 1
  if (p + 6 + 12 + 2 > end) return 0
  if ((buf.readUInt16LE(p + 2) & 0x0f) !== PDUTYPE_DATA) return 0
  const data = p + 6
  if (buf[data + 8] !== PDUTYPE2_UPDATE || (buf[data + 9] ?? 0) & PACKET_COMPRESSED) return 0
  return fixBitmapUpdate(buf, data + 12, end)
}

/**
 * Bộ lọc luồng server → client. Chờ tới PDU TPKT đầu tiên (sau CredSSP), từ đó tách PDU, sửa và
 * trả về các PDU trọn vẹn; phần PDU dở dang giữ lại tới lượt sau (IronRDP cũng phải chờ đủ PDU
 * mới giải mã được nên không thêm độ trễ).
 */
export class BitmapFixer {
  private state: 'wait' | 'framing' | 'off' = 'wait'
  private tail: Buffer | null = null
  /** Số khung đã nới (log khi đóng phiên). */
  fixed = 0

  get active(): boolean {
    return this.state !== 'off'
  }

  push(chunk: Buffer): Buffer {
    if (this.state === 'off') return this.release(chunk)
    if (this.state === 'wait') {
      if (chunk[0] !== 0x03 || chunk[1] !== 0x00) return chunk
      this.state = 'framing'
    }
    const buf = this.tail ? Buffer.concat([this.tail, chunk]) : chunk
    this.tail = null
    let p = 0
    while (p < buf.length) {
      const header = pduHeader(buf, p)
      if (header === null) {
        // Không còn khớp cấu trúc → chuyển nguyên vẹn từ đây.
        this.state = 'off'
        return buf
      }
      if (header === 'short' || p + header.length > buf.length) {
        if (buf.length - p > MAX_PDU) {
          this.state = 'off'
          return buf
        }
        this.tail = Buffer.from(buf.subarray(p))
        return buf.subarray(0, p)
      }
      const end = p + header.length
      this.fixed += header.fastpath ? fixFastPath(buf, p, end) : fixSlowPath(buf, p, end)
      p = end
    }
    return buf
  }

  /** Phần đang giữ (đóng phiên / thôi sửa). */
  flush(): Buffer | null {
    const tail = this.tail
    this.tail = null
    return tail
  }

  private release(chunk: Buffer): Buffer {
    const tail = this.flush()
    return tail ? Buffer.concat([tail, chunk]) : chunk
  }
}
