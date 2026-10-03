import { describe, expect, it } from 'vitest'
import {
  hostNameOptions,
  numberedName,
  replaceUnsafeFileChars,
  safeFileName,
  safeRelativeSegments,
  UniqueNames
} from '@shared/file-names'

describe('tên file an toàn từ tên do server đặt', () => {
  it('ký tự cấm của Windows và ký tự điều khiển → "_"', () => {
    expect(replaceUnsafeFileChars('a:b*c?"<>|\\/d\u0001')).toBe('a_b_c_______d_')
    expect(safeFileName('report:2024?.txt')).toBe('report_2024_.txt')
  })

  it('"", ".", ".." và tên chỉ toàn dấu chấm / khoảng trắng → "_" (không thoát khỏi thư mục)', () => {
    for (const bad of ['', '.', '..', '...', ' ', '. .', '.. ']) expect(safeFileName(bad)).toBe('_')
  })

  it('bỏ dấu chấm / khoảng trắng ở cuối (Windows tự cắt), giữ ở đầu', () => {
    expect(safeFileName('notes.txt. ')).toBe('notes.txt')
    expect(safeFileName('.bashrc')).toBe('.bashrc')
    expect(safeFileName('..hidden')).toBe('..hidden')
  })

  it('tên thiết bị Windows (cả có đuôi, mọi kiểu chữ) được thêm "_" phía trước', () => {
    for (const name of ['CON', 'con', 'Nul.txt', 'COM1', 'com9.log', 'LPT3', 'aux.tar.gz', 'COM¹'])
      expect(safeFileName(name)).toBe(`_${name}`)
    // Chỉ trùng phần đầu thì không phải tên thiết bị.
    for (const name of ['console', 'CONFIG.sys', 'nul_', 'COM10', 'lpt'])
      expect(safeFileName(name)).toBe(name)
  })

  it('đường dẫn tương đối: từng đoạn đều an toàn, đoạn rỗng giữ chỗ bằng "_"', () => {
    expect(safeRelativeSegments('data/../../.bashrc')).toEqual(['data', '_', '_', '.bashrc'])
    expect(safeRelativeSegments('a//b')).toEqual(['a', '_', 'b'])
    expect(safeRelativeSegments('/abs')).toEqual(['_', 'abs'])
    expect(safeRelativeSegments('x/..\\..\\evil.exe')).toEqual(['x', '.._.._evil.exe'])
    expect(safeRelativeSegments('a/CON/b.')).toEqual(['a', '_CON', 'b'])
  })

  it('ngoài Windows: giữ dấu chấm / khoảng trắng cuối, tên thiết bị; "", ".", ".." vẫn → "_"', () => {
    const linux = { windows: false }
    expect(safeFileName('a.', linux)).toBe('a.')
    expect(safeFileName('notes ', linux)).toBe('notes ')
    expect(safeFileName('CON', linux)).toBe('CON')
    for (const bad of ['', '.', '..']) expect(safeFileName(bad, linux)).toBe('_')
    expect(safeRelativeSegments('x/../y', linux)).toEqual(['x', '_', 'y'])
    expect(hostNameOptions('win32')).toEqual({ windows: true, foldCase: true })
    expect(hostNameOptions('darwin')).toEqual({ windows: false, foldCase: true })
    expect(hostNameOptions('linux')).toEqual({ windows: false, foldCase: false })
  })

  it('UniqueNames: tên khác nhau ra cùng tên an toàn → " (2)", " (3)" trước đuôi; cùng id cùng tên', () => {
    expect(numberedName('a.txt', 2)).toBe('a (2).txt')
    expect(numberedName('.bashrc', 2)).toBe('.bashrc (2)')
    expect(numberedName('README', 3)).toBe('README (3)')
    const win = new UniqueNames({ windows: true, foldCase: true })
    expect(win.name('a', 'a')).toBe('a')
    expect(win.name('a.', 'a.')).toBe('a (2)')
    expect(win.name('A', 'A')).toBe('A (3)')
    expect(win.name('a.', 'a.')).toBe('a (2)')
    expect(win.name('x:y.txt', 'x:y.txt')).toBe('x_y.txt')
    expect(win.name('x_y.txt', 'x_y.txt')).toBe('x_y (2).txt')
    const linux = new UniqueNames({ windows: false }, ['busy.txt'])
    expect(linux.name('a', 'a')).toBe('a')
    expect(linux.name('a.', 'a.')).toBe('a.')
    expect(linux.name('A', 'A')).toBe('A')
    expect(linux.name('busy', 'busy.txt')).toBe('busy (2).txt')
  })
})
