import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openInEditor, RemoteEditFiles } from '../../src/main/remote-edit'
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

  it('cleanup xoá bản sao của lần chạy trước', () => {
    const root = join(tempDir(), 'edit')
    const files = new RemoteEditFiles(root)
    const p = files.prepare('f')
    files.cleanup()
    expect(existsSync(dirname(p))).toBe(false)
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
