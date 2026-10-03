import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveLanguage, resolveLocale, setLanguage, t, tn } from '../../src/shared/i18n'
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatRelative
} from '../../src/shared/i18n/format'
import { PARTS, vi } from '../../src/shared/i18n/vi'

afterEach(() => {
  setLanguage('en')
})

describe('i18n: t / tn', () => {
  it('tiếng Anh: trả nguyên chuỗi, thay tham số', () => {
    expect(t('Delete “{name}”?', { name: 'web' })).toBe('Delete “web”?')
    expect(t('{missing} stays')).toBe('{missing} stays')
    expect(tn(1, '{n} file', '{n} files')).toBe('1 file')
    expect(tn(1200, '{n} file', '{n} files')).toBe('1,200 files')
  })

  it('tiếng Việt: dịch; thiếu bản dịch thì hiện tiếng Anh', () => {
    setLanguage('vi')
    expect(t('just now')).toBe('vừa xong')
    expect(t('{n} min ago', { n: 5 })).toBe('5 phút trước')
    expect(t('A string nobody translated')).toBe('A string nobody translated')
  })

  it('chọn ngôn ngữ theo hệ thống và locale theo vùng', () => {
    expect(resolveLanguage('system', ['vi-VN', 'en-US'])).toBe('vi')
    expect(resolveLanguage('system', ['fr-FR', 'en-GB'])).toBe('en')
    expect(resolveLanguage('system', ['ja-JP'])).toBe('en')
    expect(resolveLanguage('vi', ['en-US'])).toBe('vi')
    expect(resolveLocale('en', ['en-GB'])).toBe('en-GB')
    expect(resolveLocale('vi', ['en-US'])).toBe('vi-VN')
  })
})

describe('i18n: định dạng theo locale', () => {
  const when = new Date(2026, 7, 17, 22, 44)

  it('ngày giờ, số, dung lượng', () => {
    setLanguage('vi', 'vi-VN')
    expect(formatDateTime(when)).toContain('17/08/2026')
    expect(formatDateTime(when)).toContain('22:44')
    expect(formatNumber(12345.5)).toBe('12.345,5')
    expect(formatBytes(1536)).toBe('1,5 KB')
    setLanguage('en', 'en-US')
    expect(formatDateTime(when)).toContain('08/17/2026')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('không còn "1000 B": đổi đơn vị từ 1000', () => {
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1000)).toBe('1.0 KB')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.00 GB')
  })

  it('thời gian tương đối', () => {
    const now = when.getTime()
    expect(formatRelative(now - 10_000, now)).toBe('just now')
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 min ago')
    setLanguage('vi')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 giờ trước')
    expect(formatRelative(now - 86_400_000, now)).toBe('hôm qua')
  })
})

// ——— Quét mã nguồn: mọi chuỗi t('…') / tn(…, '…', '…') phải có bản dịch tiếng Việt ———

const ROOT = join(__dirname, '../..')
const SOURCES = ['src']

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'test') continue
      yield* files(full)
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) yield full
  }
}

const STRING = String.raw`'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"`
const T_CALL = new RegExp(String.raw`(?<![\w.$])t\(\s*(?:${STRING})`, 'g')
const TN_CALL = new RegExp(
  String.raw`(?<![\w.$])tn\(\s*[^,]+?,\s*(?:${STRING})\s*,\s*(?:${STRING})`,
  'g'
)
// Đối số đầu của tn() là biểu thức đơn giản (không ngoặc / chuỗi / xuống dòng) — tránh khớp lan sang
// dòng sau, ví dụ t('…') rồi một dòng log có template literal.
const TEMPLATE_KEY = /(?<![\w.$])tn?\(\s*(?:[^,`()'"\n]+?,\s*)?`/g

function unescape(text: string): string {
  return text.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c))
}

function scan(): { keys: Map<string, string>; templates: string[] } {
  const keys = new Map<string, string>()
  const templates: string[] = []
  for (const dir of SOURCES) {
    for (const file of files(join(ROOT, dir))) {
      if (file.includes(join('src', 'shared', 'i18n'))) continue
      const text = readFileSync(file, 'utf8')
      if (!/(?<![\w.$])tn?\(/.test(text)) continue
      const where = relative(ROOT, file)
      for (const m of text.matchAll(T_CALL)) {
        const key = unescape(m[1] ?? m[2] ?? '')
        if (!keys.has(key)) keys.set(key, where)
      }
      for (const m of text.matchAll(TN_CALL)) {
        for (const raw of [m[1] ?? m[2], m[3] ?? m[4]]) {
          const key = unescape(raw ?? '')
          if (!keys.has(key)) keys.set(key, where)
        }
      }
      for (const m of text.matchAll(TEMPLATE_KEY))
        templates.push(`${where}: ${text.slice(m.index, m.index + 60).split('\n')[0] ?? ''}`)
    }
  }
  return { keys, templates }
}

describe('i18n: từ điển tiếng Việt đủ cho mã nguồn', () => {
  const { keys, templates } = scan()

  it('khoá là chuỗi literal (không template literal) — để quét được', () => {
    expect(templates).toEqual([])
  })

  it('mọi chuỗi t() / tn() đều có bản dịch', () => {
    const missing = [...keys].filter(([key]) => !(key in vi)).map(([k, f]) => `${f}: ${k}`)
    expect(missing.slice(0, 80), `${String(missing.length)} chuỗi chưa dịch`).toEqual([])
  })

  it('bản dịch giữ đủ tham số {…} của chuỗi gốc', () => {
    const bad = Object.entries(vi).filter(([en, tr]) => {
      const names = (s: string): string =>
        [...s.matchAll(/\{(\w+)\}/g)]
          .map((m) => m[1])
          .sort()
          .join(',')
      return names(en) !== names(tr)
    })
    expect(bad).toEqual([])
  })

  it('một khoá không bị dịch khác nhau ở hai file từ điển', () => {
    const seen = new Map<string, string>()
    const conflicts: string[] = []
    for (const [part, entries] of Object.entries(PARTS)) {
      for (const [key, value] of Object.entries(entries)) {
        const before = seen.get(key)
        if (before !== undefined && before !== value) conflicts.push(`${part}: ${key}`)
        seen.set(key, value)
      }
    }
    expect(conflicts).toEqual([])
  })
})
