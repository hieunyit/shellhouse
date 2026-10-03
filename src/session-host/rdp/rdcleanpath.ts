import {
  DerError,
  TAG_INTEGER,
  TAG_OCTET_STRING,
  TAG_SEQUENCE,
  TAG_UTF8_STRING,
  contextTag,
  decodeUnsigned,
  decodeUtf8,
  encodeOctets,
  encodeUnsigned,
  encodeUtf8,
  explicit,
  readElements,
  readHeader,
  readSingle,
  sequence
} from './der'

/**
 * RDCleanPath — giao thức giữa client RDP chạy trong trình duyệt (IronRDP WASM) và proxy:
 * client gửi X.224 Connection Request qua WebSocket; proxy mở TCP tới server, chuyển X.224, làm
 * TLS với server rồi trả X.224 Connection Confirm + chuỗi chứng chỉ server. Sau đó proxy chỉ chuyển
 * byte (WebSocket ↔ TLS). Định nghĩa theo crate `ironrdp-rdcleanpath` (ASN.1 DER, tag EXPLICIT).
 */

export const RDCLEANPATH_VERSION = 3390
export const GENERAL_ERROR_CODE = 1
export const NEGOTIATION_ERROR_CODE = 2

export interface RDCleanPathError {
  errorCode: number
  httpStatusCode?: number
  wsaLastError?: number
  tlsAlertCode?: number
}

export interface RDCleanPathPdu {
  version: number
  error?: RDCleanPathError
  destination?: string
  proxyAuth?: string
  serverAuth?: string
  preconnectionBlob?: string
  x224ConnectionPdu?: Buffer
  serverCertChain?: Buffer[]
  serverAddr?: string
}

function encodeError(e: RDCleanPathError): Buffer {
  const items = [explicit(0, encodeUnsigned(e.errorCode))]
  if (e.httpStatusCode !== undefined) items.push(explicit(1, encodeUnsigned(e.httpStatusCode)))
  if (e.wsaLastError !== undefined) items.push(explicit(2, encodeUnsigned(e.wsaLastError)))
  if (e.tlsAlertCode !== undefined) items.push(explicit(3, encodeUnsigned(e.tlsAlertCode)))
  return sequence(items)
}

export function encodePdu(pdu: RDCleanPathPdu): Buffer {
  const items = [explicit(0, encodeUnsigned(pdu.version))]
  if (pdu.error) items.push(explicit(1, encodeError(pdu.error)))
  if (pdu.destination !== undefined) items.push(explicit(2, encodeUtf8(pdu.destination)))
  if (pdu.proxyAuth !== undefined) items.push(explicit(3, encodeUtf8(pdu.proxyAuth)))
  if (pdu.serverAuth !== undefined) items.push(explicit(4, encodeUtf8(pdu.serverAuth)))
  if (pdu.preconnectionBlob !== undefined)
    items.push(explicit(5, encodeUtf8(pdu.preconnectionBlob)))
  if (pdu.x224ConnectionPdu) items.push(explicit(6, encodeOctets(pdu.x224ConnectionPdu)))
  if (pdu.serverCertChain)
    items.push(explicit(7, sequence(pdu.serverCertChain.map((c) => encodeOctets(c)))))
  if (pdu.serverAddr !== undefined) items.push(explicit(9, encodeUtf8(pdu.serverAddr)))
  return sequence(items)
}

/** Các trường [n] của một SEQUENCE: tăng dần, không trùng; tag lạ (bản sau) bỏ qua. */
function fields(body: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>()
  let last = -1
  for (const el of readElements(body)) {
    if ((el.tag & 0xe0) !== 0xa0) throw new DerError('expected a context-specific field')
    const n = el.tag & 0x1f
    if (n <= last) throw new DerError('fields out of order')
    last = n
    out.set(n, el.value)
  }
  return out
}

const u16 = (v: Buffer): number => decodeUnsigned(readSingle(v, TAG_INTEGER), 0xffff)
const str = (v: Buffer): string => decodeUtf8(readSingle(v, TAG_UTF8_STRING))

function decodeError(value: Buffer): RDCleanPathError {
  const f = fields(readSingle(value, TAG_SEQUENCE))
  const code = f.get(0)
  if (!code) throw new DerError('error_code is missing')
  const e: RDCleanPathError = { errorCode: u16(code) }
  const http = f.get(1)
  const wsa = f.get(2)
  const tls = f.get(3)
  if (http) e.httpStatusCode = u16(http)
  if (wsa) e.wsaLastError = u16(wsa)
  if (tls) e.tlsAlertCode = decodeUnsigned(readSingle(tls, TAG_INTEGER), 0xff)
  return e
}

