import { readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../..')
const SOURCES = ['src', 'test', 'scripts']
const RESOLVED = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'])

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
}

describe('tên file', () => {
  // Windows / macOS không phân biệt hoa thường: "./Nav" có thể trỏ nhầm sang nav.ts — Linux (máy
  // dev, CI ubuntu) không thấy lỗi, chỉ lint / build trên Windows, macOS hỏng.
  it('không có hai file / thư mục chỉ khác nhau chữ hoa / thường (kể cả khác đuôi .ts / .tsx)', () => {
    const files: string[] = []
    for (const d of SOURCES) walk(join(ROOT, d), files)
    // Khoá = đường dẫn bỏ đuôi (import không ghi đuôi), chữ thường. Cùng khoá mà khác chữ hoa /
    // thường = trùng trên Windows / macOS.
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const f of files) {
      const rel = relative(ROOT, f).split('\\').join('/')
      const ext = extname(rel)
      const stem = RESOLVED.has(ext) ? rel.slice(0, -ext.length) : rel
      const other = seen.get(stem.toLowerCase())
      if (other !== undefined && other !== stem) clashes.push(`${other} <-> ${stem}`)
      seen.set(stem.toLowerCase(), stem)
    }
    expect(clashes).toEqual([])
  })
})
