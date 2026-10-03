/**
 * DER tối thiểu cho RDCleanPath (ASN.1 — SEQUENCE, tag ngữ cảnh EXPLICIT, INTEGER không dấu,
 * UTF8String, OCTET STRING). Chỉ đủ cho đúng PDU này; không phải bộ giải ASN.1 tổng quát.
 */

export const TAG_INTEGER = 0x02
export const TAG_OCTET_STRING = 0x04
export const TAG_UTF8_STRING = 0x0c
export const TAG_SEQUENCE = 0x30
/** Tag ngữ cảnh dạng constructed: [n] EXPLICIT = 0xA0 | n (n < 31). */
export const contextTag = (n: number): number => 0xa0 | n

export class DerError extends Error {}

/** Header vượt giới hạn này coi như PDU hỏng (RDCleanPath thật chỉ vài chục KB — chuỗi chứng chỉ). */
const MAX_LENGTH = 16 * 1024 * 1024

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export function tlv(tag: number, value: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value])
}

/** INTEGER không âm, dạng tối giản (thêm 0x00 khi bit cao của byte đầu là 1). */
export function encodeUnsigned(value: number | bigint): Buffer {
  let n = BigInt(value)
  if (n < 0n) throw new DerError('negative integer')
  const bytes: number[] = []
  do {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  } while (n > 0n)
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0)
  return tlv(TAG_INTEGER, Buffer.from(bytes))
}

export const encodeUtf8 = (value: string): Buffer =>
  tlv(TAG_UTF8_STRING, Buffer.from(value, 'utf8'))
export const encodeOctets = (value: Uint8Array): Buffer => tlv(TAG_OCTET_STRING, value)
export const explicit = (n: number, inner: Buffer): Buffer => tlv(contextTag(n), inner)
export const sequence = (items: readonly Buffer[]): Buffer =>
  tlv(TAG_SEQUENCE, Buffer.concat(items))

export interface Header {
  tag: number
  /** Độ dài phần header (tag + length). */
  headerLength: number
  length: number
}

/** Đọc header; null = chưa đủ byte. Ném DerError khi dạng không hợp lệ. */
export function readHeader(buf: Uint8Array, offset = 0): Header | null {
  if (buf.length < offset + 2) return null
  const tag = buf[offset] ?? 0
  // Tag dạng dài (số tag ≥ 31) không dùng trong RDCleanPath.
  if ((tag & 0x1f) === 0x1f) throw new DerError('high tag number form')
  const first = buf[offset + 1] ?? 0
  if (first < 0x80) return { tag, headerLength: 2, length: first }
  const count = first & 0x7f
  if (count === 0) throw new DerError('indefinite length')
  if (count > 4) throw new DerError('length too large')
  if (buf.length < offset + 2 + count) return null
  let length = 0
  for (let i = 0; i < count; i++) length = length * 256 + (buf[offset + 2 + i] ?? 0)
  // DER bắt buộc dạng ngắn nhất.
  if (length < 0x80 || (count > 1 && buf[offset + 2] === 0))
    throw new DerError('non-minimal length')
  if (length > MAX_LENGTH) throw new DerError('length too large')
  return { tag, headerLength: 2 + count, length }
}

export interface Element {
  tag: number
  value: Buffer
}

/** Tách các phần tử liên tiếp trong `buf` (toàn bộ phải đúng biên). */
export function readElements(buf: Buffer): Element[] {
  const out: Element[] = []
  let offset = 0
  while (offset < buf.length) {
    const header = readHeader(buf, offset)
    if (!header) throw new DerError('truncated element')
    const start = offset + header.headerLength
    const end = start + header.length
    if (end > buf.length) throw new DerError('truncated element')
    out.push({ tag: header.tag, value: buf.subarray(start, end) })
    offset = end
  }
  return out
}

/** Một phần tử duy nhất, đúng tag. */
export function readSingle(buf: Buffer, tag: number): Buffer {
  const elements = readElements(buf)
  const only = elements[0]
  if (elements.length !== 1 || !only || only.tag !== tag)
    throw new DerError(`expected tag 0x${tag.toString(16)}`)
  return only.value
}

export function decodeUnsigned(value: Buffer, max: number): number {
  if (value.length === 0) throw new DerError('empty integer')
  if ((value[0] ?? 0) & 0x80) throw new DerError('negative integer')
  if (value.length > 1 && value[0] === 0 && !((value[1] ?? 0) & 0x80))
    throw new DerError('non-minimal integer')
  if (value.length > 7) throw new DerError('integer too large')
  let n = 0
  for (const b of value) n = n * 256 + b
  if (n > max) throw new DerError('integer out of range')
  return n
}

export function decodeUtf8(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value)
}
