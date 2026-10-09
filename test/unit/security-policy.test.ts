import { describe, expect, it } from 'vitest'
import { devRendererUrl, isAppUrl, isSafeExternalUrl } from '../../src/main/security-policy'

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
    // URL viết sẵn (pathToFileURL theo máy chạy: trên Windows sẽ gắn ổ đĩa).
    const oddUrl = 'file:///home/Nguy%E1%BB%85n%20V%C4%83n/Shellhouse/out/renderer/index.html'
    expect(isAppUrl(oddUrl, undefined, odd, 'linux')).toBe(true)
    expect(
      isAppUrl('file:///home/Nguy%E1%BB%85n%20V%C4%83n/x/index.html', undefined, odd, 'linux')
    ).toBe(false)
  })

  it('Windows: ổ đĩa, dấu \\, không phân biệt hoa thường, dấu cách', () => {
    const winIndex = 'C:\\Program Files\\Shellhouse\\resources\\app.asar\\out\\renderer\\index.html'
    const url = 'file:///C:/Program%20Files/Shellhouse/resources/app.asar/out/renderer/index.html'
    expect(isAppUrl(url, undefined, winIndex, 'win32')).toBe(true)
    expect(isAppUrl(url.replace('C:', 'c:'), undefined, winIndex, 'win32')).toBe(true)
    expect(isAppUrl(`${url}#/x`, undefined, winIndex, 'win32')).toBe(true)
    expect(isAppUrl('file:///C:/Users/u/Downloads/index.html', undefined, winIndex, 'win32')).toBe(
      false
    )
    expect(
      isAppUrl(
        'file://server/share/Shellhouse/resources/app.asar/out/renderer/index.html',
        undefined,
        winIndex,
        'win32'
      )
    ).toBe(false)
  })

  it('bản dev chỉ chấp nhận đúng origin của dev server', () => {
    const dev = 'http://localhost:5173'
    expect(isAppUrl('http://localhost:5173/index.html', dev, index)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev, index)).toBe(false)
    expect(isAppUrl('file:///x', dev, index)).toBe(false)
  })
})

describe('devRendererUrl', () => {
  const env = { ELECTRON_RENDERER_URL: 'https://evil.example' }

  it('bản đóng gói bỏ qua ELECTRON_RENDERER_URL (không nạp trang từ xa)', () => {
    expect(devRendererUrl(true, env)).toBeUndefined()
  })

  it('bản dev dùng dev server; rỗng / không có → nạp file build', () => {
    expect(devRendererUrl(false, { ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe(
      'http://localhost:5173'
    )
    expect(devRendererUrl(false, { ELECTRON_RENDERER_URL: '' })).toBeUndefined()
    expect(devRendererUrl(false, {})).toBeUndefined()
  })
})
