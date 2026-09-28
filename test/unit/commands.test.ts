import { describe, expect, it } from 'vitest'
import {
  COMMANDS,
  effectiveKeybindings,
  eventToKeybinding,
  findConflicts,
  keybindingFor,
  normalizeKeybinding,
  reservedForTerminal
} from '@shared/commands'

const ev = (
  code: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}
) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('phím tắt', () => {
  it('sự kiện → chuỗi, dùng vị trí phím (Shift+, vẫn là ",")', () => {
    expect(eventToKeybinding(ev('KeyT', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+T')
    expect(eventToKeybinding(ev('Comma', { ctrlKey: true }))).toBe('Ctrl+,')
    expect(eventToKeybinding(ev('Tab', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Tab')
    expect(eventToKeybinding(ev('ShiftLeft', { shiftKey: true }))).toBeNull()
  })

  it('chuẩn hoá: thứ tự modifier, alias, hoa thường', () => {
    expect(normalizeKeybinding('shift+ctrl+t')).toBe('Ctrl+Shift+T')
    expect(normalizeKeybinding('Cmd+Shift+p')).toBe('Shift+Meta+P')
    expect(normalizeKeybinding('')).toBeNull()
  })

  it('mặc định theo nền tảng; ghi đè và bỏ phím', () => {
    expect(keybindingFor('tab.new', {}, true)).toBe('Meta+T')
    expect(keybindingFor('tab.new', {}, false)).toBe('Ctrl+Shift+T')
    expect(keybindingFor('tab.new', { 'tab.new': 'Ctrl+Alt+N' }, false)).toBe('Ctrl+Alt+N')
    expect(keybindingFor('tab.new', { 'tab.new': '' }, false)).toBeNull()
    const map = effectiveKeybindings({ 'tab.new': 'Ctrl+Alt+N' }, false)
    expect(map.get('Ctrl+Alt+N')).toBe('tab.new')
    expect(map.has('Ctrl+Shift+T')).toBe(false)
  })

  it('mặc định không có xung đột trên cả hai nền tảng', () => {
    expect(findConflicts({}, true).size).toBe(0)
    expect(findConflicts({}, false).size).toBe(0)
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length)
  })

  it('phát hiện xung đột khi người dùng gán trùng', () => {
    const conflicts = findConflicts({ 'snippets.open': 'Ctrl+Shift+T' }, false)
    expect(conflicts.get('Ctrl+Shift+T')).toEqual(['tab.new', 'snippets.open'])
  })

  it('cảnh báo phím terminal cần (Ctrl+C...)', () => {
    expect(reservedForTerminal('Ctrl+C')).toBe(true)
    expect(reservedForTerminal('Ctrl+Shift+C')).toBe(false)
  })
})
