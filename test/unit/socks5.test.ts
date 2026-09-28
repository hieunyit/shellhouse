import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MAX_HANDSHAKE_BYTES,
  parseGreeting,
  parseRequest,
  REPLY,
  replyBytes
} from '../../src/session-host/forward/socks5'

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b)

function connectRequest(atyp: number, addr: number[], port: number): Uint8Array {
  return bytes(5, 1, 0, atyp, ...addr, port >> 8, port & 0xff)
}

describe('parseGreeting', () => {
  it('cần thêm dữ liệu khi chưa đủ', () => {
    expect(parseGreeting(bytes())).toEqual({ status: 'more' })
    expect(parseGreeting(bytes(5))).toEqual({ status: 'more' })
    expect(parseGreeting(bytes(5, 2, 0))).toEqual({ status: 'more' })
  })
  it('nhận diện no-auth', () => {
    expect(parseGreeting(bytes(5, 2, 2, 0))).toEqual({
      status: 'ok',
      consumed: 4,
      noAuthOffered: true
    })
    expect(parseGreeting(bytes(5, 1, 2))).toEqual({
      status: 'ok',
      consumed: 3,
      noAuthOffered: false
    })
  })
  it('từ chối SOCKS4 và danh sách rỗng', () => {
    expect(parseGreeting(bytes(4, 1, 0)).status).toBe('error')
    expect(parseGreeting(bytes(5, 0)).status).toBe('error')
  })
})

describe('parseRequest', () => {
  it('IPv4, domain, IPv6', () => {
    expect(parseRequest(connectRequest(1, [10, 0, 0, 5], 443))).toEqual({
      status: 'ok',
      consumed: 10,
      host: '10.0.0.5',
      port: 443
    })
    const name = [...Buffer.from('example.com')]
    expect(parseRequest(connectRequest(3, [name.length, ...name], 80))).toMatchObject({
      host: 'example.com',
      port: 80
    })
    const v6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
    expect(parseRequest(connectRequest(4, v6, 22))).toMatchObject({
      host: '2001:db8:0:0:0:0:0:1',
      port: 22
    })
  })

  it('dữ liệu đến từng mảnh: trả "more" cho mọi tiền tố', () => {
    const full = connectRequest(3, [9, ...Buffer.from('localhost')], 8080)
    for (let i = 0; i < full.length; i++)
      expect(parseRequest(full.subarray(0, i)).status).toBe('more')
    expect(parseRequest(full).status).toBe('ok')
  })

  it('từ chối lệnh BIND/UDP, loại địa chỉ lạ, port 0, domain có ký tự lạ', () => {
    expect(parseRequest(bytes(5, 2, 0, 1, 1, 2, 3, 4, 0, 80))).toMatchObject({
      status: 'error',
      reply: REPLY.commandNotSupported
    })
    expect(parseRequest(bytes(5, 1, 0, 9, 0, 0))).toMatchObject({
      status: 'error',
      reply: REPLY.addressTypeNotSupported
    })
    expect(parseRequest(connectRequest(1, [1, 2, 3, 4], 0)).status).toBe('error')
    const evil = [...Buffer.from('a\nb c')]
    expect(parseRequest(connectRequest(3, [evil.length, ...evil], 80)).status).toBe('error')
  })

  it('fuzz: 20.000 buffer ngẫu nhiên không bao giờ throw, kết quả luôn hợp lệ', () => {
    for (let i = 0; i < 20_000; i++) {
      const buf = randomBytes(Math.floor(Math.random() * 40))
      if (i % 2 === 0) buf[0] = 5 // tăng xác suất đi sâu vào parser
      if (i % 3 === 0 && buf.length > 1) buf[1] = 1
      const g = parseGreeting(buf)
      const r = parseRequest(buf)
      expect(['more', 'ok', 'error']).toContain(g.status)
      expect(['more', 'ok', 'error']).toContain(r.status)
      if (r.status === 'ok') {
        expect(r.consumed).toBeLessThanOrEqual(buf.length)
        expect(r.port).toBeGreaterThan(0)
      }
    }
  })

  it('giới hạn kích thước handshake đủ cho yêu cầu dài nhất', () => {
    const name = Array.from({ length: 255 }, () => 0x61)
    const longest = connectRequest(3, [255, ...name], 1)
    expect(longest.length + 3).toBeLessThanOrEqual(MAX_HANDSHAKE_BYTES)
    expect(replyBytes(REPLY.succeeded)).toHaveLength(10)
  })
})
