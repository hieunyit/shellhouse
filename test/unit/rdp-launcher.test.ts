import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RDP, type RdpStatusEvent } from '@shared/rdp'
import { freerdpExitMessage, RdpLauncher } from '../../src/main/rdp/launcher'
import type { DetectedClient } from '../../src/main/rdp/detect'
import type { RdpTarget } from '../../src/main/rdp/rdp-file'

/** Tiến trình giả: ghi lại stdin, tự phát 'spawn' (hoặc 'error'). */
class FakeChild extends EventEmitter {
  stdinData = ''
  stdinEnded = false
  killed = false
  readonly stderrEmitter = new EventEmitter()
  readonly stdin = {
    write: (d: string) => {
      this.stdinData += d
    },
    end: () => {
      this.stdinEnded = true
    },
    on: () => undefined
  }
  readonly stderr = {
    on: (_e: 'data', l: (chunk: Buffer) => void) => this.stderrEmitter.on('data', l)
  }
  constructor(fail?: Error) {
    super()
    queueMicrotask(() => {
      if (fail) this.emit('error', fail)
      else this.emit('spawn')
    })
  }
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
}

function setup(
  options: {
    platform?: NodeJS.Platform
    cmdkeyCode?: number
    spawnError?: Error
    now?: () => number
  } = {}
) {
  const calls: { file: string; args: string[]; stdin: boolean }[] = []
  const runs: { file: string; args: string[] }[] = []
  const syncRuns: string[][] = []
  const files = new Map<string, Buffer | string>()
  const removed: string[] = []
  const events: RdpStatusEvent[] = []
  const logs: string[] = []
  const children: FakeChild[] = []
  const launcher = new RdpLauncher({
    platform: options.platform ?? 'linux',
    tempDir: '/tmp/rdp',
    home: '/home/u',
    spawn: (file, args, io) => {
      calls.push({ file, args, stdin: io.stdin })
      const child = new FakeChild(options.spawnError)
      children.push(child)
      return child
    },
    run: (file, args) => {
      runs.push({ file, args })
      return Promise.resolve(options.cmdkeyCode ?? 0)
    },
    runSync: (_file, args) => {
      syncRuns.push(args)
    },
    writePrivate: (path, data) => {
      files.set(path, data)
    },
    remove: (path) => {
      removed.push(path)
      files.delete(path)
    },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    onStatus: (e) => events.push(e),
    ...(options.now ? { now: options.now } : {})
  })
  return { launcher, calls, runs, syncRuns, files, removed, events, logs, children }
}

