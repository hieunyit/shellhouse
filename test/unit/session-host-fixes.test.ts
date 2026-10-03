import { EventEmitter } from 'node:events'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Client } from 'ssh2'
import type { ForwardSpec } from '@shared/forwards'
import { createAuthHandler } from '../../src/session-host/ssh/auth'
import { StatsMonitor } from '../../src/session-host/ssh/stats-monitor'
import { ForwardManager } from '../../src/session-host/forward/manager'
import { SftpService } from '../../src/session-host/sftp/service'
import { downloadedMode } from '../../src/session-host/sftp/transfers'
import { programEnv } from '../../src/session-host/modules/local-programs'
import { isInside } from '../../src/session-host/session/session'
import { localPathAllowed } from '../../src/modules/registry/local-paths'
import type { ModuleManifest } from '../../src/modules/registry/types'
import { tempDir } from './helpers'

function fakeChannel() {
  const ch = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    closed: false,
    close() {
      ch.closed = true
    }
  })
  return ch
}

describe('StatsMonitor: start → stop → start nhanh', () => {
  it('kênh của lượt cũ bị đóng, không đè kênh / trạng thái của lượt mới', () => {
    const callbacks: ((e: Error | undefined, ch: unknown) => void)[] = []
    const client = {
      exec: (_cmd: string, cb: (e: Error | undefined, ch: unknown) => void) => callbacks.push(cb)
    } as unknown as Client
    const monitor = new StatsMonitor(client, () => undefined)
    monitor.start()
    monitor.stop()
    monitor.start()
    const first = fakeChannel()
    const second = fakeChannel()
    callbacks[0]?.(undefined, first)
    callbacks[1]?.(undefined, second)
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    // 'close' muộn của kênh cũ không được dừng lượt mới.
    first.emit('close')
    expect(monitor.running).toBe(true)
    monitor.stop()
    expect(second.closed).toBe(true)
  })
})

