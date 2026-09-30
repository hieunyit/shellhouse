import { describe, expect, it } from 'vitest'
import { TelnetParser } from '../../src/session-host/transport/telnet'

const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240

function setup(size = { cols: 120, rows: 40 }) {
  const sent: number[][] = []
  const parser = new TelnetParser(
    (b) => sent.push([...b]),
    'XTERM-256COLOR',
    () => size
  )
  const text = (bytes: number[] | string): string =>
    Buffer.from(
      parser.push(typeof bytes === 'string' ? Buffer.from(bytes) : Uint8Array.from(bytes))
    ).toString()
  return { parser, sent, text }
}

describe('TelnetParser', () => {
  it('tách lệnh IAC khỏi chữ; IAC IAC là byte 255', () => {
    const { text } = setup()
    expect(text([...Buffer.from('Login: '), IAC, 241 /* NOP */, ...Buffer.from('x')])).toBe(
      'Login: x'
    )
    const { parser } = setup()
    expect([...parser.push(Uint8Array.from([65, IAC, IAC, 66]))]).toEqual([65, 255, 66])
  })

  it('server WILL ECHO / SGA → DO; tuỳ chọn lạ → DONT; không trả lời lặp', () => {
    const { text, sent } = setup()
    text([IAC, WILL, 1, IAC, WILL, 3, IAC, WILL, 99, IAC, WILL, 1])
    expect(sent).toEqual([
      [IAC, DO, 1],
      [IAC, DO, 3],
      [IAC, DONT, 99]
    ])
  })

  it('DO NAWS → WILL NAWS + kích thước; đổi cỡ cửa sổ thì báo lại', () => {
    const size = { cols: 120, rows: 40 }
    const { parser, text, sent } = setup(size)
    text([IAC, DO, 31])
    expect(sent).toEqual([
      [IAC, WILL, 31],
      [IAC, SB, 31, 0, 120, 0, 40, IAC, SE]
    ])
    size.cols = 255 // byte 255 phải nhân đôi trong subnegotiation
    parser.resized()
    expect(sent.at(-1)).toEqual([IAC, SB, 31, 0, IAC, IAC, 0, 40, IAC, SE])
  })

  it('DO TTYPE + SB TTYPE SEND → báo loại terminal; tuỳ chọn không hỗ trợ → WONT', () => {
    const { text, sent } = setup()
    text([IAC, DO, 24, IAC, SB, 24, 1, IAC, SE, IAC, DO, 39])
    expect(sent[0]).toEqual([IAC, WILL, 24])
    expect(sent[1]).toEqual([IAC, SB, 24, 0, ...Buffer.from('XTERM-256COLOR'), IAC, SE])
    expect(sent[2]).toEqual([IAC, WONT, 39])
  })

  it('lệnh bị cắt giữa hai lần nhận vẫn hiểu đúng', () => {
    const { parser, sent } = setup()
    expect([...parser.push(Uint8Array.from([104, IAC]))]).toEqual([104])
    expect([...parser.push(Uint8Array.from([WILL]))]).toEqual([])
    expect([...parser.push(Uint8Array.from([1, 105]))]).toEqual([105])
    expect(sent).toEqual([[IAC, DO, 1]])
  })

  it('gõ phím: Enter thành CR NUL; UTF-8 giữ nguyên', () => {
    const { parser } = setup()
    expect([...parser.encode('ls\r')]).toEqual([108, 115, 13, 0])
    expect([...parser.encode('\r\n')]).toEqual([13, 10])
    expect([...parser.encode('ÿ')]).toEqual([0xc3, 0xbf])
  })
})
