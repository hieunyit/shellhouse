import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Client } from 'ssh2'
import { SftpService } from '../../src/session-host/sftp/service'

/**
 * Server SFTP giả, trong bộ nhớ, cư xử như Windows OpenSSH: readdir trả thuộc tính của ĐÍCH cho
 * link tới thư mục (trông như thư mục thường); unlink một link-thư-mục thất bại, phải rmdir.
 */
type Node = { kind: 'file' } | { kind: 'dir' } | { kind: 'link'; target: string }

function fakeServer(tree: Record<string, Node>) {
  const stats = (n: Node) => ({
    isDirectory: () => n.kind === 'dir',
    isSymbolicLink: () => n.kind === 'link',
    isFile: () => n.kind === 'file'
  })
  const resolve = (p: string): Node | undefined => {
    const n = tree[p]
    return n?.kind === 'link' ? tree[n.target] : n
  }
  const err = (m: string) => Object.assign(new Error(m), { code: 3 })
  const sftp = {
    lstat: (p: string, cb: (e: Error | null, s?: unknown) => void) => {
      const n = tree[p]
      if (n) cb(null, stats(n))
      else cb(err('No such file'))
    },
    readdir: (dir: string, cb: (e: Error | null, l?: unknown) => void) => {
      const children = Object.keys(tree).filter(
        (k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/')
      )
      // Như Windows: thuộc tính theo đích (link tới thư mục báo là thư mục).
      cb(
        null,
        children.map((k) => ({
          filename: k.slice(dir.length + 1),
          attrs: stats(resolve(k) ?? { kind: 'file' })
        }))
      )
    },
    unlink: (p: string, cb: (e: Error | null) => void) => {
      const n = tree[p]
      if (!n || n.kind === 'dir' || (n.kind === 'link' && tree[n.target]?.kind === 'dir')) {
        cb(err('Permission denied'))
        return
      }
      Reflect.deleteProperty(tree, p)
      cb(null)
    },
    rmdir: (p: string, cb: (e: Error | null) => void) => {
      const n = tree[p]
      const isDirLink = n?.kind === 'link' && tree[n.target]?.kind === 'dir'
      if (!n || (n.kind !== 'dir' && !isDirLink)) {
        cb(err('Not a directory'))
        return
      }
      if (n.kind === 'dir' && Object.keys(tree).some((k) => k.startsWith(`${p}/`))) {
        cb(err('Directory not empty'))
        return
      }
      Reflect.deleteProperty(tree, p) // với link: chỉ xoá chính link
      cb(null)
    }
  }
  const client = Object.assign(new EventEmitter(), {
    sftp: (cb: (e: Error | undefined, s: unknown) => void) => {
      cb(undefined, Object.assign(new EventEmitter(), sftp))
    }
  })
  return new SftpService(client as unknown as Client)
}

describe('SFTP xoá đệ quy', () => {
  it('không đi theo link tới thư mục ra ngoài, kể cả khi readdir báo link là thư mục', async () => {
    const tree: Record<string, Node> = {
      '/home/u/outside': { kind: 'dir' },
      '/home/u/outside/keep.txt': { kind: 'file' },
      '/home/u/trash': { kind: 'dir' },
      '/home/u/trash/a.txt': { kind: 'file' },
      '/home/u/trash/sub': { kind: 'dir' },
      '/home/u/trash/sub/b.txt': { kind: 'file' },
      '/home/u/trash/link-out': { kind: 'link', target: '/home/u/outside' }
    }
    const sftp = fakeServer(tree)
    await sftp.remove('/home/u/trash', true)
    expect(Object.keys(tree).sort()).toEqual(['/home/u/outside', '/home/u/outside/keep.txt'])
  })

  it('xoá trực tiếp một link tới thư mục: chỉ xoá link (rmdir khi unlink bị từ chối)', async () => {
    const tree: Record<string, Node> = {
      '/d': { kind: 'dir' },
      '/d/f': { kind: 'file' },
      '/l': { kind: 'link', target: '/d' }
    }
    await fakeServer(tree).remove('/l', false)
    expect(Object.keys(tree).sort()).toEqual(['/d', '/d/f'])
  })
})
