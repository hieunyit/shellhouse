import { describe, expect, it } from 'vitest'
import { eventToKeybinding } from '@shared/commands'
import { DEFAULT_SETTINGS, parseSettings } from '@shared/settings'
import { renderSnippet } from '@shared/snippets'
import { scanSshConfig } from '../../src/main/hosts/ssh-config-import'
import { tempDir } from './helpers'

// Các lỗi do fuzz tìm ra (Phase 4) — giữ lại để không tái phát.
describe('hồi quy từ fuzz', () => {
  it('~/.ssh/config có dòng "Host" trống không làm crash', () => {
    expect(() =>
      scanSshConfig('Host \nHost web\n  HostName web.example.com\n', {
        home: tempDir(),
        existingLabels: [],
        defaultUser: 'me'
      })
    ).not.toThrow()
  })

  it('cài đặt là mảng / kiểu lạ → mặc định, không crash', () => {
    expect(parseSettings([])).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('chuỗi')).toEqual(DEFAULT_SETTINGS)
  })

  it('tên phím trùng thuộc tính của Object.prototype không bị hiểu nhầm', () => {
    for (const code of ['valueOf', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(
        eventToKeybinding({ code, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })
      ).toBeNull()
    }
  })

  it('biến snippet tên "constructor" không lấy hàm từ prototype', () => {
    expect(() => renderSnippet('echo {{constructor}}', {})).toThrow(
      /Missing value for: constructor/
    )
    expect(renderSnippet('echo {{toString:x}}', {})).toBe('echo x')
  })
})