describe('keyboard-interactive: bấm Huỷ', () => {
  it('dừng hẳn — không hỏi lại, không gửi thêm lần đăng nhập sai', async () => {
    const prompt = vi.fn(() => Promise.resolve({ ok: false, answers: [] }))
    const handler = createAuthHandler({
      username: 'u',
      host: 'h',
      agent: null,
      keyFiles: [],
      ctx: { prompt, log: () => undefined }
    })
    const methods: unknown[] = []
    const next = (m: unknown): void => {
      methods.push(m)
    }
    const call = (authsLeft: string[] | null): void => {
      ;(handler as unknown as (a: string[] | null, p: boolean, n: (m: unknown) => void) => void)(
        authsLeft,
        false,
        next
      )
    }
    call(null) // none
    call(['keyboard-interactive', 'password'])
    await vi.waitFor(() => {
      expect(methods).toHaveLength(2)
    })
    const kbd = methods[1] as {
      prompt: (
        n: string,
        i: string,
        l: string,
        p: { prompt: string }[],
        f: (a: string[]) => void
      ) => void
    }
    const finish = vi.fn()
    kbd.prompt('', '', '', [{ prompt: 'OTP' }], finish)
    await vi.waitFor(() => {
      expect(finish).toHaveBeenCalledWith([''])
    })
    // Server từ chối → ssh2 hỏi tiếp: phải dừng (false), không thử kbd / password lần nữa.
    call(['keyboard-interactive', 'password'])
    await vi.waitFor(() => {
      expect(methods).toHaveLength(3)
    })
    expect(methods[2]).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})

function fakeForwardClient() {
  const remote: ((e: Error | undefined, port: number) => void)[] = []
  const client = Object.assign(new EventEmitter(), {
    unforwardIn: vi.fn(),
    forwardIn: (_a: string, _p: number, cb: (e: Error | undefined, port: number) => void) =>
      remote.push(cb)
  })
  return { client, remote }
}

const spec = (over: Partial<ForwardSpec>): ForwardSpec => ({
  id: 'f1',
  kind: 'L',
  bindAddr: '127.0.0.1',
  bindPort: 0,
  destHost: '127.0.0.1',
  destPort: 1,
  ...over
})

describe('ForwardManager: dừng trong lúc đang mở', () => {
  it('-R: server mở cổng sau khi đã dừng → huỷ cổng, giữ trạng thái stopped', async () => {
    const { client, remote } = fakeForwardClient()
    const manager = new ForwardManager(client as unknown as Client, () => undefined)
    const started = manager.start(spec({ kind: 'R', bindPort: 8080 }))
    manager.stop('f1')
    remote[0]?.(undefined, 8080)
    await started
    expect(client.unforwardIn).toHaveBeenCalledWith('127.0.0.1', 8080)
    expect(manager.list()[0]?.state).toBe('stopped')
    manager.dispose()
  })

  it('-L: listen xong sau khi đã dừng (tra DNS) → cổng được đóng, không rò', async () => {
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((r) =>
      probe.close(() => {
        r()
      })
    )

    const { client } = fakeForwardClient()
    const manager = new ForwardManager(client as unknown as Client, () => undefined)
    const started = manager.start(spec({ bindAddr: 'localhost', bindPort: port }))
    manager.remove('f1')
    await started
    manager.dispose()
    // Cổng phải trống lại.
    await new Promise((r) => setTimeout(r, 20))
    const again = createServer()
    await new Promise<void>((resolve, reject) => {
      again.once('error', reject)
      again.listen(port, '127.0.0.1', resolve)
    })
    await new Promise<void>((r) =>
      again.close(() => {
        r()
      })
    )
    expect(manager.list()).toEqual([])
  })
})

describe('SftpService.rename(overwrite)', () => {
  function fake(options: { extension: 'ok' | 'unsupported' | 'denied'; failRename?: string }) {
    const files = new Map<string, string>([
      ['/a.part', 'new'],
      ['/a', 'old']
    ])
    const err = (code: number, message: string) => Object.assign(new Error(message), { code })
    const sftp = {
      ext_openssh_rename: (from: string, to: string, cb: (e?: Error) => void) => {
        if (options.extension === 'unsupported')
          throw new Error('Server does not support this extended request')
        if (options.extension === 'denied') {
          cb(err(3, 'Permission denied'))
          return
        }
        files.set(to, files.get(from) ?? '')
        files.delete(from)
        cb()
      },
      rename: (from: string, to: string, cb: (e?: Error) => void) => {
        if (from === options.failRename || files.has(to) || !files.has(from)) {
          cb(err(4, 'Failure'))
          return
        }
        files.set(to, files.get(from) ?? '')
        files.delete(from)
        cb()
      },
      unlink: (p: string, cb: (e?: Error) => void) => {
        files.delete(p)
        cb()
      },
      once: () => undefined
    }
    const client = Object.assign(new EventEmitter(), {
      sftp: (cb: (e: Error | undefined, s: unknown) => void) => {
        cb(undefined, sftp)
      }
    })
    return { service: new SftpService(client as unknown as Client), files }
  }

  it('lỗi thật của posix-rename (không có quyền) → báo lỗi, KHÔNG xoá file đích', async () => {
    const { service, files } = fake({ extension: 'denied' })
    await expect(service.rename('/a.part', '/a', true)).rejects.toThrow('Permission denied')
    expect(files.get('/a')).toBe('old')
  })

  it('server không có extension → thay an toàn (dời bản cũ, đổi tên, xoá bản cũ)', async () => {
    const { service, files } = fake({ extension: 'unsupported' })
    await service.rename('/a.part', '/a', true)
    expect([...files.entries()]).toEqual([['/a', 'new']])
  })

  it('không có extension và đổi tên hỏng → trả bản cũ về chỗ', async () => {
    const { service, files } = fake({ extension: 'unsupported', failRename: '/a.part' })
    await expect(service.rename('/a.part', '/a', true)).rejects.toThrow()
    expect(files.get('/a')).toBe('old')
    expect(files.get('/a.part')).toBe('new')
    expect(files.size).toBe(2)
  })
})

describe('SftpService: guarded / đếm hard link', () => {
  function service(sftp: Record<string, unknown>) {
    const client = Object.assign(new EventEmitter(), {
      sftp: (cb: (e: Error | undefined, s: unknown) => void) => {
        cb(undefined, { once: () => undefined, ...sftp })
      }
    })
    return new SftpService(client as unknown as Client)
  }
  const listeners = (svc: SftpService): number =>
    (svc as unknown as { lossListeners: Set<unknown> }).lossListeners.size

  it('ssh2 ném đồng bộ → reject và gỡ listener (không rò mỗi lần đổi tên)', async () => {
    const files = new Set(['/a.part', '/a'])
    const svc = service({
      ext_openssh_rename: () => {
        throw new Error('Server does not support this extended request')
      },
      rename: (from: string, to: string, cb: (e?: Error) => void) => {
        files.delete(from)
        files.add(to)
        cb()
      },
      unlink: (p: string, cb: (e?: Error) => void) => {
        files.delete(p)
        cb()
      }
    })
    for (let i = 0; i < 3; i++) await svc.rename('/a.part', '/a', true)
    expect(listeners(svc)).toBe(0)
    await expect(
      svc.guarded(() => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(listeners(svc)).toBe(0)
  })

  function dirService(names: string[], longname: (n: string) => string) {
    let reads = 0
    let pos = 0
    let closed = false
    const eof = Object.assign(new Error('EOF'), { code: 1 })
    const svc = service({
      opendir: (_p: string, cb: (e: Error | undefined, h: Buffer) => void) => {
        pos = 0
        closed = false
        cb(undefined, Buffer.from('h'))
      },
      readdir: (_h: Buffer, cb: (e: Error | undefined, l?: unknown[]) => void) => {
        const batch = names.slice(pos, pos + 100)
        pos += 100
        reads++
        if (!batch.length) cb(eof)
        else
          cb(
            undefined,
            batch.map((filename) => ({ filename, longname: longname(filename) }))
          )
      },
      close: (_h: Buffer, cb: (e?: Error) => void) => {
        closed = true
        cb()
      }
    })
    const count = async (name: string): Promise<number | null> =>
      (
        svc as unknown as {
          linkCount(s: unknown, dir: string, name: string): Promise<number | null>
        }
      ).linkCount(await svc.channel(), '/d/', name)
    return { count, reads: () => reads, closed: () => closed }
  }

  it('dừng đọc sớm khi thấy file; thư mục khổng lồ / longname lạ → không biết (null)', async () => {
    const names = Array.from({ length: 5000 }, (_, i) => `f${i}`)
    const ls = (n: string): string => `-rw-r--r--    ${n === 'f3' ? 2 : 1} u g 1 Jan 1 00:00 ${n}`
    const a = dirService(names, ls)
    expect(await a.count('f3')).toBe(2)
    expect(a.closed()).toBe(true)
    const before = a.reads()
    expect(await a.count('f150')).toBe(1)
    expect(a.reads() - before).toBe(2)
    // Ở sau mục thứ 2000 → bỏ cuộc, không đọc hết 5000.
    const far = a.reads()
    expect(await a.count('f4900')).toBe(null)
    expect(a.reads() - far).toBeLessThanOrEqual(21)
    expect(await a.count('missing')).toBe(null)
    // Server không trả longname kiểu ls -l (vd. Windows) → null.
    expect(await dirService(['x'], (n) => n).count('x')).toBe(null)
  })
})

describe('Vá nhỏ', () => {
  it('quyền file tải về: không bao giờ cho người khác ghi, giữ 0600 / bit chạy', () => {
    expect(downloadedMode(0o100600)).toBe(0o600)
    expect(downloadedMode(0o100644)).toBe(0o644)
    expect(downloadedMode(0o100777)).toBe(0o755)
    expect(downloadedMode(0o100640)).toBe(0o640)
    expect(downloadedMode(0o100400)).toBe(0o600)
  })

  it('env cho chương trình của module: bỏ biến của app và biến chèn code', () => {
    const env = programEnv(
      {
        LD_PRELOAD: '/tmp/x.so',
        DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
        node_options: '--require /tmp/x.js',
        PYTHONSTARTUP: '/tmp/x.py',
        BASH_ENV: '/tmp/x.sh',
        BROWSER: 'firefox',
        AWS_PROFILE: 'dev'
      },
      { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', HOME: '/h' }
    )
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', BROWSER: 'firefox', AWS_PROFILE: 'dev' })
  })

  it('op edit chỉ nhận đường dẫn trong thư mục tạm', () => {
    const root = join(tempDir(), 'remote-edit')
    expect(isInside(root, join(root, 'abc', 'f.txt'))).toBe(true)
    expect(isInside(root, root)).toBe(false)
    expect(isInside(root, join(root, '..', 'x'))).toBe(false)
    expect(isInside(root, 'relative/f.txt')).toBe(false)
    expect(isInside(root, join(root + '-evil', 'f'))).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('localPathAllowed: symlink', () => {
  const manifest = {
    permissions: [{ kind: 'read-file', path: '~/.kube/**' }]
  } as unknown as ModuleManifest

  it('symlink trong thư mục được phép trỏ ra ngoài → từ chối; file thật → cho phép', () => {
    const home = tempDir()
    mkdirSync(join(home, '.kube'))
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret')
    writeFileSync(join(home, '.kube', 'config'), 'ok')
    symlinkSync(join(home, '.ssh', 'id_rsa'), join(home, '.kube', 'link'))
    symlinkSync(join(home, '.ssh'), join(home, '.kube', 'dir-link'))
    const ctx = { home, env: {}, platform: process.platform }
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/config', ctx)).toBe(true)
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/link', ctx)).toBe(false)
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/dir-link/id_rsa', ctx)).toBe(false)
    // File chưa có trong thư mục link ra ngoài (ghi file mới) cũng bị nhận ra.
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/dir-link/new', ctx)).toBe(false)
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/new-file', ctx)).toBe(true)
  })

  it('symlink trỏ ra ngoài vùng bí mật (stow, home-manager/nix, WSL, Rancher Desktop) → cho phép', () => {
    const home = tempDir()
    const dotfiles = tempDir()
    mkdirSync(join(home, '.kube'))
    writeFileSync(join(dotfiles, 'kubeconfig'), 'ok')
    // stow / chezmoi: ~/.kube/config → ~/dotfiles/kube/config (ngoài ~/.kube).
    symlinkSync(join(dotfiles, 'kubeconfig'), join(home, '.kube', 'config'))
    // ~/.kube là symlink cả thư mục (dotfiles quản lý cả thư mục).
    symlinkSync(dotfiles, join(home, '.kube-dir'))
    const ctx = { home, env: {}, platform: process.platform }
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/config', ctx)).toBe(true)
    const dirManifest = {
      permissions: [{ kind: 'read-file', path: '~/.kube-dir/**' }]
    } as unknown as ModuleManifest
    expect(localPathAllowed(dirManifest, 'read-file', '~/.kube-dir/kubeconfig', ctx)).toBe(true)

    // Giả lập đường dẫn: nix store, WSL /mnt/c, Rancher Desktop socket.
    const links: Record<string, string> = {
      '/home/me/.kube/config': '/nix/store/abc-home-manager-files/.kube/config',
      '/home/me/.kube/wsl': '/mnt/c/Users/me/.kube/config',
      '/home/me/.kube/wsl-key': '/mnt/c/Users/me/.ssh/id_rsa',
      '/home/me/.kube/aws': '/home/me/.aws/credentials',
      '/var/run/docker.sock': '/home/me/.rd/docker.sock',
      '/home/me/.kube/shadow': '/etc/shadow'
    }
    const fake = {
      home: '/home/me',
      env: {},
      platform: 'linux' as const,
      realpath: (p: string) => links[p] ?? p
    }
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/config', fake)).toBe(true)
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/wsl', fake)).toBe(true)
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/wsl-key', fake)).toBe(false)
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/aws', fake)).toBe(false)
    expect(localPathAllowed(manifest, 'read-file', '~/.kube/shadow', fake)).toBe(false)
    const sock = {
      permissions: [{ kind: 'local-socket', path: '/var/run/docker.sock' }]
    } as unknown as ModuleManifest
    expect(localPathAllowed(sock, 'local-socket', '/var/run/docker.sock', fake)).toBe(true)
  })

  it('Windows: mẫu không có /** vẫn khớp dù dấu phân cách khác', () => {
    const m = {
      permissions: [{ kind: 'local-socket', path: '~/.docker/run/docker.sock' }]
    } as unknown as ModuleManifest
    const ctx = {
      home: 'C:\\Users\\me',
      env: {},
      platform: 'win32' as const,
      realpath: (p: string) => p
    }
    expect(localPathAllowed(m, 'local-socket', '~/.docker/run/docker.sock', ctx)).toBe(true)
    expect(
      localPathAllowed(m, 'local-socket', 'c:\\users\\me\\.docker\\run\\docker.sock', ctx)
    ).toBe(true)
    expect(localPathAllowed(m, 'local-socket', '~/.docker/run/other.sock', ctx)).toBe(false)
  })
})

describe('Client SSH không bao giờ thiếu listener "error"', () => {
  it('sau "ready", lỗi ssh2 trước khi SshShell gắn listener không thành uncaughtException', async () => {
    const { startTestSshServer } = await import('../integration/ssh-test-server')
    const { openSshShell } = await import('../../src/session-host/ssh/connect')
    const server = await startTestSshServer([{ username: 'u', password: 'p' }])
    const logs: string[] = []
    try {
      const shell = await openSshShell({
        destination: {
          target: { host: '127.0.0.1', port: server.port, username: 'u' },
          knownKeyTypes: [],
          credentials: { password: 'p' }
        },
        shell: false,
        cols: 80,
        rows: 24,
        agent: null,
        keyFiles: [],
        callbacks: { onData: () => undefined, onExit: () => undefined },
        ctx: {
          status: () => undefined,
          log: (_level, message) => logs.push(message),
          prompt: () => Promise.resolve({ ok: false, answers: [] }),
          verifyHostKey: () => Promise.resolve(true)
        }
      })
      // Listener của connectHop vẫn còn (ngoài listener của SshShell).
      expect(shell.client.listenerCount('error')).toBeGreaterThanOrEqual(2)
      shell.client.emit('error', new Error('boom'))
      expect(logs.some((m) => m.includes('boom'))).toBe(true)
      shell.close()
    } finally {
      await server.close()
    }
  })
})

describe('SessionLog: đĩa chậm', () => {
  it('không dồn quá trần trong bộ nhớ; ghi dòng đánh dấu phần bị bỏ', async () => {
    const { SessionLog, MAX_PENDING_LOG_BYTES } =
      await import('../../src/session-host/session/session-log')
    const { readFileSync } = await import('node:fs')
    const path = join(tempDir(), 'logs', 's.log')
    const log = new SessionLog({ path, stripAnsi: false, header: 'H' }, () => undefined)
    const chunk = new Uint8Array(1024 * 1024).fill(0x61)
    // Ghi đồng bộ liền một mạch: stream chưa kịp xả xuống đĩa.
    for (let i = 0; i < 20; i++) log.write(chunk)
    const stream = (log as unknown as { stream: { writableLength: number } }).stream
    expect(stream.writableLength).toBeLessThanOrEqual(MAX_PENDING_LOG_BYTES + chunk.length * 2)
    await new Promise((r) => setTimeout(r, 200))
    log.write(new TextEncoder().encode('tail'))
    log.close('F')
    await new Promise((r) => setTimeout(r, 200))
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('bytes not logged')
    expect(text.endsWith('tail\nF\n')).toBe(true)
  })
})
