import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isAppUrl, isSafeExternalUrl } from '../../src/main/security-policy'

describe('isSafeExternalUrl', () => {
  it.each(['https://example.com', 'http://localhost:8080/x'])('cho phép %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(true)
  })

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'smb://host/share',
    'ms-msdt:/id',
    'not a url',
    ''
  ])('chặn %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(false)
  })
})

describe('isAppUrl', () => {
  const index = '/app/out/renderer/index.html'

  it('bản build chỉ chấp nhận đúng index.html của renderer', () => {
    expect(isAppUrl('file:///app/out/renderer/index.html', undefined, index, 'linux')).toBe(true)
    expect(isAppUrl('file:///app/out/renderer/index.html#/x?y=1', undefined, index, 'linux')).toBe(
      true
    )
    expect(isAppUrl('https://evil.example', undefined, index, 'linux')).toBe(false)
    // File HTML khác trên đĩa (tải về, giải nén…) không được coi là app.
    expect(isAppUrl('file:///home/u/Downloads/evil.html', undefined, index, 'linux')).toBe(false)
    expect(isAppUrl('file:///app/out/renderer/other.html', undefined, index, 'linux')).toBe(false)
    expect(isAppUrl('file:///app/out/renderer/', undefined, index, 'linux')).toBe(false)
    expect(isAppUrl('file://server/app/out/renderer/index.html', undefined, index, 'linux')).toBe(
      false
    )
    // Linux phân biệt hoa thường.
    expect(isAppUrl('file:///APP/out/renderer/index.html', undefined, index, 'linux')).toBe(false)
  })

  it('đường dẫn có dấu cách / chữ có dấu (mã hoá %xx)', () => {
    const odd = '/home/Nguyễn Văn/Shellhouse/out/renderer/index.html'
    expect(isAppUrl(pathToFileURL(odd).href, undefined, odd, 'linux')).toBe(true)
    expect(
      isAppUrl('file:///home/Nguy%E1%BB%85n%20V%C4%83n/x/index.html', undefined, odd, 'linux')
    ).toBe(false)
  })

  it('bản dev chỉ chấp nhận đúng origin của dev server', () => {
    const dev = 'http://localhost:5173'
    expect(isAppUrl('http://localhost:5173/index.html', dev, index)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev, index)).toBe(false)
    expect(isAppUrl('file:///x', dev, index)).toBe(false)
  })
})
