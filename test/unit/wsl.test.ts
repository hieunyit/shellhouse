import { describe, expect, it } from 'vitest'
import { parseWslList } from '../../src/main/wsl'

describe('wsl -l -v', () => {
  const text =
    '  NAME                   STATE           VERSION\r\n* Ubuntu                 Running         2\r\n  Ubuntu-22.04           Stopped         2\r\n  docker-desktop         Running         2\r\n  Legacy                 Stopped         1\r\n'
  const expected = [
    { name: 'Ubuntu', running: true, version: 2 },
    { name: 'Ubuntu-22.04', running: false, version: 2 },
    { name: 'Legacy', running: false, version: 1 }
  ]
  it('UTF-16LE (gọi từ Windows), bỏ distro của Docker Desktop', () => {
    expect(
      parseWslList(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    ).toEqual(expected)
  })
  it('UTF-8 (WSL_UTF8=1)', () => {
    expect(parseWslList(Buffer.from(text, 'utf8'))).toEqual(expected)
  })
  it('không có WSL / đầu ra lạ → []', () => {
    expect(parseWslList(Buffer.from(''))).toEqual([])
    expect(
      parseWslList(Buffer.from('Windows Subsystem for Linux has no installed distributions.'))
    ).toEqual([])
  })
})
