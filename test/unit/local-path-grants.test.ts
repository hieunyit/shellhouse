import { describe, expect, it } from 'vitest'
import { LocalPathGrants } from '../../src/main/local-path-grants'

describe('LocalPathGrants — đường dẫn người dùng đã chọn', () => {
  it('file chọn để tải lên: chỉ đọc đúng file đó', () => {
    const g = new LocalPathGrants({ platform: 'linux' })
    g.grant('/home/u/a.txt', ['read'], false)
    expect(g.allows('/home/u/a.txt', 'read')).toBe(true)
    expect(g.allows('/home/u/a.txt', 'write')).toBe(false)
    expect(g.allows('/home/u/a.txt/x', 'read')).toBe(false)
    expect(g.allows('/home/u/b.txt', 'read')).toBe(false)
  })

  it('thư mục chọn: đọc / ghi bên trong, không thoát ra bằng ".." hay tên trùng tiền tố', () => {
    const g = new LocalPathGrants({ platform: 'linux' })
    g.grant('/home/u/Downloads', ['read', 'write'], true)
    expect(g.allows('/home/u/Downloads', 'write')).toBe(true)
    expect(g.allows('/home/u/Downloads/x/y.bin', 'write')).toBe(true)
    expect(g.allows('/home/u/Downloads/../.bashrc', 'write')).toBe(false)
    expect(g.allows('/home/u/Downloads-evil/x', 'write')).toBe(false)
    expect(g.allows('/home/u/.ssh/id_rsa', 'read')).toBe(false)
  })

  it('chỗ lưu (Save): chỉ ghi đúng file đó', () => {
    const g = new LocalPathGrants({ platform: 'linux' })
    g.grant('/home/u/buckets.csv', ['write'], false)
    expect(g.allows('/home/u/buckets.csv', 'write')).toBe(true)
    expect(g.allows('/home/u/buckets.csv', 'read')).toBe(false)
    expect(g.allows('/home/u/.bashrc', 'write')).toBe(false)
  })

  it('đường dẫn tương đối / rỗng / có NUL không bao giờ được cấp', () => {
    const g = new LocalPathGrants({ platform: 'linux' })
    g.grant('relative', ['read'], true)
    g.grant('', ['read'], true)
    g.grant('/a\0b', ['read'], true)
    expect(g.allows('relative', 'read')).toBe(false)
    expect(g.allows('/a\0b', 'read')).toBe(false)
    g.grant('/', ['read'], true)
    expect(g.allows('x', 'read')).toBe(false)
  })

  it('Windows: không phân biệt hoa thường, "\\" và "/" như nhau; "C:x" không phải tuyệt đối', () => {
    const g = new LocalPathGrants({ platform: 'win32' })
    g.grant('C:\\Users\\u\\Downloads', ['read', 'write'], true)
    expect(g.allows('c:\\users\\U\\downloads\\a.exe', 'write')).toBe(true)
    expect(g.allows('C:/Users/u/Downloads/b', 'write')).toBe(true)
    expect(g.allows('C:\\Users\\u\\Downloads\\..\\AppData\\x', 'write')).toBe(false)
    expect(g.allows('C:Users\\u\\Downloads\\a', 'write')).toBe(false)
  })

  it('hết hạn sau ttl; giữ tối đa `max` lượt (bỏ cũ nhất)', () => {
    let now = 0
    const g = new LocalPathGrants({ platform: 'linux', ttlMs: 1000, max: 2, now: () => now })
    g.grant('/a', ['read'], false)
    g.grant('/b', ['read'], false)
    g.grant('/c', ['read'], false)
    expect(g.allows('/a', 'read')).toBe(false)
    expect(g.allows('/b', 'read')).toBe(true)
    now = 1000
    expect(g.allows('/c', 'read')).toBe(false)
  })
})
