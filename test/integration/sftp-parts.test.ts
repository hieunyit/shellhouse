import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TransferStatus } from '@shared/sftp'
import { SftpService } from '../../src/session-host/sftp/service'
import { PART_META_SUFFIX, PART_SUFFIX, TransferQueue } from '../../src/session-host/sftp/transfers'
import { discardLocalParts, inspectLocalParts } from '../../src/session-host/sftp/parts'
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
  return { remoteRoot, localRoot, sftp, queue, waitFor, updates }
}

/** Chờ tới khi lượt tải được `bytes` byte rồi huỷ; trả về trạng thái cuối (có thể "done" nếu máy quá nhanh). */
async function cancelAfter(
  queue: TransferQueue,
  waitFor: (id: string, states: TransferStatus['state'][]) => Promise<TransferStatus>,
  id: string,
  bytes: number
): Promise<TransferStatus> {
  const deadline = Date.now() + 10_000
  while ((queue.list().find((t) => t.id === id)?.transferred ?? 0) < bytes) {
    if (Date.now() > deadline) throw new Error('không tiến triển')
    await new Promise((r) => setTimeout(r, 5))
  }
  queue.cancel(id)
  return waitFor(id, ['cancelled', 'done'])
}

describe.skipIf(!findSftpServer())('SFTP: file tải dở (*.shellhouse-part)', () => {
  it('huỷ file lớn → giữ part (resumable), meta ghi nguồn; Discard xoá part + meta', async () => {
    const { remoteRoot, localRoot, queue, waitFor } = await setup()
    writeFileSync(join(remoteRoot, 'big.bin'), randomBytes(24 * 1024 * 1024))
    const local = join(localRoot, 'big.bin')
    const id = queue.enqueue('download', local, join(remoteRoot, 'big.bin'), false)
    const status = await cancelAfter(queue, waitFor, id, 2 * 1024 * 1024)
    if (status.state === 'done') return
    expect(status.resumable).toBe(true)
    expect(existsSync(local + PART_SUFFIX)).toBe(true)
    const meta = JSON.parse(readFileSync(local + PART_META_SUFFIX, 'utf8')) as { remote?: string }
    expect(meta.remote).toBe(join(remoteRoot, 'big.bin'))

    queue.discard(id)
    expect(queue.list()).toEqual([])
    const deadline = Date.now() + 2000
    while (existsSync(local + PART_SUFFIX) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10))
    expect(existsSync(local + PART_SUFFIX)).toBe(false)
    expect(existsSync(local + PART_META_SUFFIX)).toBe(false)
  })

  it('huỷ lượt không resume được (noResume) → xoá part ngay, không để rác', async () => {
    const { remoteRoot, localRoot, queue, waitFor } = await setup()
    writeFileSync(join(remoteRoot, 'nr.bin'), randomBytes(24 * 1024 * 1024))
    const local = join(localRoot, 'nr.bin')
    const id = queue.enqueue('download', local, join(remoteRoot, 'nr.bin'), false, {
      noResume: true
    })
    const status = await cancelAfter(queue, waitFor, id, 2 * 1024 * 1024)
    if (status.state === 'done') return
    expect(status.resumable).toBeUndefined()
    expect(existsSync(local + PART_SUFFIX)).toBe(false)
    expect(existsSync(local + PART_META_SUFFIX)).toBe(false)
  })

  it('dọn danh sách giữ part → khung Local nhận ra, tiếp tục đúng sha256; xoá được', async () => {
    const { remoteRoot, localRoot, sftp, queue, waitFor } = await setup()
    const data = randomBytes(24 * 1024 * 1024)
    writeFileSync(join(remoteRoot, 'keep.bin'), data)
    const local = join(localRoot, 'keep.bin')
    const id = queue.enqueue('download', local, join(remoteRoot, 'keep.bin'), false)
    const status = await cancelAfter(queue, waitFor, id, 2 * 1024 * 1024)
    if (status.state === 'done') return
    queue.clearDone(true)
    expect(queue.list()).toEqual([])
    expect(existsSync(local + PART_SUFFIX)).toBe(true)
    // Một part mồ côi không có meta (bản cũ / S3): chỉ xoá được.
    writeFileSync(join(localRoot, 'old.bin' + PART_SUFFIX), 'x')

    const remoteStat = async (p: string) => {
      const st = await sftp.statOrNull(p)
      return st ? { size: st.size, mtime: st.mtime } : null
    }
    const notBusy = () => false
    const parts = await inspectLocalParts(
      localRoot,
      ['keep.bin', 'old.bin', 'missing.bin', '../evil'],
      remoteStat,
      notBusy
    )
    expect(parts.map((p) => [p.name, p.resumable]).sort()).toEqual([
      ['keep.bin', true],
      ['old.bin', false]
    ])
    const keep = parts.find((p) => p.name === 'keep.bin')
    expect(keep?.remotePath).toBe(join(remoteRoot, 'keep.bin'))
    expect(keep?.totalBytes).toBe(data.length)

    // Không kết nối (không stat được server) → không tiếp tục được.
    const offline = await inspectLocalParts(localRoot, ['keep.bin'], null, notBusy)
    expect(offline[0]?.resumable).toBe(false)

    const again = queue.enqueue('download', local, keep?.remotePath ?? '', false)
    const done = await waitFor(again, ['done', 'error'])
    expect(done.state).toBe('done')
    expect(done.resumedFrom).toBeGreaterThan(0)
    expect(sha(readFileSync(local))).toBe(sha(data))

    expect(await discardLocalParts(localRoot, ['old.bin', 'keep.bin', '..'], notBusy)).toBe(1)
    expect(existsSync(join(localRoot, 'old.bin' + PART_SUFFIX))).toBe(false)
    expect(statSync(local).size).toBe(data.length)
  })
})
