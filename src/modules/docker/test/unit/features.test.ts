import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { diskUsage } from '../../session-host/api-backend'
import {
  authServer,
  buildArgs,
  ChunkQueue,
  parseListing,
  registryAuthHeader
} from '../../session-host/backend'
import { volumeSizes } from '../../session-host/cli-backend'
import {
  extractTar,
  modeText,
  packPaths,
  parsePax,
  parseTar,
  tarHeader,
  type TarEntry
} from '../../session-host/tar'
import { normalizeRegistry, registryFor, registryOf } from '../../shared/ipc'
import { DockerOp, healthOf, isMutating, type CopyResult } from '../../shared/ops'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sh-docker-unit-'))
  dirs.push(d)
  return d
}

async function* chunks(data: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < data.length; i += size) {
    await Promise.resolve()
    yield data.subarray(i, i + size)
  }
}

function fileEntry(path: string, content: string): Buffer {
  const data = Buffer.from(content)
  return Buffer.concat([
    tarHeader({ path, type: 'file', size: data.length, mode: 0o644, mtime: 1_700_000_000_000 }),
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512)
  ])
}

/** Header tự dựng (kiểu GNU 'L', symlink…) — tarHeader chỉ ghi file / thư mục. */
function rawHeader(name: string, type: string, size: number, linkname = ''): Buffer {
  const h = tarHeader({ path: name.slice(0, 100), type: 'file', size, mode: 0o644, mtime: 0 })
  h.write(type, 156, 1, 'ascii')
  if (linkname) h.write(linkname, 157, 100, 'utf8')
  h.write('        ', 148, 8, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return h
}

async function readAll(tar: Buffer, size = 97): Promise<{ entries: TarEntry[]; data: string[] }> {
  const entries: TarEntry[] = []
  const data: string[] = []
  let current: Buffer[] = []
  await parseTar(chunks(tar, size), {
    entry: (e) => {
      entries.push(e)
      current = []
    },
    data: (c) => {
      current.push(Buffer.from(c))
    },
    end: () => {
      data.push(Buffer.concat(current).toString('utf8'))
    }
  })
  return { entries, data }
}

describe('tar', () => {
  it('ghi rồi đọc lại: tên dài (PAX), tiếng Việt, mảnh cắt ở mọi kích thước', async () => {
    const long = `${'thư-mục/'.repeat(20)}tệp.txt`
    const tar = Buffer.concat([
      tarHeader({ path: 'a', type: 'dir', size: 0, mode: 0o755, mtime: 0 }),
      fileEntry('a/b.txt', 'xin chào'),
      fileEntry(long, 'dài'),
      Buffer.alloc(1024)
    ])
    for (const size of [1, 7, 512, 513, 4096]) {
      const { entries, data } = await readAll(tar, size)
      expect(entries.map((e) => [e.path, e.type])).toEqual([
        ['a', 'dir'],
        ['a/b.txt', 'file'],
        [long, 'file']
      ])
      expect(data).toEqual(['xin chào', 'dài'])
      expect(entries[1]?.mtime).toBe(1_700_000_000_000)
    }
  })

  it('tên dài kiểu GNU (L) và liên kết', async () => {
    const name = `${'n'.repeat(150)}.log`
    const body = Buffer.from(`${name}\0`)
    const tar = Buffer.concat([
      rawHeader('././@LongLink', 'L', body.length),
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
      fileEntry('short-placeholder', 'x'),
      rawHeader('link', '2', 0, '/etc/passwd'),
      Buffer.alloc(1024)
    ])
    const { entries } = await readAll(tar)
    expect(entries[0]?.path).toBe(name)
    expect(entries[1]).toMatchObject({ path: 'link', type: 'symlink', linkname: '/etc/passwd' })
  })

  it('PAX: độ dài bản ghi tính cả chính nó', () => {
    expect(parsePax(Buffer.from('18 path=a/b/c.txt\n10 size=5\n'))).toEqual({
      path: 'a/b/c.txt',
      size: '5'
    })
  })

  it('đóng gói thư mục trên máy: bỏ qua liên kết, file đổi kích thước vẫn đúng khối', async () => {
    const src = temp()
    writeFileSync(join(src, 'x.txt'), 'hello')
    const stats = { files: 0, bytes: 0, skipped: 0 }
    const parts: Buffer[] = []
    for await (const p of packPaths([src], stats)) parts.push(p)
    const tar = Buffer.concat(parts)
    expect(tar.length % 512).toBe(0)
    const { entries, data } = await readAll(tar)
    expect(entries.map((e) => e.path.split('/').slice(1).join('/'))).toEqual(['', 'x.txt'])
    expect(data).toEqual(['hello'])
    expect(stats).toEqual({ files: 1, bytes: 5, skipped: 0 })
  })

  it('giải nén an toàn: chặn "..", đường dẫn tuyệt đối, tên thiết bị Windows; không tạo liên kết', async () => {
    const root = temp()
    const tar = Buffer.concat([
      fileEntry('app/../../evil.txt', 'no'),
      fileEntry('/abs/x.txt', 'abs'),
      fileEntry('app/con.txt', 'dev'),
      fileEntry('app/a:b?.txt', 'odd'),
      rawHeader('app/link', '2', 0, '/etc/passwd'),
      Buffer.alloc(1024)
    ])
    const result: CopyResult = { files: 0, bytes: 0, skipped: 0, saved: [] }
    await extractTar(chunks(tar, 300), root, result)
    expect(result.skipped).toBe(1)
    for (const p of result.saved) expect(p.startsWith(root)).toBe(true)
    // Không có gì nằm ngoài thư mục đích.
    expect(readdirSync(join(root, '..')).includes('evil.txt')).toBe(false)
    const all = result.saved.map((p) => p.slice(root.length + 1).replace(/\\/g, '/'))
    expect(all).toContain('app/_/_/evil.txt')
    expect(all).toContain('abs/x.txt')
    expect(all).toContain('app/a_b_.txt')
    expect(all.some((p) => p.endsWith('/_con.txt') || p.endsWith('/con.txt'))).toBe(true)
    expect(readFileSync(join(root, 'abs', 'x.txt'), 'utf8')).toBe('abs')
  })

  it('quyền dạng chữ', () => {
    expect(modeText(0o755, 'dir')).toBe('drwxr-xr-x')
    expect(modeText(0o640, 'file')).toBe('-rw-r-----')
  })

  it('ChunkQueue: đọc theo thứ tự, lỗi khi kết thúc được ném ra', async () => {
    const q = new ChunkQueue()
    setTimeout(() => {
      q.push(Buffer.from('a'))
      q.push(Buffer.from('b'))
      q.end(new Error('boom'))
    }, 5)
    const got: string[] = []
    await expect(
      (async () => {
        for await (const c of q) got.push(c.toString())
      })()
    ).rejects.toThrow('boom')
    expect(got).toEqual(['a', 'b'])
  })
})

describe('tab Files: đọc output của sh', () => {
  it('kiểu, liên kết tới thư mục, kích thước / ngày / quyền từ stat; tên có khoảng trắng', () => {
    const out = [
      'd/etc',
      'L/bin',
      'l/broken',
      'f/my file.txt',
      'o/null',
      '--',
      '4096/1700000000/drwxr-xr-x/etc',
      '7/1700000001/lrwxrwxrwx/bin',
      '12/1700000002/-rw-r--r--/my file.txt',
      ''
    ].join('\n')
    expect(parseListing(out)).toEqual([
      { name: 'etc', type: 'dir', size: null, mtime: 1_700_000_000_000, mode: 'drwxr-xr-x' },
      {
        name: 'bin',
        type: 'link',
        linkDir: true,
        size: null,
        mtime: 1_700_000_001_000,
        mode: 'lrwxrwxrwx'
      },
      { name: 'broken', type: 'link', size: null, mtime: null, mode: null },
      { name: 'my file.txt', type: 'file', size: 12, mtime: 1_700_000_002_000, mode: '-rw-r--r--' },
      { name: 'null', type: 'other', size: null, mtime: null, mode: null }
    ])
  })
})

describe('registry', () => {
  it('máy chủ của image; chuẩn hoá Docker Hub', () => {
    expect(registryOf('nginx')).toBe('docker.io')
    expect(registryOf('acme/app:1')).toBe('docker.io')
    expect(registryOf('ghcr.io/acme/app:1')).toBe('ghcr.io')
    expect(registryOf('localhost:5000/app')).toBe('localhost:5000')
    expect(registryOf('Registry.Example.com:5000/a/b@sha256:ab')).toBe('registry.example.com:5000')
    expect(normalizeRegistry('https://index.docker.io/v1/')).toBe('docker.io')
    expect(normalizeRegistry('registry-1.docker.io')).toBe('docker.io')
    const list = [
      { id: 'a', server: 'docker.io' },
      { id: 'b', server: 'ghcr.io' }
    ]
    expect(registryFor('ghcr.io/x/y', list)?.id).toBe('b')
    expect(registryFor('redis', list)?.id).toBe('a')
    expect(registryFor('quay.io/x/y', list)).toBeNull()
  })

  it('X-Registry-Auth: JSON base64url; Docker Hub dùng địa chỉ index cũ', () => {
    expect(authServer('docker.io')).toBe('https://index.docker.io/v1/')
    expect(authServer('ghcr.io')).toBe('ghcr.io')
    const header = registryAuthHeader({ server: 'ghcr.io', username: 'u', password: 'p+/=' })
    expect(header).not.toMatch(/[+/=]/)
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({
      username: 'u',
      password: 'p+/=',
      serveraddress: 'ghcr.io'
    })
    expect(JSON.parse(Buffer.from(registryAuthHeader(null), 'base64url').toString())).toEqual({})
  })
})

describe('build', () => {
  it('Dockerfile tương đối tính từ context; tuyệt đối giữ nguyên; context sau `--`', () => {
    const base = { tags: [], buildArgs: [], noCache: false, pull: false }
    expect(buildArgs({ ...base, context: '/srv/app/' })).toEqual([
      'build',
      '--progress=plain',
      '--',
      '/srv/app/'
    ])
    expect(buildArgs({ ...base, context: '/srv/app', dockerfile: '/opt/Dockerfile' })).toContain(
      '/opt/Dockerfile'
    )
    expect(buildArgs({ ...base, context: 'C:\\src\\app', dockerfile: 'Dockerfile.dev' })).toContain(
      'C:\\src\\app/Dockerfile.dev'
    )
  })

  it('buildx: nền tảng / output / builder → `docker buildx build`, một nền tảng không đổi hành vi cũ', () => {
    const base = {
      tags: ['app:1'],
      buildArgs: [],
      noCache: false,
      pull: false,
      context: '/srv/app'
    }
    // Không dùng buildx nếu không chọn gì: giữ nguyên `docker build`.
    expect(buildArgs(base)[0]).toBe('build')
    expect(
      buildArgs({ ...base, platforms: ['linux/amd64', 'linux/arm64'], output: 'push' })
    ).toEqual([
      'buildx',
      'build',
      '--progress=plain',
      '-t',
      'app:1',
      '--platform',
      'linux/amd64,linux/arm64',
      '--push',
      '--',
      '/srv/app'
    ])
    const loaded = buildArgs({
      ...base,
      platforms: ['linux/arm64'],
      output: 'load',
      builder: 'multi'
    })
    expect(loaded.slice(0, 4)).toEqual(['buildx', 'build', '--builder', 'multi'])
    expect(loaded).toContain('--load')
    // Chỉ build: không cờ output.
    const none = buildArgs({ ...base, platforms: ['linux/amd64', 'linux/arm64'], output: 'none' })
    expect(none).not.toContain('--push')
    expect(none).not.toContain('--load')
  })

  it('buildx schema: nhiều nền tảng không nạp được; push cần tag; nền tảng / builder đúng dạng', () => {
    const op = (spec: Record<string, unknown>): boolean =>
      DockerOp.safeParse({
        op: 'build',
        spec: { context: '/x', tags: ['a:1'], buildArgs: [], noCache: false, pull: false, ...spec }
      }).success
    expect(op({ platforms: ['linux/amd64', 'linux/arm64'], output: 'push' })).toBe(true)
    expect(op({ platforms: ['linux/amd64', 'linux/arm64'], output: 'load' })).toBe(false)
    expect(op({ platforms: ['linux/arm64'], output: 'load' })).toBe(true)
    expect(op({ output: 'push', tags: [] })).toBe(false)
    expect(op({ platforms: ['--push'] })).toBe(false)
    expect(op({ platforms: ['linux/amd64'], builder: '--bad' })).toBe(false)
    expect(op({ platforms: ['linux/amd64'], builder: 'multi-arch_1' })).toBe(true)
    expect(op({ platforms: Array.from({ length: 9 }, () => 'linux/amd64') })).toBe(false)
  })

  it('schema: context / Dockerfile không được bắt đầu bằng "-" (không thành tuỳ chọn)', () => {
    const op = (context: string, dockerfile?: string): boolean =>
      DockerOp.safeParse({
        op: 'build',
        spec: {
          context,
          ...(dockerfile ? { dockerfile } : {}),
          tags: [],
          buildArgs: [],
          noCache: false,
          pull: false
        }
      }).success
    expect(op('/srv/app')).toBe(true)
    expect(op('--file=/etc/passwd')).toBe(false)
    expect(op('/srv/app', '-f')).toBe(false)
    expect(
      isMutating({
        op: 'build',
        spec: { context: '/x', tags: [], buildArgs: [], noCache: false, pull: false }
      })
    ).toBe(true)
    expect(isMutating({ op: 'files.list', id: 'web', path: '/' })).toBe(false)
    expect(isMutating({ op: 'files.download', id: 'web', paths: ['/etc'], localDir: '/tmp' })).toBe(
      false
    )
    expect(DockerOp.safeParse({ op: 'files.list', id: 'web', path: 'etc' }).success).toBe(false)
  })
})

describe('healthcheck, dung lượng', () => {
  it('đọc trạng thái healthcheck từ Status', () => {
    expect(healthOf('Up 2 hours (healthy)')).toBe('healthy')
    expect(healthOf('Up 3 minutes (unhealthy)')).toBe('unhealthy')
    expect(healthOf('Up 1 second (health: starting)')).toBe('starting')
    expect(healthOf('Up 2 hours')).toBeNull()
  })

  it('df: image dangling = phần dọn mặc định; volume ẩn danh / có tên tách riêng; cache không dùng', () => {
    const d = diskUsage({
      Images: [
        { Size: 100, Containers: 1, RepoTags: ['a:1'] },
        { Size: 50, Containers: 0, RepoTags: ['b:1'] },
        { Size: 10, Containers: 0, RepoTags: ['<none>:<none>'] },
        { Size: 7, Containers: 2, RepoTags: [] }
      ],
      Volumes: [
        { Name: 'a'.repeat(64), UsageData: { Size: 5, RefCount: 0 } },
        { Name: 'data', UsageData: { Size: 40, RefCount: 0 } },
        { Name: 'used', UsageData: { Size: 1, RefCount: 1 } },
        {
          Name: 'x',
          Labels: { 'com.docker.volume.anonymous': '' },
          UsageData: { Size: -1, RefCount: 0 }
        }
      ],
      BuildCache: [
        { Size: 30, InUse: false },
        { Size: 3, InUse: true }
      ]
    })
    expect(d.images).toEqual({
      count: 4,
      size: 167,
      reclaimable: 10,
      unused: { count: 2, size: 60 }
    })
    expect(d.volumes).toEqual({
      count: 4,
      size: 46,
      reclaimable: 5,
      namedUnused: { count: 1, size: 40 }
    })
    expect(d.buildCache).toEqual({ count: 2, size: 33, reclaimable: 30 })
  })

  it('CLI `system df -v`: dung lượng volume ẩn danh / có tên; định dạng lạ → null', () => {
    const json = JSON.stringify({
      Volumes: [
        { Name: 'b'.repeat(64), Links: '0', Size: '1.5kB', Labels: '' },
        { Name: 'pg', Links: '0', Size: '2MB', Labels: 'com.docker.compose.project=shop' },
        { Name: 'live', Links: '1', Size: '9GB', Labels: '' }
      ]
    })
    expect(volumeSizes(json)).toEqual({ anonymous: 1500, named: { count: 1, size: 2_000_000 } })
    expect(volumeSizes('not json')).toBeNull()
  })
})
