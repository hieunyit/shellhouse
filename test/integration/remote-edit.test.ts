import { chmodSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteEdits } from '../../src/session-host/sftp/edit'
import { SftpService } from '../../src/session-host/sftp/service'
import { REMOTE_CHANGED_MESSAGE, TransferQueue } from '../../src/session-host/sftp/transfers'
import { openSshShell } from '../../src/session-host/ssh/connect'
import { tempDir } from '../unit/helpers'
import { findSftpServer, startTestSshServer } from './ssh-test-server'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

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
  const queue = new TransferQueue(sftp, () => undefined)
  const edits = new RemoteEdits(sftp, queue)
  cleanups.push(() => {
    edits.dispose()
    queue.dispose()
    sftp.close()
  })
  return { remoteRoot, localRoot, queue, edits }
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Hết giờ chờ: ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe.skipIf(!findSftpServer())('Sửa file trên server (tải về, lưu → tự tải lên)', () => {
  it('mỗi lần lưu thì tải lên; giữ quyền gốc; chỉ "chạm" file thì không tải', async () => {
    const { remoteRoot, localRoot, queue, edits } = await setup()
    const remote = join(remoteRoot, 'deploy.sh')
    writeFileSync(remote, '#!/bin/sh\necho v1\n')
    if (process.platform !== 'win32') chmodSync(remote, 0o755)
    const local = join(localRoot, 'deploy.sh')

    await edits.open(remote, local)
    expect(readFileSync(local, 'utf8')).toBe('#!/bin/sh\necho v1\n')

    writeFileSync(local, '#!/bin/sh\necho v2\n')
    await until(() => readFileSync(remote, 'utf8').includes('v2'), 'lần lưu 1 lên server')
    await until(
      () => queue.list().some((t) => t.edit && t.state === 'done'),
      'transfer "Saved to server"'
    )
    if (process.platform !== 'win32') expect(statSync(remote).mode & 0o777).toBe(0o755)

    // Editor kiểu "ghi file tạm rồi đổi tên" (vim, VS Code…) — watcher vẫn bắt được.
    const tmp = join(localRoot, '.deploy.sh.swp')
    writeFileSync(tmp, '#!/bin/sh\necho v3\n')
    renameSync(tmp, local)
    await until(() => readFileSync(remote, 'utf8').includes('v3'), 'lần lưu 2 (atomic save)')

    // Đổi mtime mà nội dung giữ nguyên → không tải lên.
    const uploads = queue.list().filter((t) => t.direction === 'upload').length
    const now = new Date()
    utimesSync(local, now, now)
    await new Promise((r) => setTimeout(r, 900))
    expect(queue.list().filter((t) => t.direction === 'upload')).toHaveLength(uploads)
  })

  it('file trên server bị người khác sửa sau khi mở → không ghi đè, báo lỗi rõ ràng', async () => {
    const { remoteRoot, localRoot, queue, edits } = await setup()
    const remote = join(remoteRoot, 'app.conf')
    writeFileSync(remote, 'port=80\n')
    const past = new Date(Date.now() - 60_000)
    utimesSync(remote, past, past)
    const local = join(localRoot, 'app.conf')
    await edits.open(remote, local)

    writeFileSync(remote, 'port=8080 # đồng nghiệp sửa\n') // mtime mới
    writeFileSync(local, 'port=443\n')
    await until(
      () => queue.list().some((t) => t.edit && t.state === 'error'),
      'lượt tải lên bị từ chối'
    )
    expect(queue.list().find((t) => t.edit)?.error).toBe(REMOTE_CHANGED_MESSAGE)
    expect(readFileSync(remote, 'utf8')).toBe('port=8080 # đồng nghiệp sửa\n')
  })
})
