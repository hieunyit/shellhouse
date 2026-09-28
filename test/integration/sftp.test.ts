import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TransferStatus } from '@shared/sftp'
import { SftpService } from '../../src/session-host/sftp/service'
import { PART_SUFFIX, TransferQueue } from '../../src/session-host/sftp/transfers'
import { openSshShell } from '../../src/session-host/ssh/connect'
import { tempDir } from '../unit/helpers'
import { findSftpServer, startTestSshServer } from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

async function setup() {
  const remoteRoot = tempDir()
  const localRoot = tempDir()
  const server = await startTestSshServer([{ username: 'u', password: 'p' }], {
    sftpRoot: remoteRoot
  })
  cleanups.push(() => server.close())
  const shell = await openSshShell({
    destination: {
      target: { host: '127.0.0.1', port: server.port, username: 'u' },
      knownKeyTypes: [],
      credentials: { password: 'p' }
    },
    cols: 80,
    rows: 24,
    agent: null,
    keyFiles: [],
    callbacks: { onData: () => undefined, onExit: () => undefined },
    ctx: {
      status: () => undefined,
      log: () => undefined,
      prompt: () => Promise.resolve({ ok: false, answers: [] }),
      verifyHostKey: () => Promise.resolve(true)
    }
  })
  cleanups.push(() => {
    shell.close()
  })
  const sftp = new SftpService(shell.client)
  cleanups.push(() => {
    sftp.close()
  })
  const updates: TransferStatus[][] = []
  const queue = new TransferQueue(sftp, (l) => updates.push(l))
  cleanups.push(() => {
    queue.dispose()
  })
  const waitFor = async (id: string, states: TransferStatus['state'][], timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const s = queue.list().find((t) => t.id === id)
      if (s && states.includes(s.state)) return s
      if (Date.now() > deadline) throw new Error(`Hết giờ: ${JSON.stringify(s)}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return { remoteRoot, localRoot, sftp, queue, waitFor }
}

describe.skipIf(!findSftpServer())('SFTP (OpenSSH sftp-server thật)', () => {
  it('liệt kê: thư mục trước, link tới thư mục được nhận diện, quyền đúng', async () => {
    const { remoteRoot, sftp } = await setup()
    mkdirSync(join(remoteRoot, 'b-dir'))
    writeFileSync(join(remoteRoot, 'a.txt'), 'hello', { mode: 0o640 })
    symlinkSync(join(remoteRoot, 'b-dir'), join(remoteRoot, 'link-to-dir'))
    const listing = await sftp.list(remoteRoot)
    expect(listing.entries.map((e) => [e.name, e.type, e.isDirLike])).toEqual([
      ['b-dir', 'dir', true],
      ['link-to-dir', 'link', true],
      ['a.txt', 'file', false]
    ])
    const file = listing.entries.find((e) => e.name === 'a.txt')
    expect(file).toMatchObject({ size: 5, mode: 0o640 })
  })

  it('mkdir, rename, chmod, xoá đệ quy (không đi theo symlink ra ngoài)', async () => {
    const { remoteRoot, sftp } = await setup()
    const outside = tempDir()
    writeFileSync(join(outside, 'giu-lai.txt'), 'không được xoá')
    await sftp.mkdir(join(remoteRoot, 'd'))
    mkdirSync(join(remoteRoot, 'd', 'sub'))
    writeFileSync(join(remoteRoot, 'd', 'sub', 'f'), 'x')
    symlinkSync(outside, join(remoteRoot, 'd', 'link-ra-ngoai'))
    await sftp.rename(join(remoteRoot, 'd'), join(remoteRoot, 'e'))
    await sftp.chmod(join(remoteRoot, 'e', 'sub', 'f'), 0o600)
    expect(statSync(join(remoteRoot, 'e', 'sub', 'f')).mode & 0o777).toBe(0o600)
    await expect(sftp.remove(join(remoteRoot, 'e'), false)).rejects.toThrow()
    await sftp.remove(join(remoteRoot, 'e'), true)
    expect(existsSync(join(remoteRoot, 'e'))).toBe(false)
    expect(readFileSync(join(outside, 'giu-lai.txt'), 'utf8')).toBe('không được xoá')
  })

  it('download + upload 8 MB: đúng sha256, không để lại file part', async () => {
    const { remoteRoot, localRoot, queue, waitFor } = await setup()
    const data = randomBytes(8 * 1024 * 1024)
    writeFileSync(join(remoteRoot, 'big.bin'), data)

    const down = queue.enqueue(
      'download',
      join(localRoot, 'big.bin'),
      join(remoteRoot, 'big.bin'),
      false
    )
    expect(await waitFor(down, ['done', 'error'])).toMatchObject({
      state: 'done',
      size: data.length
    })
    expect(sha(readFileSync(join(localRoot, 'big.bin')))).toBe(sha(data))
    expect(existsSync(join(localRoot, 'big.bin' + PART_SUFFIX))).toBe(false)

    const up = queue.enqueue(
      'upload',
      join(localRoot, 'big.bin'),
      join(remoteRoot, 'copy.bin'),
      false
    )
    expect(await waitFor(up, ['done', 'error'])).toMatchObject({ state: 'done' })
    expect(sha(readFileSync(join(remoteRoot, 'copy.bin')))).toBe(sha(data))
    expect(existsSync(join(remoteRoot, 'copy.bin' + PART_SUFFIX))).toBe(false)
  })

  it('không ghi đè khi chưa cho phép; cho phép thì ghi đè', async () => {
    const { remoteRoot, localRoot, queue, waitFor } = await setup()
    writeFileSync(join(remoteRoot, 'f.txt'), 'mới')
    writeFileSync(join(localRoot, 'f.txt'), 'cũ')
    const a = queue.enqueue('download', join(localRoot, 'f.txt'), join(remoteRoot, 'f.txt'), false)
    expect(await waitFor(a, ['done', 'error'])).toMatchObject({
      state: 'error',
      error: 'The destination file already exists'
    })
    expect(readFileSync(join(localRoot, 'f.txt'), 'utf8')).toBe('cũ')
    const b = queue.enqueue('download', join(localRoot, 'f.txt'), join(remoteRoot, 'f.txt'), true)
    await waitFor(b, ['done'])
    expect(readFileSync(join(localRoot, 'f.txt'), 'utf8')).toBe('mới')
  })

  it('huỷ giữa chừng rồi thử lại → tiếp tục từ chỗ dừng, kết quả đúng sha256', async () => {
    const { remoteRoot, localRoot, queue, waitFor } = await setup()
    const data = randomBytes(24 * 1024 * 1024)
    writeFileSync(join(remoteRoot, 'resume.bin'), data)
    const id = queue.enqueue(
      'download',
      join(localRoot, 'resume.bin'),
      join(remoteRoot, 'resume.bin'),
      false
    )
    const deadline = Date.now() + 10_000
    while ((queue.list().find((t) => t.id === id)?.transferred ?? 0) < 2 * 1024 * 1024) {
      if (Date.now() > deadline) throw new Error('không tiến triển')
      await new Promise((r) => setTimeout(r, 5))
    }
    queue.cancel(id)
    const cancelled = await waitFor(id, ['cancelled', 'done'])
    if (cancelled.state === 'done') return // máy quá nhanh, không kịp huỷ — không có gì để kiểm tra
    const partSize = statSync(join(localRoot, 'resume.bin' + PART_SUFFIX)).size
    expect(partSize).toBeGreaterThan(0)
    expect(partSize).toBeLessThan(data.length)

    queue.retry(id)
    const done = await waitFor(id, ['done', 'error'])
    expect(done.state).toBe('done')
    expect(done.resumedFrom).toBeGreaterThan(0)
    expect(sha(readFileSync(join(localRoot, 'resume.bin')))).toBe(sha(data))
  })

  it('file part không khớp nguồn (nguồn đã đổi) → tải lại từ đầu thay vì ghép sai', async () => {
    const { remoteRoot, localRoot, queue, waitFor } = await setup()
    const data = randomBytes(1024 * 1024)
    writeFileSync(join(remoteRoot, 'changed.bin'), data)
    // File part cũ có nội dung khác hẳn (của một phiên bản trước của file).
    writeFileSync(join(localRoot, 'changed.bin' + PART_SUFFIX), randomBytes(300 * 1024))
    const id = queue.enqueue(
      'download',
      join(localRoot, 'changed.bin'),
      join(remoteRoot, 'changed.bin'),
      false
    )
    const done = await waitFor(id, ['done', 'error'])
    expect(done).toMatchObject({ state: 'done', resumedFrom: 0 })
    expect(sha(readFileSync(join(localRoot, 'changed.bin')))).toBe(sha(data))
  })

  it('file part khớp → chỉ tải phần còn lại', async () => {
    const { remoteRoot, localRoot, queue, waitFor } = await setup()
    const data = randomBytes(1024 * 1024)
    writeFileSync(join(remoteRoot, 'partial.bin'), data)
    writeFileSync(join(localRoot, 'partial.bin' + PART_SUFFIX), data.subarray(0, 700 * 1024))
    const id = queue.enqueue(
      'download',
      join(localRoot, 'partial.bin'),
      join(remoteRoot, 'partial.bin'),
      false
    )
    const done = await waitFor(id, ['done', 'error'])
    expect(done).toMatchObject({ state: 'done', resumedFrom: 700 * 1024 })
    expect(sha(readFileSync(join(localRoot, 'partial.bin')))).toBe(sha(data))
  })

  it('upload resume: file part trên server khớp → chỉ gửi phần còn lại', async () => {
    const { remoteRoot, localRoot, queue, waitFor } = await setup()
    const data = randomBytes(1024 * 1024)
    writeFileSync(join(localRoot, 'up.bin'), data)
    writeFileSync(join(remoteRoot, 'up.bin' + PART_SUFFIX), data.subarray(0, 512 * 1024))
    const id = queue.enqueue('upload', join(localRoot, 'up.bin'), join(remoteRoot, 'up.bin'), false)
    const done = await waitFor(id, ['done', 'error'])
    expect(done).toMatchObject({ state: 'done', resumedFrom: 512 * 1024 })
    expect(sha(readFileSync(join(remoteRoot, 'up.bin')))).toBe(sha(data))
  })

  it('đường dẫn cục bộ tương đối bị từ chối; file không tồn tại → lỗi dễ hiểu', async () => {
    const { remoteRoot, localRoot, queue, waitFor } = await setup()
    expect(() => queue.enqueue('download', 'relative/x', '/x', false)).toThrow(/must be absolute/)
    const id = queue.enqueue('download', join(localRoot, 'x'), join(remoteRoot, 'khong-co'), false)
    expect(await waitFor(id, ['error'])).toMatchObject({ error: 'File not found' })
  })
})