const target: RdpTarget = {
  label: 'srv',
  host: 'srv.example.com',
  port: 3389,
  username: 'john',
  domain: 'CORP',
  settings: DEFAULT_RDP
}
const mstsc: DetectedClient = {
  kind: 'mstsc',
  name: 'mstsc',
  path: 'C:\\Windows\\System32\\mstsc.exe',
  cmdkey: 'C:\\Windows\\System32\\cmdkey.exe'
}
const xfreerdp: DetectedClient = {
  kind: 'xfreerdp',
  name: 'xfreerdp3',
  path: '/usr/bin/xfreerdp3',
  freerdpMajor: 3
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('RdpLauncher', () => {
  it('mstsc: cmdkey trước khi chạy, file .rdp 0600 không có mật khẩu; thoát → xoá cmdkey + file', async () => {
    const s = setup({ platform: 'win32' })
    const { launchId, tracked } = await s.launcher.launch({
      client: mstsc,
      target,
      password: 's3cret'
    })
    expect(tracked).toBe(true)
    expect(s.runs[0]?.args).toEqual([
      '/generic:TERMSRV/srv.example.com',
      '/user:CORP\\john',
      '/pass:s3cret'
    ])
    const [file, data] = [...s.files.entries()][0] ?? []
    // Thư mục tạm thật dùng dấu phân cách của máy chạy (Windows: \\).
    expect(file).toMatch(/^[\\/]tmp[\\/]rdp[\\/].+\.rdp$/)
    expect(Buffer.from(data as Buffer).toString('utf16le')).not.toContain('s3cret')
    expect(s.calls[0]).toMatchObject({ file: mstsc.path, args: [file], stdin: false })
    // Mật khẩu không bao giờ vào log.
    expect(s.logs.join('\n')).not.toContain('s3cret')
    s.children[0]?.emit('exit', 0, null)
    await flush()
    expect(s.runs[1]?.args).toEqual(['/delete:TERMSRV/srv.example.com'])
    expect(s.removed).toContain(file)
    expect(s.events).toEqual([{ launchId, state: 'exited', code: 0, message: null }])
    expect(s.launcher.size).toBe(0)
  })

  it('mstsc: hai phiên cùng TERMSRV → chỉ xoá khi phiên cuối thoát; không có mật khẩu → không cmdkey', async () => {
    const s = setup({ platform: 'win32' })
    await s.launcher.launch({ client: mstsc, target, password: 'a' })
    await s.launcher.launch({ client: mstsc, target, password: 'a' })
    s.children[0]?.emit('exit', 0, null)
    await flush()
    expect(s.runs.filter((r) => r.args[0]?.startsWith('/delete'))).toHaveLength(0)
    s.children[1]?.emit('exit', 0, null)
    await flush()
    expect(s.runs.filter((r) => r.args[0]?.startsWith('/delete'))).toHaveLength(1)
    const t = setup({ platform: 'win32' })
    await t.launcher.launch({ client: mstsc, target, password: null })
    expect(t.runs).toHaveLength(0)
  })

  it('cmdkey lỗi → không chạy mstsc, dọn file', async () => {
    const s = setup({ platform: 'win32', cmdkeyCode: 1 })
    await expect(s.launcher.launch({ client: mstsc, target, password: 'a' })).rejects.toThrow(
      /cmdkey/
    )
    expect(s.calls).toHaveLength(0)
    expect(s.files.size).toBe(0)
  })

  it('xfreerdp: mật khẩu qua stdin (một dòng, đóng stdin); mã thoát → thông báo dễ hiểu', async () => {
    const s = setup()
    const { launchId } = await s.launcher.launch({ client: xfreerdp, target, password: 'pw' })
    expect(s.calls[0]?.stdin).toBe(true)
    expect(s.calls[0]?.args).toContain('/from-stdin')
    expect(s.calls[0]?.args.join(' ')).not.toContain('pw ')
    expect(s.children[0]?.stdinData).toBe('pw\n')
    expect(s.children[0]?.stdinEnded).toBe(true)
    s.children[0]?.emit('exit', 132, null)
    await flush()
    expect(s.events[0]).toMatchObject({ launchId, state: 'exited', code: 132 })
    expect(s.events[0]?.message).toMatch(/Sign-in failed/)
  })

  it('Disconnect: kill client, sự kiện exited không có lỗi', async () => {
    const s = setup()
    const { launchId } = await s.launcher.launch({ client: xfreerdp, target, password: null })
    await s.launcher.stop(launchId)
    await flush()
    expect(s.children[0]?.killed).toBe(true)
    expect(s.events).toEqual([{ launchId, state: 'exited', code: null, message: null }])
  })

  it('không chạy được client (ENOENT) → lỗi', async () => {
    const s = setup({ spawnError: new Error('spawn ENOENT') })
    await expect(s.launcher.launch({ client: xfreerdp, target, password: null })).rejects.toThrow(
      /ENOENT/
    )
    expect(s.launcher.size).toBe(0)
  })

  it('Remmina thoát ngay với mã 0 = giao cho phiên đang chạy → detached', async () => {
    const s = setup({ now: () => 1000 })
    const remmina: DetectedClient = { kind: 'remmina', name: 'Remmina', path: '/usr/bin/remmina' }
    const { launchId } = await s.launcher.launch({ client: remmina, target, password: 'ignored' })
    expect(s.calls[0]?.args[0]).toBe('-c')
    expect(String([...s.files.values()][0])).not.toContain('ignored')
    s.children[0]?.emit('exit', 0, null)
    await flush()
    expect(s.events[0]).toMatchObject({ launchId, state: 'detached' })
    await s.launcher.stop(launchId)
    expect(s.events[1]).toMatchObject({ launchId, state: 'exited' })
    expect(s.files.size).toBe(0)
  })

  it('macOS: open -a, không giữ tiến trình', async () => {
    const s = setup({ platform: 'darwin' })
    const app: DetectedClient = {
      kind: 'windows-app',
      name: 'Windows App',
      path: '/Applications/Windows App.app'
    }
    const pending = s.launcher.launch({ client: app, target, password: 'x' })
    await flush()
    s.children[0]?.emit('exit', 0, null)
    const result = await pending
    expect(result.tracked).toBe(false)
    expect(s.calls[0]).toMatchObject({ file: '/usr/bin/open' })
    expect(s.calls[0]?.args.slice(0, 2)).toEqual(['-a', app.path])
  })

  it('thoát app: kill, xoá file, cmdkey /delete đồng bộ', async () => {
    const s = setup({ platform: 'win32' })
    await s.launcher.launch({ client: mstsc, target, password: 'a' })
    s.launcher.disposeAll()
    expect(s.children[0]?.killed).toBe(true)
    expect(s.files.size).toBe(0)
    expect(s.syncRuns).toEqual([['/delete:TERMSRV/srv.example.com']])
  })

  it('mã thoát bình thường của FreeRDP không phải lỗi', () => {
    expect(freerdpExitMessage(0, '')).toBeNull()
    expect(freerdpExitMessage(11, '')).toBeNull()
    expect(freerdpExitMessage(131, '')).toMatch(/reach/)
    expect(freerdpExitMessage(200, 'line1\nERROR: boom\n')).toMatch(/200: ERROR: boom/)
  })
})
