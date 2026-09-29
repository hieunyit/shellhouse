import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { safeFileName, sessionLogFor } from '../../src/main/session-log-path'
import { AnsiStripper, SessionLog } from '../../src/session-host/session/session-log'
import { tempDir } from './helpers'

const bytes = (s: string): Uint8Array => Buffer.from(s, 'utf8')
const strip = (...chunks: string[]): string => {
  const s = new AnsiStripper()
  return chunks.map((c) => s.push(bytes(c))).join('')
}

describe('AnsiStripper', () => {
  it('bỏ màu, di chuyển con trỏ, tiêu đề cửa sổ; giữ chữ và xuống dòng', () => {
    expect(
      strip('\x1b]0;user@host: ~\x07\x1b[1;32muser@host\x1b[0m:\x1b[34m~\x1b[0m$ ls\r\n\x1b[?2004l')
    ).toBe('user@host:~$ ls\n')
  })

  it('chuỗi ESC và ký tự UTF-8 bị cắt ngang giữa hai lần nhận', () => {
    const s = new AnsiStripper()
    const utf8 = bytes('xin chào')
    const out = [
      s.push(bytes('a\x1b[3')),
      s.push(bytes('1mb\x1b')),
      s.push(bytes('[0m ')),
      s.push(utf8.subarray(0, 7)),
      s.push(utf8.subarray(7)),
      s.push(bytes('\r')),
      s.push(bytes('\n'))
    ].join('')
    expect(out).toBe('ab xin chào\n')
  })

  it('thanh tiến trình vẽ đè bằng "\\r" → mỗi lần vẽ một dòng; backspace xoá ký tự', () => {
    expect(strip('10%\r50%\r100%\r\n')).toBe('10%\n50%\n100%\n')
    expect(strip('lss\b \b -l\r\n')).toBe('ls -l\n')
  })

  it('OSC kết thúc bằng ESC \\ và DCS được bỏ hết', () => {
    expect(strip('a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b\x1bPq#0\x1b\\c')).toBe('alinkbc')
  })
})

describe('SessionLog', () => {
  it('ghi header, nội dung (plain text), footer; tạo thư mục nếu chưa có', async () => {
    const path = join(tempDir(), 'host', 'a.log')
    const log = new SessionLog({ path, stripAnsi: true, header: '=== start ===' }, () => undefined)
    log.write(bytes('\x1b[31mhello\x1b[0m\r\n'))
    log.close('=== end ===')
    await new Promise((r) => setTimeout(r, 50))
    expect(readFileSync(path, 'utf8')).toBe('=== start ===\nhello\n\n=== end ===\n')
  })

  it('giữ nguyên byte khi không lọc', async () => {
    const path = join(tempDir(), 'raw.log')
    const log = new SessionLog({ path, stripAnsi: false, header: 'h' }, () => undefined)
    log.write(bytes('\x1b[31mred\x1b[0m'))
    log.close('f')
    await new Promise((r) => setTimeout(r, 50))
    expect(readFileSync(path, 'utf8')).toBe('h\n\x1b[31mred\x1b[0m\nf\n')
  })
})

describe('sessionLogFor', () => {
  const at = new Date(2026, 8, 29, 14, 5, 9)
  const logging = (mode: 'off' | 'ssh' | 'all', directory = '') => ({
    ...DEFAULT_SETTINGS.logging,
    mode,
    directory
  })

  it('theo chế độ: tắt / chỉ SSH / tất cả', () => {
    const ssh = { kind: 'ssh' as const, label: 'root@10.0.0.5' }
    const local = { kind: 'local' as const, label: 'PowerShell' }
    expect(sessionLogFor(logging('off'), ssh, '/d', at)).toBeNull()
    expect(sessionLogFor(logging('ssh'), local, '/d', at)).toBeNull()
    expect(sessionLogFor(logging('ssh'), ssh, '/d', at)?.path).toBe(
      join('/d', 'root@10.0.0.5', '2026-09-29_14-05-09.log')
    )
    expect(sessionLogFor(logging('all', '/custom'), local, '/d', at)?.path).toBe(
      join('/custom', 'PowerShell', '2026-09-29_14-05-09.log')
    )
  })

  it('tên thư mục an toàn trên Windows', () => {
    expect(safeFileName('a:b/c\\d*?"<>|')).toBe('a_b_c_d______')
    expect(safeFileName('..')).toBe('session')
    expect(safeFileName(' x. ')).toBe('x')
  })
})
