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
  it('bản build chỉ chấp nhận file://', () => {
    expect(isAppUrl('file:///app/out/renderer/index.html', undefined)).toBe(true)
    expect(isAppUrl('https://evil.example', undefined)).toBe(false)
  })

  it('bản dev chỉ chấp nhận đúng origin của dev server', () => {
    const dev = 'http://localhost:5173'
    expect(isAppUrl('http://localhost:5173/index.html', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('file:///x', dev)).toBe(false)
  })
})
