import { beforeEach, describe, expect, it, vi } from 'vitest'

// electron-updater giả: checkForUpdates trả về promise do test điều khiển.
const updater = vi.hoisted(() => {
  const pending: { resolve: () => void; allowDowngrade: boolean }[] = []
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const fake = {
    httpExecutor: { cachedSession: null as unknown },
    logger: null as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    channel: 'latest',
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
      return fake
    },
    checkForUpdates: () =>
      new Promise<void>((resolve) => {
        pending.push({ resolve, allowDowngrade: fake.allowDowngrade })
      }),
    downloadUpdate: () => Promise.resolve(),
    quitAndInstall: () => undefined
  }
  // Session giả theo partition: ghi lại proxy + bộ kiểm tra chứng chỉ.
  const sessions = new Map<string, { proxy: unknown; verify: unknown }>()
  return { fake, pending, handlers, sessions }
})

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.2.0-beta.9' },
  session: {
    fromPartition: (name: string) => {
      const entry = { proxy: null as unknown, verify: null as unknown }
      updater.sessions.set(name, entry)
      return {
        name,
        setProxy: (config: unknown) => {
          entry.proxy = config
          return Promise.resolve()
        },
        setCertificateVerifyProc: (proc: unknown) => {
          entry.verify = proc
        }
      }
    }
  }
}))
vi.mock('electron-log/main', () => ({
  default: { scope: () => ({ warn: () => undefined }), warn: () => undefined }
}))
vi.mock('electron-updater', () => ({ autoUpdater: updater.fake }))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => true
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('Updater: beta → stable khi đang có lần kiểm tra định kỳ', () => {
  beforeEach(() => {
    updater.pending.length = 0
    Object.assign(process, { resourcesPath: '/res' })
  })

  it('lần kiểm tra đang chạy dở không xoá quyền hạ phiên bản; lần sau khi đổi kênh mới dùng nó', async () => {
    const { Updater } = await import('../../src/main/updater')
    const u = new Updater()
    u.setChannel('beta')
    // Lần kiểm tra định kỳ bắt đầu (kênh beta).
    const periodic = u.check()
    await flush()
    expect(updater.pending).toHaveLength(1)
    expect(updater.pending[0]?.allowDowngrade).toBe(false)

    // Người dùng chuyển về stable trong lúc nó còn chạy, rồi kiểm tra ngay.
    u.setChannel('stable')
    expect(updater.fake.allowDowngrade).toBe(true)
    const manual = u.check()
    await flush()
    // Lần thủ công nối đuôi, chưa gọi electron-updater.
    expect(updater.pending).toHaveLength(1)

    updater.pending[0]?.resolve()
    await periodic
    await flush()
    // Lần cũ xong KHÔNG xoá quyền → lần thủ công chạy với allowDowngrade.
    expect(updater.pending).toHaveLength(2)
    expect(updater.pending[1]?.allowDowngrade).toBe(true)

    updater.pending[1]?.resolve()
    await manual
    // Đã dùng xong → tắt.
    expect(updater.fake.allowDowngrade).toBe(false)
    const next = u.check()
    await flush()
    expect(updater.pending[2]?.allowDowngrade).toBe(false)
    updater.pending[2]?.resolve()
    await next
  })
})

describe('Updater: cài đặt mạng', () => {
  it('mỗi lần đổi dùng session mới (Chromium nhớ kết quả kiểm tra chứng chỉ); đăng nhập proxy từ URL', async () => {
    const { Updater } = await import('../../src/main/updater')
    const u = new Updater()
    const base = {
      proxyMode: 'manual' as const,
      proxyUrl: 'http://me%40corp:p%3Ass@10.0.0.1:8080',
      noProxy: 'localhost',
      updatesInsecure: false
    }
    u.setNetwork(base)
    const first = updater.fake.httpExecutor.cachedSession as { name: string }
    expect(updater.sessions.get(first.name)).toEqual({
      proxy: {
        mode: 'fixed_servers',
        proxyRules: 'http://10.0.0.1:8080',
        proxyBypassRules: 'localhost'
      },
      verify: null
    })
    // Cùng cài đặt → không tạo lại.
    u.setNetwork({ ...base })
    expect(updater.fake.httpExecutor.cachedSession).toBe(first)

    u.setNetwork({ ...base, updatesInsecure: true })
    const second = updater.fake.httpExecutor.cachedSession as { name: string }
    expect(second.name).not.toBe(first.name)
    const verify = updater.sessions.get(second.name)?.verify as (
      r: unknown,
      cb: (n: number) => void
    ) => void
    const result = vi.fn()
    verify({}, result)
    expect(result).toHaveBeenCalledWith(0)

    const login = updater.handlers.get('login')
    const proxyCb = vi.fn()
    login?.({ isProxy: true }, proxyCb)
    expect(proxyCb).toHaveBeenCalledWith('me@corp', 'p:ss')
    const serverCb = vi.fn()
    login?.({ isProxy: false }, serverCb)
    expect(serverCb).toHaveBeenCalledWith()

    u.setNetwork({ ...base, proxyMode: 'system' })
    const third = updater.fake.httpExecutor.cachedSession as { name: string }
    expect(updater.sessions.get(third.name)?.proxy).toEqual({ mode: 'system' })
    const noLogin = vi.fn()
    login?.({ isProxy: true }, noLogin)
    expect(noLogin).toHaveBeenCalledWith()
  })
})
