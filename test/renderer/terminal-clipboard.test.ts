import { describe, expect, it } from 'vitest'
import { decodeClipboardSequence } from '../../src/renderer/src/terminal/clipboard'
import { AppSettings } from '../../src/shared/settings'

describe('terminal clipboard', () => {
  it('decodes tmux OSC 52 with Unicode and multiple lines', () => {
    const value = 'Nội dung đã chọn\n第二行'
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    expect(decodeClipboardSequence(`c;${encoded}`)).toBe(value)
    expect(decodeClipboardSequence(`;${encoded}`)).toBe(value)
  })

  it('ignores read requests, invalid payloads and oversized writes', () => {
    for (const value of [
      'c;?',
      'c;%%%',
      'c;A',
      'c;/w==',
      'c;',
      'invalid;YQ==',
      'YQ==',
      `c;${'a'.repeat(1_398_105)}`
    ])
      expect(decodeClipboardSequence(value)).toBeNull()
  })

  it('enables copy on select by default and preserves an explicit opt-out', () => {
    expect(AppSettings.parse({}).terminal.copyOnSelect).toBe(true)
    expect(AppSettings.parse({ terminal: { copyOnSelect: false } }).terminal.copyOnSelect).toBe(
      false
    )
  })

  it('limits decoded clipboard content to 1 MiB, including unpadded base64', () => {
    const limit = 1_048_576
    expect(decodeClipboardSequence(`c;${btoa('a'.repeat(limit))}`)).toBe('a'.repeat(limit))
    for (const size of [limit + 1, limit + 2]) {
      const encoded = btoa('a'.repeat(size))
      expect(decodeClipboardSequence(`c;${encoded}`)).toBeNull()
      expect(decodeClipboardSequence(`c;${encoded.replace(/=+$/, '')}`)).toBeNull()
    }
  })
})
