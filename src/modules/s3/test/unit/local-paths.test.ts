import { describe, expect, it } from 'vitest'
import { checkLocalPaths } from '../../session-host'

function ctx(granted: (path: string, access: string) => boolean, edit: (p: string) => boolean) {
  const asked: string[] = []
  return {
    asked,
    ctx: {
      localPathGranted: (path: string, access: 'read' | 'write') => {
        asked.push(`${access} ${path}`)
        return Promise.resolve(granted(path, access))
      },
      ownsEditFile: (path: string) => {
        asked.push(`edit ${path}`)
        return Promise.resolve(edit(path))
      }
    }
  }
}

describe('S3: đường dẫn trên máy phải do người dùng chọn', () => {
  it('tải lên = đọc, tải về = ghi; đường dẫn không được cấp → lỗi', async () => {
    const c = ctx(
      (p) => p.startsWith('/home/u/Downloads'),
      () => false
    )
    const deny = 'Choose the file or folder on this computer again'
    await expect(
      checkLocalPaths(
        { op: 'upload', bucket: 'b', prefix: '', localPath: '/home/u/.ssh/id_rsa' },
        c.ctx
      )
    ).rejects.toThrow(deny)
    await expect(
      checkLocalPaths(
        { op: 'download', bucket: 'b', key: 'x', localPath: '/home/u/.bashrc', overwrite: true },
        c.ctx
      )
    ).rejects.toThrow(deny)
    await expect(
      checkLocalPaths(
        {
          op: 'uploadCheck',
          bucket: 'b',
          prefix: '',
          localPaths: ['/home/u/Downloads/a', '/etc/passwd']
        },
        c.ctx
      )
    ).rejects.toThrow(deny)
    await checkLocalPaths(
      { op: 'download', bucket: 'b', key: 'x', localPath: '/home/u/Downloads', overwrite: false },
      c.ctx
    )
    expect(c.asked).toEqual([
      'read /home/u/.ssh/id_rsa',
      'write /home/u/.bashrc',
      'read /home/u/Downloads/a',
      'read /etc/passwd',
      'write /home/u/Downloads'
    ])
  })

  it('sửa bằng editor: chỉ file tạm do main cấp', async () => {
    const c = ctx(
      () => true,
      (p) => p.startsWith('/data/remote-edit/')
    )
    await expect(
      checkLocalPaths({ op: 'edit', bucket: 'b', key: 'k', localPath: '/home/u/.bashrc' }, c.ctx)
    ).rejects.toThrow('temporary folder')
    await checkLocalPaths(
      { op: 'edit', bucket: 'b', key: 'k', localPath: '/data/remote-edit/1/k' },
      c.ctx
    )
  })

  it('thao tác không đụng file trên máy: không hỏi main', async () => {
    const c = ctx(
      () => false,
      () => false
    )
    await checkLocalPaths({ op: 'listBuckets' }, c.ctx)
    expect(c.asked).toEqual([])
  })
})
