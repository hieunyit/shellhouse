import { describe, expect, it } from 'vitest'
import {
  RDCLEANPATH_VERSION,
  decodePdu,
  detectPdu,
  encodePdu,
  errorPdu,
  negotiationErrorPdu,
  parseRequest,
  responsePdu,
  type RDCleanPathPdu
} from '../../src/session-host/rdp/rdcleanpath'
import { encodeUnsigned, readHeader, DerError } from '../../src/session-host/rdp/der'
import {
  connectionRequest,
  isConnectionRequest,
  parseConnectionConfirm,
  tpktLength
} from '../../src/session-host/rdp/x224'
import { allowedOrigin } from '../../src/session-host/rdp/proxy'

// Vector lấy từ IronRDP: crates/ironrdp-testsuite-core/tests/rdcleanpath.rs
const DEADBEEF = Buffer.from([0xde, 0xad, 0xbe, 0xff])
const REQUEST_DER = Buffer.from([
  0x30, 0x32, 0xa0, 0x4, 0x2, 0x2, 0xd, 0x3e, 0xa2, 0xd, 0xc, 0xb, 0x64, 0x65, 0x73, 0x74, 0x69,
  0x6e, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0xa3, 0xc, 0xc, 0xa, 0x70, 0x72, 0x6f, 0x78, 0x79, 0x20, 0x61,
  0x75, 0x74, 0x68, 0xa5, 0x5, 0xc, 0x3, 0x50, 0x43, 0x42, 0xa6, 0x6, 0x4, 0x4, 0xde, 0xad, 0xbe,
  0xff
])
const RESPONSE_SUCCESS_DER = Buffer.from([
  0x30, 0x34, 0xa0, 0x4, 0x2, 0x2, 0xd, 0x3e, 0xa6, 0x6, 0x4, 0x4, 0xde, 0xad, 0xbe, 0xff, 0xa7,
  0x14, 0x30, 0x12, 0x4, 0x4, 0xde, 0xad, 0xbe, 0xff, 0x4, 0x4, 0xde, 0xad, 0xbe, 0xff, 0x4, 0x4,
  0xde, 0xad, 0xbe, 0xff, 0xa9, 0xe, 0xc, 0xc, 0x31, 0x39, 0x32, 0x2e, 0x31, 0x36, 0x38, 0x2e, 0x37,
  0x2e, 0x39, 0x35
])
const RESPONSE_HTTP_ERROR_DER = Buffer.from([
  0x30, 0x15, 0xa0, 0x4, 0x2, 0x2, 0xd, 0x3e, 0xa1, 0xd, 0x30, 0xb, 0xa0, 0x3, 0x2, 0x1, 0x1, 0xa1,
  0x4, 0x2, 0x2, 0x1, 0xf4
])
const RESPONSE_TLS_ERROR_DER = Buffer.from([
  0x30, 0x14, 0xa0, 0x04, 0x02, 0x02, 0x0d, 0x3e, 0xa1, 0x0c, 0x30, 0x0a, 0xa0, 0x03, 0x02, 0x01,
  0x01, 0xa3, 0x03, 0x02, 0x01, 0x30
])

const request: RDCleanPathPdu = {
  version: RDCLEANPATH_VERSION,
  destination: 'destination',
  proxyAuth: 'proxy auth',
  preconnectionBlob: 'PCB',
  x224ConnectionPdu: DEADBEEF
}

