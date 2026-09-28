import { describe, expect, it } from 'vitest'
import { TerminalTheme } from '@shared/settings'
import {
  BUILTIN_THEMES,
  importItermColors,
  importWindowsTerminal,
  resolveTheme
} from '@shared/themes'

const wt = {
  name: 'Campbell',
  background: '#0C0C0C',
  foreground: '#CCCCCC',
  cursorColor: '#FFFFFF',
  selectionBackground: '#FFFFFF',
  black: '#0C0C0C',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  purple: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightPurple: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2'
}

function itermEntry(key: string, r: number, g: number, b: number): string {
  return `<key>${key}</key><dict><key>Color Space</key><string>sRGB</string><key>Blue Component</key><real>${b}</real><key>Green Component</key><real>${g}</real><key>Red Component</key><real>${r}</real></dict>`
}

function itermFile(): string {
  const entries = Array.from({ length: 16 }, (_, i) =>
    itermEntry(`Ansi ${i} Color`, i / 15, 0.5, 1 - i / 15)
  )
  return `<?xml version="1.0"?><plist version="1.0"><dict>${entries.join('')}${itermEntry('Background Color', 1, 1, 1)}${itermEntry('Foreground Color', 0, 0, 0)}</dict></plist>`
}

describe('themes', () => {
  it('mọi theme có sẵn hợp lệ theo schema, id không trùng', () => {
    for (const t of BUILTIN_THEMES) expect(TerminalTheme.safeParse(t).success).toBe(true)
    expect(new Set(BUILTIN_THEMES.map((t) => t.id)).size).toBe(BUILTIN_THEMES.length)
  })

  it('nhập Windows Terminal: purple → magenta, nhận diện theme tối', () => {
    const t = importWindowsTerminal(JSON.stringify(wt))
    expect(t).toMatchObject({ id: 'custom-campbell', name: 'Campbell', dark: true })
    expect(t.colors.magenta).toBe('#881798')
    expect(t.colors.brightMagenta).toBe('#B4009E')
    expect(TerminalTheme.safeParse(t).success).toBe(true)
    // Dán cả settings.json cũng được.
    expect(importWindowsTerminal(JSON.stringify({ schemes: [wt] })).name).toBe('Campbell')
  })

  it('nhập Windows Terminal: báo lỗi rõ khi thiếu/sai màu', () => {
    expect(() => importWindowsTerminal('{')).toThrow(/JSON/)
    expect(() => importWindowsTerminal(JSON.stringify({ ...wt, red: undefined }))).toThrow(
      /Missing color "red"/
    )
    expect(() => importWindowsTerminal(JSON.stringify({ ...wt, red: 'đỏ' }))).toThrow(/Invalid/)
  })

  it('nhập iTerm2 .itermcolors: đổi số thực 0..1 sang hex, nền trắng → theme sáng', () => {
    const t = importItermColors(itermFile(), 'My iTerm')
    expect(t.colors.background).toBe('#ffffff')
    expect(t.colors.foreground).toBe('#000000')
    expect(t.colors.black).toBe('#0080ff')
    expect(t.colors.brightWhite).toBe('#ff8000')
    expect(t.dark).toBe(false)
    expect(t.colors.cursor).toBe('#000000') // mặc định = foreground
    expect(() => importItermColors('<plist></plist>')).toThrow(/Missing color/)
  })

  it('chọn theme theo hệ thống và theo id; id lạ rơi về mặc định', () => {
    const base = { themeId: 'system', darkThemeId: 'dracula', lightThemeId: 'solarized-light' }
    expect(resolveTheme(base, [], true).id).toBe('dracula')
    expect(resolveTheme(base, [], false).id).toBe('solarized-light')
    expect(resolveTheme({ ...base, themeId: 'nord' }, [], false).id).toBe('nord')
    expect(resolveTheme({ ...base, themeId: 'khong-co' }, [], false).id).toBe('shellhouse-dark')
  })
})
