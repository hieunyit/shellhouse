import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExecutableName, openInEditor, RemoteEditFiles } from '../../src/main/remote-edit'
import { tempDir } from './helpers'

describe('RemoteEditFiles', () => {
  it('mỗi file một thư mục riêng; tên do server đặt không thoát ra ngoài', () => {
    const root = join(tempDir(), 'edit')
    const files = new RemoteEditFiles(root)
    const a = files.prepare('nginx.conf')
    const b = files.prepare('nginx.conf')
    expect(basename(a)).toBe('nginx.conf')
    expect(dirname(a)).not.toBe(dirname(b))
    expect(existsSync(dirname(a))).toBe(true)
    expect(basename(files.prepare('..'))).toBe('_')
    expect(basename(files.prepare('a:b*?.txt'))).toBe('a_b__.txt')
    for (const p of [a, files.prepare('../../etc/passwd')]) expect(files.owns(p)).toBe(true)
  })

  it('chỉ mở được file trong thư mục tạm', () => {
    const root = join(tempDir(), 'edit')
    const files = new RemoteEditFiles(root)
    expect(files.owns(join(root, 'x', 'f'))).toBe(true)
    expect(files.owns(root)).toBe(false)
    expect(files.owns(join(root, '..', 'secret'))).toBe(false)
    expect(files.owns(join(tempDir(), 'f'))).toBe(false)
    expect(files.owns('relative/path')).toBe(false)
  })

  it('cleanup xoá bản sao của lần chạy trước (cả thư mục .old-* sót lại), không đụng bản mới', async () => {
    const parent = tempDir()
    const root = join(parent, 'edit')
    const files = new RemoteEditFiles(root)
    const p = files.prepare('f')
    mkdirSync(join(parent, 'edit.old-crashed', 'x'), { recursive: true })
    const done = files.cleanup()
    const fresh = files.prepare('g') // tạo ngay sau lời gọi, trong lúc đang xoá nền
    writeFileSync(fresh, 'mới')
    await done
    expect(existsSync(dirname(p))).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(readdirSync(parent)).toEqual(['edit'])
    await new RemoteEditFiles(join(parent, 'không-có')).cleanup()
  })
})

describe('openInEditor', () => {
  it('không chọn editor → ứng dụng mặc định', async () => {
    const opened: string[] = []
    await openInEditor('/tmp/x.conf', '', {
      openPath: (p) => {
        opened.push(p)
        return Promise.resolve('')
      },
      platform: 'linux'
    })
    expect(opened).toEqual(['/tmp/x.conf'])
  })

  it('không có ứng dụng mặc định: Linux/macOS báo lỗi', async () => {
    await expect(
      openInEditor('/tmp/x.service', '', {
        openPath: () => Promise.resolve('No application is associated'),
        platform: 'linux'
      })
    ).rejects.toThrow('No application is associated')
  })

  it('editor đã chọn nhưng không còn tồn tại → lỗi rõ ràng', async () => {
    const missing = join(tempDir(), 'no-such-editor')
    await expect(
      openInEditor('/tmp/x', missing, {
        openPath: () => Promise.resolve(''),
        platform: 'linux'
      })
    ).rejects.toThrow('The editor was not found')
  })
})

describe('openInEditor — file chương trình / script do server đặt', () => {
  const recorder = (platform: NodeJS.Platform) => {
    const opened: string[] = []
    const spawned: string[][] = []
    return {
      opened,
      spawned,
      deps: {
        platform,
        openPath: (p: string) => {
          opened.push(p)
          return Promise.resolve('')
        },
        spawn: (program: string, args: string[]) => {
          spawned.push([program, ...args])
          return Promise.resolve()
        }
      }
    }
  }

  it.each([
    'setup.exe',
    'run.BAT',
    'x.js',
    'a.lnk',
    'tool.jar',
    'go.command',
    'app.desktop',
    'i.MSI'
  ])('nhận ra %s là file chạy được', (name) => {
    expect(isExecutableName(`/tmp/edit/u/${name}`)).toBe(true)
    expect(isExecutableName(`C:\\edit\\u\\${name}`)).toBe(true)
  })

  it.each(['nginx.conf', 'README', '.bashrc', 'app.log', 'exe', 'data.json'])(
    '%s không phải file chạy được',
    (name) => {
      expect(isExecutableName(`/tmp/edit/u/${name}`)).toBe(false)
    }
  )

  it('Windows: .exe mở bằng Notepad, không đưa cho ứng dụng mặc định', async () => {
    const r = recorder('win32')
    await openInEditor('C:\\edit\\u\\setup.exe', '', r.deps)
    expect(r.opened).toEqual([])
    expect(r.spawned).toEqual([['notepad.exe', 'C:\\edit\\u\\setup.exe']])
  })

  it('macOS: .command mở bằng TextEdit (open -t)', async () => {
    const r = recorder('darwin')
    await openInEditor('/tmp/edit/u/go.command', '', r.deps)
    expect(r.opened).toEqual([])
    expect(r.spawned).toEqual([['open', '-t', '/tmp/edit/u/go.command']])
  })

  it('Linux: .desktop báo chọn editor, không mở', async () => {
    const r = recorder('linux')
    await expect(openInEditor('/tmp/edit/u/app.desktop', '', r.deps)).rejects.toThrow(
      'Choose an editor'
    )
    expect(r.opened).toEqual([])
    expect(r.spawned).toEqual([])
  })

  it('đã chọn editor: file chạy được vẫn mở bằng editor đó', async () => {
    const r = recorder('win32')
    await openInEditor('C:\\edit\\u\\run.bat', 'code', r.deps)
    expect(r.spawned).toEqual([['code', 'C:\\edit\\u\\run.bat']])
  })
})