describe('RDCleanPath DER (vector IronRDP)', () => {
  it('mã hoá đúng từng byte', () => {
    expect(encodePdu(request)).toEqual(REQUEST_DER)
    expect(responsePdu('192.168.7.95', DEADBEEF, [DEADBEEF, DEADBEEF, DEADBEEF])).toEqual(
      RESPONSE_SUCCESS_DER
    )
    expect(errorPdu({ httpStatusCode: 500 })).toEqual(RESPONSE_HTTP_ERROR_DER)
    expect(errorPdu({ tlsAlertCode: 48 })).toEqual(RESPONSE_TLS_ERROR_DER)
  })

  it('giải mã khớp và khứ hồi', () => {
    expect(decodePdu(REQUEST_DER)).toEqual(request)
    expect(decodePdu(RESPONSE_SUCCESS_DER)).toEqual({
      version: RDCLEANPATH_VERSION,
      x224ConnectionPdu: DEADBEEF,
      serverCertChain: [DEADBEEF, DEADBEEF, DEADBEEF],
      serverAddr: '192.168.7.95'
    })
    expect(decodePdu(RESPONSE_HTTP_ERROR_DER).error).toEqual({ errorCode: 1, httpStatusCode: 500 })
    const nego = decodePdu(negotiationErrorPdu(DEADBEEF))
    expect(nego.error?.errorCode).toBe(2)
    expect(nego.x224ConnectionPdu).toEqual(DEADBEEF)
    const big = Buffer.alloc(70_000, 7)
    expect(decodePdu(responsePdu('[::1]:3389', big, [big])).serverCertChain?.[0]).toEqual(big)
  })

  it('detect: đủ PDU / thiếu byte / sai', () => {
    for (const der of [REQUEST_DER, RESPONSE_SUCCESS_DER, RESPONSE_HTTP_ERROR_DER]) {
      expect(detectPdu(der)).toEqual({ kind: 'detected', totalLength: der.length })
      expect(detectPdu(Buffer.concat([der, Buffer.from([1, 2, 3])]))).toEqual({
        kind: 'detected',
        totalLength: der.length
      })
    }
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7])
      expect(detectPdu(REQUEST_DER.subarray(0, n))).toEqual({ kind: 'more' })
    expect(detectPdu(Buffer.from([0x31, 0x02, 0, 0]))).toEqual({ kind: 'failed' })
    // Sai phiên bản.
    const wrong = encodePdu({ ...request, version: 3389 })
    expect(detectPdu(wrong)).toEqual({ kind: 'failed' })
  })

  it('parseRequest kiểm trường bắt buộc', () => {
    expect(parseRequest(REQUEST_DER)).toEqual({
      destination: 'destination',
      proxyAuth: 'proxy auth',
      preconnectionBlob: 'PCB',
      x224: DEADBEEF
    })
    expect(() => parseRequest(RESPONSE_SUCCESS_DER)).toThrow()
    const noX224 = encodePdu({ version: RDCLEANPATH_VERSION, destination: 'd', proxyAuth: 't' })
    expect(() => parseRequest(noX224)).toThrow(/x224/)
    // Byte rác / cắt cụt.
    expect(() => parseRequest(REQUEST_DER.subarray(0, 20))).toThrow()
    expect(() => decodePdu(Buffer.from([0x30, 0x80, 0, 0]))).toThrow(DerError)
  })

  it('DER: số nguyên tối giản, độ dài dạng dài', () => {
    expect(encodeUnsigned(0)).toEqual(Buffer.from([2, 1, 0]))
    expect(encodeUnsigned(128)).toEqual(Buffer.from([2, 2, 0, 128]))
    expect(readHeader(Buffer.from([0x04, 0x82, 0x01, 0x00]))).toEqual({
      tag: 4,
      headerLength: 4,
      length: 256
    })
    expect(() => readHeader(Buffer.from([0x04, 0x81, 0x05]))).toThrow(/non-minimal/)
  })
})

describe('X.224', () => {
  it('Connection Request chuẩn và kiểm CR của client', () => {
    const cr = connectionRequest()
    expect(tpktLength(cr)).toBe(19)
    expect(isConnectionRequest(cr)).toBe(true)
    expect(isConnectionRequest(Buffer.concat([cr, Buffer.from([0])]))).toBe(false)
    expect(isConnectionRequest(Buffer.from('GET / HTTP/1.1\r\n'))).toBe(false)
  })

  it('Connection Confirm: chọn TLS / thất bại / server cũ', () => {
    const cc = Buffer.from([3, 0, 0, 19, 14, 0xd0, 0, 0, 0x12, 0x34, 0, 2, 0, 8, 0, 1, 0, 0, 0])
    expect(parseConnectionConfirm(cc)).toEqual({ kind: 'selected', protocol: 1 })
    const fail = Buffer.from(cc)
    fail[11] = 3
    fail[15] = 5
    expect(parseConnectionConfirm(fail)).toEqual({ kind: 'failure', code: 5 })
    expect(parseConnectionConfirm(Buffer.from([3, 0, 0, 11, 6, 0xd0, 0, 0, 0, 0, 0]))).toEqual({
      kind: 'legacy'
    })
    expect(() => parseConnectionConfirm(cr())).toThrow()
  })
})

function cr(): Buffer {
  return connectionRequest()
}

describe('proxy: Origin được phép', () => {
  it('renderer của app, không Origin, localhost (bản dev)', () => {
    expect(allowedOrigin(undefined)).toBe(true)
    expect(allowedOrigin('file://')).toBe(true)
    expect(allowedOrigin('null')).toBe(true)
    expect(allowedOrigin('http://localhost:5173')).toBe(true)
    expect(allowedOrigin('https://evil.example')).toBe(false)
    expect(allowedOrigin('chrome-extension://abc')).toBe(false)
  })
})
