import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ListedDirs } from '../../src/main/local-files'
import { writePrivateFile } from '../../src/main/private-file'
import { tempDir } from './helpers'

describe('ListedDirs (local:trash)', () => {
  it('chỉ nhận mục con trực tiếp của thư mục renderer đã liệt kê', () => {
    const dir = resolve(tempDir())
    const listed = new ListedDirs()
    expect(listed.allows(join(dir, 'a.txt'))).toBe(false)
    listed.remember(dir)
    expect(listed.allows(join(dir, 'a.txt'))).toBe(true)
    expect(listed.allows(join(dir, 'sub', 'a.txt'))).toBe(false)
    expect(listed.allows(join(dir, 'x', '..', '..', 'other'))).toBe(false)
    expect(listed.allows(dir)).toBe(false)
    expect(listed.allows('a.txt')).toBe(false)
  })

  it('không phình mãi: thư mục cũ nhất bị quên', () => {
    const listed = new ListedDirs()
    const base = resolve(tempDir())
    for (let i = 0; i <= 2000; i++) listed.remember(join(base, String(i)))
    expect(listed.allows(join(base, '0', 'f'))).toBe(false)
    expect(listed.allows(join(base, '2000', 'f'))).toBe(true)
  })
})

describe('writePrivateFile', () => {
  it.skipIf(process.platform === 'win32')('đè lên file 0644 có sẵn vẫn ra 0600', () => {
    const file = join(tempDir(), 'id_test')
    writeFileSync(file, 'old')
    chmodSync(file, 0o644)
    writePrivateFile(file, 'secret')
    expect(readFileSync(file, 'utf8')).toBe('secret')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
