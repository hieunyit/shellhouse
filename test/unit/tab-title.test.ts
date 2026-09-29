import { describe, expect, it } from 'vitest'
import { tabTitle } from '../../src/shared/tab-title'

describe('tabTitle', () => {
  it('ConPTY đặt tiêu đề = đường dẫn exe → rỗng (tab giữ tên shell)', () => {
    expect(tabTitle('C:\\WINDOWS\\System32\\cmd.exe')).toBe('')
    expect(tabTitle('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('')
    expect(tabTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('')
  })
  it('cmd đang chạy lệnh: "…cmd.exe - ping x" → "ping x"', () => {
    expect(tabTitle('C:\\WINDOWS\\system32\\cmd.exe - ping 8.8.8.8')).toBe('ping 8.8.8.8')
  })
  it('shell chạy quyền admin: bỏ tiền tố "Administrator: "', () => {
    expect(tabTitle('Administrator: C:\\Windows\\System32\\cmd.exe')).toBe('')
    expect(tabTitle('Administrator: C:\\Windows\\system32\\cmd.exe - dir')).toBe('dir')
  })
  it('tiêu đề bình thường giữ nguyên', () => {
    expect(tabTitle('user@host: ~/src')).toBe('user@host: ~/src')
    expect(tabTitle('vim notes.exe.txt')).toBe('vim notes.exe.txt')
  })
})