/** Giải một PDU hoàn chỉnh (đúng `buf.length` byte). Ném DerError khi sai dạng. */
export function decodePdu(buf: Buffer): RDCleanPathPdu {
  const f = fields(readSingle(buf, TAG_SEQUENCE))
  const version = f.get(0)
  if (!version) throw new DerError('version is missing')
  const pdu: RDCleanPathPdu = {
    version: decodeUnsigned(readSingle(version, TAG_INTEGER), Number.MAX_SAFE_INTEGER)
  }
  const error = f.get(1)
  if (error) pdu.error = decodeError(error)
  const destination = f.get(2)
  if (destination) pdu.destination = str(destination)
  const proxyAuth = f.get(3)
  if (proxyAuth) pdu.proxyAuth = str(proxyAuth)
  const serverAuth = f.get(4)
  if (serverAuth) pdu.serverAuth = str(serverAuth)
  const pcb = f.get(5)
  if (pcb) pdu.preconnectionBlob = str(pcb)
  const x224 = f.get(6)
  if (x224) pdu.x224ConnectionPdu = Buffer.from(readSingle(x224, TAG_OCTET_STRING))
  const chain = f.get(7)
  if (chain)
    pdu.serverCertChain = readElements(readSingle(chain, TAG_SEQUENCE)).map((el) => {
      if (el.tag !== TAG_OCTET_STRING) throw new DerError('expected OCTET STRING')
      return Buffer.from(el.value)
    })
  const addr = f.get(9)
  if (addr) pdu.serverAddr = str(addr)
  return pdu
}

export type Detection =
  { kind: 'detected'; totalLength: number } | { kind: 'more' } | { kind: 'failed' }

/** Như `RDCleanPathPdu::detect`: đã đủ một PDU chưa (nhìn header SEQUENCE + trường version). */
export function detectPdu(buf: Uint8Array): Detection {
  try {
    const outer = readHeader(buf, 0)
    if (!outer) return { kind: 'more' }
    if (outer.tag !== TAG_SEQUENCE) return { kind: 'failed' }
    const totalLength = outer.headerLength + outer.length
    const field = readHeader(buf, outer.headerLength)
    if (!field) return { kind: 'more' }
    if (field.tag !== contextTag(0)) return { kind: 'failed' }
    const intOffset = outer.headerLength + field.headerLength
    const int = readHeader(buf, intOffset)
    if (!int) return { kind: 'more' }
    if (int.tag !== TAG_INTEGER) return { kind: 'failed' }
    const start = intOffset + int.headerLength
    if (buf.length < start + int.length) return { kind: 'more' }
    const version = decodeUnsigned(
      Buffer.from(buf.subarray(start, start + int.length)),
      Number.MAX_SAFE_INTEGER
    )
    return version === RDCLEANPATH_VERSION ? { kind: 'detected', totalLength } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

/** Yêu cầu hợp lệ từ client (đúng phiên bản, có token + X.224). */
export interface CleanPathRequest {
  destination: string
  proxyAuth: string
  preconnectionBlob: string | null
  x224: Buffer
}

export function parseRequest(buf: Buffer): CleanPathRequest {
  const pdu = decodePdu(buf)
  if (pdu.version !== RDCLEANPATH_VERSION) throw new DerError('unsupported version')
  if (pdu.destination === undefined || pdu.proxyAuth === undefined)
    throw new DerError('not a request')
  if (!pdu.x224ConnectionPdu) throw new DerError('x224_connection_pdu is missing')
  return {
    destination: pdu.destination,
    proxyAuth: pdu.proxyAuth,
    preconnectionBlob: pdu.preconnectionBlob ?? null,
    x224: pdu.x224ConnectionPdu
  }
}

export const responsePdu = (serverAddr: string, x224: Buffer, chain: readonly Buffer[]): Buffer =>
  encodePdu({
    version: RDCLEANPATH_VERSION,
    x224ConnectionPdu: x224,
    serverCertChain: [...chain],
    serverAddr
  })

export const errorPdu = (error: Omit<RDCleanPathError, 'errorCode'> = {}): Buffer =>
  encodePdu({ version: RDCLEANPATH_VERSION, error: { errorCode: GENERAL_ERROR_CODE, ...error } })

export const negotiationErrorPdu = (x224: Buffer): Buffer =>
  encodePdu({
    version: RDCLEANPATH_VERSION,
    error: { errorCode: NEGOTIATION_ERROR_CODE },
    x224ConnectionPdu: x224
  })
